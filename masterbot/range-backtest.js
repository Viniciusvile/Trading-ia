/**
 * range-backtest.js — Backtest do plano Alpha_RangeMaster
 *
 * Busca até 1000 candles históricos da Binance (sem auth) para
 * BTCUSDT, ETHUSDT e SOLUSDT nos timeframes 1H e 4H,
 * simula o plano e imprime winrate, PnL e estatísticas detalhadas.
 *
 * Uso: node range-backtest.js
 */

import { config as dotenvConfig } from "dotenv";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dir = dirname(fileURLToPath(import.meta.url));
dotenvConfig({ path: join(__dir, "..", ".env") });

import { fetchCandles, applyPlanFilters, calcPlanStopTP, calcATR, runSafetyCheckRange, runSafetyCheckRangeV2 } from "./bot.js";

// ─── Plano testado ────────────────────────────────────────────────────────────
const PLAN = {
  name: "Alpha_RangeMaster",
  strategy: "range-v2",
  sl: { type: "atr", multiplier: 1.5 },
  tp: { type: "boundary", multiplier: 1.0 },
  filters: {
    adx_max: 28,
    adx_4h_max: 28,
    choppiness_min: 45,
    volume_max_mult: 1.3,
    rsi_long_max: 42,
    rsi_short_min: 58,
    stoch_k_long_max: 30,
    stoch_k_short_min: 70,
    sr_bars: 24,
    sr_atr_mult: 1.5,
    min_rr: 1.5
  },
};

const TARGETS = [
  { symbol: "BTCUSDT", timeframe: "1H" },
  { symbol: "SOLUSDT", timeframe: "1H" },
  { symbol: "SOLUSDT", timeframe: "4H" },
];

const WARMUP   = 250;  // candles de aquecimento dos indicadores
const MAX_HOLD = 96;   // max candles aguardando SL/TP antes de fechar no preço

// ─── Simulação ────────────────────────────────────────────────────────────────
function simulate(candles) {
  const trades = [];
  let i = WARMUP;

  while (i < candles.length) {
    const window = candles.slice(0, i + 1);

    // Filtros de Regime (ADX, Choppiness, Volume) via applyPlanFilters
    const extras = applyPlanFilters(window, PLAN);
    if (!extras.every(e => e.pass)) { i++; continue; }

    // Gatilho de Entrada via Range v2
    const safety = runSafetyCheckRangeV2(window, PLAN.filters);
    if (!safety.allPass) { i++; continue; }

    const bar        = candles[i];
    const entryPrice = bar.close;
    const side       = safety.side;
    const stop       = safety.stopPrice;
    const tp         = safety.takeProfitPrice;

    let exitPrice = null, exitIdx = null, result = "timeout";

    for (let j = i + 1; j < Math.min(candles.length, i + 1 + MAX_HOLD); j++) {
      const b = candles[j];
      if (side === 'LONG') {
        if (b.low  <= stop) { exitPrice = stop; exitIdx = j; result = "loss"; break; }
        if (b.high >= tp)   { exitPrice = tp;   exitIdx = j; result = "win";  break; }
      } else {
        if (b.high >= stop) { exitPrice = stop; exitIdx = j; result = "loss"; break; }
        if (b.low  <= tp)   { exitPrice = tp;   exitIdx = j; result = "win";  break; }
      }
    }

    if (exitPrice == null) {
      const last = candles[Math.min(candles.length - 1, i + MAX_HOLD)];
      exitPrice = last.close;
      exitIdx   = Math.min(candles.length - 1, i + MAX_HOLD);
      result    = (side === 'LONG' ? exitPrice >= entryPrice : exitPrice <= entryPrice) ? "win" : "loss";
    }

    const returnPct  = side === 'LONG' ? ((exitPrice - entryPrice) / entryPrice) * 100 : ((entryPrice - exitPrice) / entryPrice) * 100;
    const holdBars   = exitIdx - i;
    const entryDate  = new Date(bar.time).toISOString().slice(0, 16).replace("T", " ");

    trades.push({ entryIdx: i, exitIdx, entryPrice, exitPrice, stop, tp, result, returnPct, holdBars, entryDate, side });
    i = exitIdx + 1;
  }

  return trades;
}

// ─── Estatísticas ─────────────────────────────────────────────────────────────
function stats(trades) {
  if (!trades.length) return null;

  const wins     = trades.filter(t => t.result === "win");
  const losses   = trades.filter(t => t.result === "loss");
  const winrate  = (wins.length / trades.length) * 100;
  const avgWin   = wins.length   ? wins.reduce((a, t)   => a + t.returnPct, 0) / wins.length   : 0;
  const avgLoss  = losses.length ? losses.reduce((a, t) => a + t.returnPct, 0) / losses.length : 0;
  const totalPnl = trades.reduce((a, t) => a + t.returnPct, 0);
  const n        = trades.length;
  const expectancy = (wins.length / n) * avgWin + (losses.length / n) * avgLoss;
  const avgHold  = trades.reduce((a, t) => a + t.holdBars, 0) / n;
  const maxDD    = (() => {
    let peak = 0, equity = 0, dd = 0;
    for (const t of trades) {
      equity += t.returnPct;
      if (equity > peak) peak = equity;
      const cur = peak - equity;
      if (cur > dd) dd = cur;
    }
    return dd;
  })();

  return { total: n, wins: wins.length, losses: losses.length, winrate, avgWin, avgLoss, totalPnl, expectancy, avgHold, maxDD };
}

