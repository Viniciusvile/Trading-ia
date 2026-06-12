import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReviewPrompt, evaluateProposal, scoreStats } from "./learner.js";
import { DEFAULT_PARAMS } from "./params.js";

const sampleTrades = [
  { result: "loss", return_pct: -0.6, params_version: 1, data: { features: { rsi14: 55, atr_pct: 0.001 } } },
  { result: "win", return_pct: 1.0, params_version: 1, data: { features: { rsi14: 25, atr_pct: 0.004 } } },
];

test("buildReviewPrompt inclui bounds, params atuais, trades e lições", () => {
  const p = buildReviewPrompt({
    currentParams: DEFAULT_PARAMS,
    trades: sampleTrades,
    lessons: [{ lesson: "evitar RSI > 50" }],
  });
  assert.match(p, /sl_pct/);
  assert.match(p, /evitar RSI > 50/);
  assert.match(p, /"rsi14":\s*55|rsi14.*55/s);
  assert.match(p, /proposed_params/); // instrui o formato de saída
});

test("scoreStats prioriza profit factor e penaliza poucas amostras", () => {
  // campos reais de computeStats: totalTrades, winRate (0-1), profitFactor, netProfitPct
  const bom = scoreStats({ totalTrades: 30, winRate: 0.6, profitFactor: 1.8, netProfitPct: 12 });
  const ruim = scoreStats({ totalTrades: 30, winRate: 0.4, profitFactor: 0.7, netProfitPct: -5 });
  const poucos = scoreStats({ totalTrades: 2, winRate: 1, profitFactor: 99, netProfitPct: 3 });
  assert.ok(bom > ruim);
  assert.ok(bom > poucos, "2 trades não pode vencer 30 trades consistentes");
});

test("scoreStats sem trades → -Infinity", () => {
  assert.equal(scoreStats(null), -Infinity);
  assert.equal(scoreStats({ totalTrades: 0 }), -Infinity);
});

test("evaluateProposal compara backtests e rejeita proposta pior", () => {
  // Tendência de alta (+0.3%/candle) com dips de 0.8% a cada 40 candles —
  // padrão que o micro-dip captura (mesma construção do signal.test.js).
  const candles = [];
  let price = 100;
  for (let i = 0; i < 600; i++) {
    const dip = i % 40 === 39;
    const close = dip ? price * 0.992 : price * 1.003;
    candles.push({
      time: 1700000000000 + i * 300000,
      open: price,
      high: Math.max(price, close) + 0.2,
      low: Math.min(price, close) - 0.2,
      close,
      volume: dip ? 3000 : 1000,
    });
    price = close;
  }
  const current = { ...DEFAULT_PARAMS, trend_ema_period: 0, min_rsi: 0, max_rsi: 100, min_dip_pct: 0.005 };
  // tp curtíssimo (mal cobre as taxas) e SL mais largo → pontuação pior
  const worse = { ...current, sl_pct: 0.0075, tp_pct: 0.004 };
  const out = evaluateProposal({ candles, currentParams: current, proposedParams: worse });
  assert.equal(typeof out.apply, "boolean");
  assert.ok(out.currentScore != null && out.proposedScore != null);
  if (!out.apply) assert.match(out.reason, /pior|insuficiente/i);
});
