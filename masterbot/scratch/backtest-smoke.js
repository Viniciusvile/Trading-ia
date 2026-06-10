/**
 * backtest-smoke.js — Smoke test do fluxo completo de backtest.
 * Busca candles reais da Binance e roda warrior + range-v2 em BTCUSDT 1H.
 * Uso: node scratch/backtest-smoke.js
 */
import { config as dotenvConfig } from "dotenv";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
const __dir = dirname(fileURLToPath(import.meta.url));
dotenvConfig({ path: join(__dir, "..", "..", ".env") });

import { fetchCandles } from "../bot.js";
import { simulateTrades, computeStats } from "../lib/backtest-engine.js";
import { createSignalFn } from "../lib/strategy-signals.js";

const PLANS = [
  {
    name: "smoke_warrior",
    strategy: "warrior",
    sl: { type: "atr", multiplier: 1.5 },
    tp: { type: "atr", multiplier: 2.0 },
    filters: { ema_triple: true, adx_min: 20, volume_mult: 1.3 },
  },
  {
    name: "smoke_range",
    strategy: "range-v2",
    sl: { type: "atr", multiplier: 1.5 },
    tp: { type: "boundary", multiplier: 1.0 },
    filters: { adx_max: 28, choppiness_min: 45 },
  },
];

const candles = await fetchCandles("BTCUSDT", "1H", 1000, false);
console.log(`Candles: ${candles.length} (${new Date(candles[0].time).toISOString()} → ${new Date(candles.at(-1).time).toISOString()})`);

for (const plan of PLANS) {
  const trades = simulateTrades(candles, createSignalFn(plan));
  const s = computeStats(trades);
  console.log(`\n── ${plan.name} ──`);
  if (!s) { console.log("  Nenhum trade no período."); continue; }
  console.log(`  Trades: ${s.totalTrades} | WR: ${(s.winRate * 100).toFixed(1)}% | PF: ${s.profitFactor.toFixed(2)} | PnL: ${s.netProfitPct.toFixed(2)}% ($${s.netProfitUsd.toFixed(2)} em $10k) | MaxDD: ${s.maxDrawdownPct.toFixed(2)}%`);
}
