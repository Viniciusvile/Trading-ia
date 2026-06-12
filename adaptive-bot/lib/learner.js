// Ciclo de aprendizado: Gemini analisa os trades e propõe parâmetros;
// o walk-forward decide. O LLM nunca tem a palavra final.
import { simulateTrades, computeStats } from "../../masterbot/lib/backtest-engine.js";
import { PARAM_BOUNDS, STRATEGIES, validateProposal, clampParams } from "./params.js";
import { createSignalFn } from "./signal.js";
import { askGeminiJson } from "./gemini.js";
import * as store from "./store.js";

export const REVIEW_EVERY_N_TRADES = 10;
export const REVIEW_MAX_INTERVAL_H = 24;
export const ROLLBACK_AFTER_N = 10;        // trades ao vivo p/ avaliar versão nova
export const ROLLBACK_WINRATE_DROP = 0.15; // reverte se winrate cair 15pp vs anterior

export function buildReviewPrompt({ currentParams, trades, lessons }) {
  const wins = trades.filter((t) => t.result === "win").length;
  const tradeLines = trades.slice(0, 40).map((t) =>
    JSON.stringify({ result: t.result, return_pct: t.return_pct, version: Number(t.params_version), features: t.data?.features ?? null })
  );
  return [
    "Você é um analista quantitativo revisando um bot de scalping spot long-only de criptomoedas (candles 5m).",
    "Sua tarefa: analisar os trades recentes, identificar padrões nos PERDEDORES (correlação com as features de contexto), e propor ajustes de parâmetros.",
    "",
    `PARÂMETROS ATUAIS: ${JSON.stringify(currentParams)}`,
    `LIMITES (min/max — propostas fora disso serão cortadas): ${JSON.stringify(PARAM_BOUNDS)}`,
    `ESTRATÉGIAS DISPONÍVEIS: ${JSON.stringify(STRATEGIES)}`,
    "",
    `LIÇÕES JÁ APRENDIDAS (não repita, construa em cima): ${lessons.map((l) => l.lesson).join(" | ") || "nenhuma"}`,
    "",
    `TRADES RECENTES (${trades.length} no total, ${wins} wins) — features = contexto na entrada:`,
    ...tradeLines,
    "",
    "Responda APENAS com JSON neste formato exato:",
    '{"analysis": "diagnóstico curto em pt-BR", "lessons": ["lição nova e acionável", "..."], "proposed_params": {"sl_pct": 0.006, ...somente chaves que quer mudar...}}',
    "Regras: máx 3 lessons; mude no máximo 4 parâmetros por revisão; mudanças pequenas e justificadas pela análise; se os dados forem insuficientes, proposed_params pode ser {}.",
  ].join("\n");
}

/** Score escalar para comparar resultados de backtest. Penaliza amostras pequenas. */
export function scoreStats(stats) {
  if (!stats || !stats.totalTrades) return -Infinity;
  const pf = Math.min(stats.profitFactor ?? 0, 5); // cap p/ não premiar outlier
  const sampleWeight = Math.min(stats.totalTrades / 10, 1); // <10 trades vale proporcionalmente menos
  return (pf * 10 + (stats.netProfitPct ?? 0)) * sampleWeight;
}

/** Backtest walk-forward: proposta só passa se score >= atual (com margem mínima). */
export function evaluateProposal({ candles, currentParams, proposedParams }) {
  const opts = { warmup: 100, maxHold: 48, feePctPerSide: 0.1 };
  const curTrades = simulateTrades(candles, createSignalFn(currentParams), opts);
  const propTrades = simulateTrades(candles, createSignalFn(proposedParams), opts);
  const currentScore = scoreStats(computeStats(curTrades));
  const proposedScore = scoreStats(computeStats(propTrades));
  if (propTrades.length < 3) {
    return { apply: false, reason: `amostra insuficiente no walk-forward (${propTrades.length} trades)`, currentScore, proposedScore };
  }
  if (proposedScore < currentScore) {
    return { apply: false, reason: `proposta pontua pior no walk-forward (${proposedScore.toFixed(2)} < ${currentScore.toFixed(2)})`, currentScore, proposedScore };
  }
  return { apply: true, reason: `walk-forward ok (${proposedScore.toFixed(2)} >= ${currentScore.toFixed(2)})`, currentScore, proposedScore };
}