// ─── Formatação ───────────────────────────────────────────────────────────────
const LINE  = "═".repeat(62);
const SEP   = "─".repeat(62);

function pct(v) { return `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`; }
function num(v, d = 2) { return v.toFixed(d); }

function printResult(symbol, timeframe, trades, s) {
  console.log(`\n${LINE}`);
  console.log(`  📊 ${symbol} ${timeframe} — Alpha_RangeMaster`);
  console.log(LINE);

  if (!s) {
    console.log("  Sem trades suficientes neste período.");
    return;
  }

  const wr_icon = s.winrate >= 55 ? "✅" : s.winrate >= 45 ? "🟡" : "🔴";

  console.log(`  Trades totais  : ${s.total}  (${s.wins}W / ${s.losses}L)`);
  console.log(`  Win Rate       : ${wr_icon} ${num(s.winrate)}%`);
  console.log(`  PnL Total      : ${pct(s.totalPnl)}`);
  console.log(`  Expectância    : ${pct(s.expectancy)} por trade`);
  console.log(`  Avg Ganho      : ${pct(s.avgWin)}`);
  console.log(`  Avg Perda      : ${pct(s.avgLoss)}`);
  console.log(`  Max Drawdown   : ${pct(s.maxDD)}`);
  console.log(`  Tempo médio    : ${num(s.avgHold, 1)} candles`);
  console.log(SEP);

  // Últimos 5 trades
  console.log("  Últimos 5 trades:");
  const last5 = trades.slice(-5);
  for (const t of last5) {
    const icon = t.result === "win" ? "✅" : "❌";
    const side = t.side === 'LONG' ? 'L' : 'S';
    console.log(`    ${icon} [${side}] ${t.entryDate}  entrada $${t.entryPrice.toFixed(4)}  SL $${t.stop.toFixed(4)}  TP $${t.tp.toFixed(4)}  → ${pct(t.returnPct)} (${t.holdBars}b)`);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log("\n" + LINE);
  console.log("  🔬 BACKTEST — Plano Alpha_RangeMaster (Mercado Lateral)");
  console.log("  Período: últimos 1000 candles por timeframe");
  console.log("  Fonte: Binance Public API (sem autenticação)");
  console.log(LINE);

  const summary = [];

  for (const { symbol, timeframe } of TARGETS) {
    process.stdout.write(`\n⏳ Buscando ${symbol} ${timeframe}...`);
    let candles = [];
    try {
      if (timeframe === '1H' || timeframe === '1h') {
        const c1 = await fetchCandles(symbol, timeframe, 1000, false);
        const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1h&limit=440&endTime=${c1[0].time - 1}`;
        const res = await fetch(url);
        const d2 = await res.json();
        const c2 = d2.map(d => ({ time: d[0], open: parseFloat(d[1]), high: parseFloat(d[2]), low: parseFloat(d[3]), close: parseFloat(d[4]), volume: parseFloat(d[5]) }));
        candles = [...c2, ...c1];
      } else {
        // Para 4H, 60 dias = 360 candles
        candles = await fetchCandles(symbol, timeframe, 360, false);
      }
    } catch (e) {
      console.log(` ERRO: ${e.message}`);
      continue;
    }
    console.log(` ${candles.length} candles — simulando...`);

    const trades = simulate(candles);
    const s      = stats(trades);
    printResult(symbol, timeframe, trades, s);

    if (s) summary.push({ symbol, timeframe, ...s });
  }

  // Tabela resumo final
  console.log(`\n\n${LINE}`);
  console.log("  📋 RESUMO GERAL — Alpha_RangeMaster");
  console.log(LINE);
  console.log(
    "  Ativo       TF   Trades  WR%     PnL Total   Expect.   MaxDD"
  );
  console.log(SEP);
  for (const r of summary) {
    const wr   = num(r.winrate).padStart(5);
    const pnl  = pct(r.totalPnl).padStart(10);
    const exp  = pct(r.expectancy).padStart(9);
    const dd   = pct(r.maxDD).padStart(7);
    const tot  = String(r.total).padStart(6);
    const sym  = r.symbol.padEnd(10);
    const tf   = r.timeframe.padEnd(4);
    const icon = r.winrate >= 55 ? "✅" : r.winrate >= 45 ? "🟡" : "🔴";
    console.log(`  ${icon} ${sym} ${tf} ${tot}  ${wr}  ${pnl}  ${exp}  ${dd}`);
  }
  console.log(LINE);

  if (summary.length) {
    const best = summary.reduce((a, b) => (b.expectancy > a.expectancy ? b : a));
    const worst = summary.reduce((a, b) => (b.winrate < a.winrate ? b : a));
    console.log(`\n  🏆 Melhor combinação : ${best.symbol} ${best.timeframe} (expectância ${pct(best.expectancy)})`);
    console.log(`  ⚠️  Pior  winrate    : ${worst.symbol} ${worst.timeframe} (${num(worst.winrate)}%)`);
  }

  console.log(`\n${LINE}\n`);
}

main().catch(err => { console.error("Erro fatal:", err); process.exit(1); });
