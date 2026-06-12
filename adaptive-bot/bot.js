// AdaptiveBot — execução determinística + aprendizado via Gemini.
// Rodar: node adaptive-bot/bot.js  (paper por padrão; ADAPTIVE_PAPER=false p/ real)
import { config as dotenvConfig } from "dotenv";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import * as store from "./lib/store.js";
import { createSignalFn } from "./lib/signal.js";
import { computeFeatures } from "./lib/features.js";
import { runReview, maybeRollback, REVIEW_EVERY_N_TRADES, REVIEW_MAX_INTERVAL_H } from "./lib/learner.js";

dotenvConfig({ path: join(dirname(fileURLToPath(import.meta.url)), "..", ".env") });

const CFG = {
  symbol: process.env.ADAPTIVE_SYMBOL || "BTCUSDT",
  interval: "5m",
  cycleMs: 5 * 60 * 1000,
  paper: process.env.ADAPTIVE_PAPER !== "false",
  tradeUsd: parseFloat(process.env.ADAPTIVE_TRADE_USD || "20"),
  maxDailyLossPct: parseFloat(process.env.ADAPTIVE_MAX_DAILY_LOSS_PCT || "3"),
  maxTradesPerDay: parseInt(process.env.ADAPTIVE_MAX_TRADES_PER_DAY || "12"),
};

let tradesSinceReview = 0;
let cooldownUntil = 0;

async function getCandles(limit = 700) {
  const url = `https://api.binance.com/api/v3/klines?symbol=${CFG.symbol}&interval=${CFG.interval}&limit=${Math.min(limit, 1000)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Binance klines HTTP ${res.status}`);
  const rows = await res.json();
  return rows.map((r) => ({ time: r[0], open: +r[1], high: +r[2], low: +r[3], close: +r[4], volume: +r[5] }));
}

async function dailyGuardrails() {
  const since = new Date(); since.setUTCHours(0, 0, 0, 0);
  const todays = await store.getClosedTradesSince(since.toISOString(), 200);
  const pnlPct = todays.reduce((a, t) => a + (t.return_pct ?? 0), 0);
  if (pnlPct <= -CFG.maxDailyLossPct) return { ok: false, why: `kill-switch: PnL diário ${pnlPct.toFixed(2)}%` };
  const opens = (await store.getOpenTrades()).length;
  if (todays.length + opens >= CFG.maxTradesPerDay) return { ok: false, why: "máx trades/dia atingido" };
  return { ok: true };
}

async function manageOpenTrades(candles) {
  const last = candles[candles.length - 1];
  for (const t of await store.getOpenTrades()) {
    const { stop, tp } = t.data;
    let result = null, exitPrice = null;
    if (last.low <= stop) { result = "loss"; exitPrice = stop; }
    else if (last.high >= tp) { result = "win"; exitPrice = tp; }
    else if (Date.now() - new Date(t.opened_at).getTime() > 4 * 3600 * 1000) { result = "timeout"; exitPrice = last.close; }
    if (!result) continue;
    const returnPct = ((exitPrice - t.data.entry) / t.data.entry) * 100;
    // No modo real, aqui entraria a ordem de venda na Binance (fora de escopo
    // até o paper trading provar a estratégia — ver README).
    await store.closeTrade(t.id, { result, returnPct, closedAt: new Date().toISOString(), exitData: { exitPrice } });
    tradesSinceReview++;
    const activeParams = (await store.getActiveParams()).params;
    cooldownUntil = Date.now() + (activeParams.cooldown_min || 15) * 60 * 1000;
    console.log(`  ✦ trade #${t.id} fechado: ${result} ${returnPct.toFixed(2)}%`);
  }
}

async function maybeOpenTrade(candles) {
  if (Date.now() < cooldownUntil) return;
  if ((await store.getOpenTrades()).length > 0) return; // 1 posição por vez
  const guard = await dailyGuardrails();
  if (!guard.ok) { console.log(`  ⏸ ${guard.why}`); return; }

  const { version, params } = await store.getActiveParams();
  const sig = createSignalFn(params)(candles);
  if (!sig) return;

  const entry = candles[candles.length - 1].close;
  const features = computeFeatures(candles);
  // No modo real, aqui entraria a ordem de compra na Binance.
  const id = await store.openTrade({
    symbol: CFG.symbol,
    paramsVersion: version,
    openedAt: new Date().toISOString(),
    data: { entry, stop: sig.stop, tp: sig.tp, usd: CFG.tradeUsd, paper: CFG.paper, features },
  });
  console.log(`  ▶ abriu trade #${id} v${version} @ ${entry} (paper=${CFG.paper})`);
}

async function maybeRunReview(candles) {
  const lastReview = await store.getLastReviewAt();
  const hoursSince = lastReview ? (Date.now() - new Date(lastReview).getTime()) / 3600000 : Infinity;
  if (tradesSinceReview < REVIEW_EVERY_N_TRADES && hoursSince < REVIEW_MAX_INTERVAL_H) return;
  console.log("  🧠 rodando revisão com Gemini…");
  const out = await runReview({ candles });
  tradesSinceReview = 0;
  console.log(out.applied ? `  ✅ nova versão v${out.newVersion}: ${out.analysis ?? ""}` : `  ➖ sem mudança: ${out.reason}`);
}

async function cycle() {
  const candles = await getCandles();
  await manageOpenTrades(candles);
  await maybeOpenTrade(candles);
  await maybeRollback();
  await maybeRunReview(candles);
}

async function main() {
  if (!process.env.DATABASE_URL) { console.error("DATABASE_URL ausente"); process.exit(1); }
  await store.init();
  const { version, params } = await store.getActiveParams();
  console.log(`AdaptiveBot ${CFG.symbol} — paper=${CFG.paper} — params v${version} (${params.strategy})`);
  for (;;) {
    try { await cycle(); } catch (e) { console.error(`ciclo falhou: ${e.message}`); }
    await new Promise((r) => setTimeout(r, CFG.cycleMs));
  }
}

main();