/** Verifica se a versão ativa deve ser revertida (winrate ao vivo desabou). */
export async function maybeRollback() {
  const active = await store.getActiveParams();
  const stats = await store.countClosedSinceVersion(active.version);
  if (stats.n < ROLLBACK_AFTER_N) return null;
  const prevVersion = active.version - 1;
  const prevParams = await store.getParamsByVersion(prevVersion);
  if (!prevParams) return null;
  const prevStats = await store.countClosedSinceVersion(prevVersion);
  if (prevStats.n >= 5 && (prevStats.winrate ?? 0) - (stats.winrate ?? 0) > ROLLBACK_WINRATE_DROP) {
    const v = await store.saveParamsVersion(prevParams, "rollback");
    await store.logReview({
      tradesAnalyzed: stats.n, response: null, applied: true,
      reason: `rollback: winrate v${active.version}=${(stats.winrate * 100).toFixed(0)}% << v${prevVersion}=${(prevStats.winrate * 100).toFixed(0)}%`,
      oldVersion: active.version, newVersion: v,
    });
    return v;
  }
  return null;
}

/**
 * Roda uma revisão completa. `candles` = histórico recente (>= 600 candles 5m)
 * para o walk-forward. Retorna resumo do que aconteceu.
 */
export async function runReview({ candles, fetchFn } = {}) {
  const active = await store.getActiveParams();
  const since = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  const trades = await store.getClosedTradesSince(since, 60);
  if (trades.length < 5) {
    return { applied: false, reason: `poucos trades fechados (${trades.length} < 5)` };
  }
  const lessons = await store.getActiveLessons();
  const prompt = buildReviewPrompt({ currentParams: active.params, trades, lessons });

  let response;
  try {
    response = await askGeminiJson(prompt, fetchFn ? { fetchFn } : {});
  } catch (e) {
    await store.logReview({ tradesAnalyzed: trades.length, response: { error: e.message }, applied: false, reason: `erro Gemini: ${e.message}`, oldVersion: active.version, newVersion: null });
    return { applied: false, reason: e.message };
  }

  if (Array.isArray(response.lessons) && response.lessons.length) {
    await store.addLessons(response.lessons.slice(0, 3));
  }

  const raw = response.proposed_params || {};
  if (Object.keys(raw).length === 0) {
    await store.logReview({ tradesAnalyzed: trades.length, response, applied: false, reason: "Gemini não propôs mudanças", oldVersion: active.version, newVersion: null });
    return { applied: false, reason: "sem proposta" };
  }

  let merged;
  try {
    validateProposal(raw);
    merged = clampParams({ ...active.params, ...raw }, active.params).params;
  } catch (e) {
    await store.logReview({ tradesAnalyzed: trades.length, response, applied: false, reason: `proposta inválida: ${e.message}`, oldVersion: active.version, newVersion: null });
    return { applied: false, reason: e.message };
  }

  const gate = evaluateProposal({ candles, currentParams: active.params, proposedParams: merged });
  if (!gate.apply) {
    await store.logReview({ tradesAnalyzed: trades.length, response, applied: false, reason: gate.reason, oldVersion: active.version, newVersion: null });
    return { applied: false, reason: gate.reason };
  }

  const newVersion = await store.saveParamsVersion(merged, "gemini");
  await store.logReview({ tradesAnalyzed: trades.length, response, applied: true, reason: gate.reason, oldVersion: active.version, newVersion });
  return { applied: true, newVersion, params: merged, analysis: response.analysis };
}
