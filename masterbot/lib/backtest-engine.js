import {
  runSafetyCheckWarrior,
  applyPlanFilters,
  calcPlanStopTP,
  calcATR,
} from "../bot.js";

const WARMUP = 250;
const MAX_HOLD = 96;

export async function simulatePlan({ candles, plan }) {
  const trades = [];
  let i = WARMUP;

  while (i < candles.length) {
    const window = candles.slice(0, i + 1);
    const safety = runSafetyCheckWarrior(window);
    const extras = applyPlanFilters(window, plan);
    const allPass = safety.allPass && extras.every(e => e.pass);

    if (!allPass) { i++; continue; }

    const entryBar = candles[i];
    const entryPrice = entryBar.close;
    const atr = calcATR(window, 14);
    const { stop, tp } = calcPlanStopTP(entryPrice, atr, plan, 'LONG');

    let exitPrice = null, exitIdx = null, result = 'timeout';
    for (let j = i + 1; j < Math.min(candles.length, i + 1 + MAX_HOLD); j++) {
      const bar = candles[j];
      if (bar.low <= stop) { exitPrice = stop; exitIdx = j; result = 'loss'; break; }
      if (bar.high >= tp)  { exitPrice = tp;   exitIdx = j; result = 'win';  break; }
    }
    if (exitPrice == null) {
      const last = candles[Math.min(candles.length - 1, i + MAX_HOLD)];
      exitPrice = last.close;
      exitIdx = Math.min(candles.length - 1, i + MAX_HOLD);
      result = exitPrice > entryPrice ? 'win' : 'loss';
    }

    const returnPct = ((exitPrice - entryPrice) / entryPrice) * 100;
    trades.push({ entryIdx: i, exitIdx, entryPrice, exitPrice, result, returnPct });
    i = exitIdx + 1;
  }

  const wins = trades.filter(t => t.result === 'win').length;
  const losses = trades.length - wins;
  const winrate = trades.length ? (wins / trades.length) * 100 : 0;
  const winsArr = trades.filter(t => t.result === 'win').map(t => t.returnPct);
  const lossArr = trades.filter(t => t.result === 'loss').map(t => t.returnPct);
  const avgWin = winsArr.length ? winsArr.reduce((a,b)=>a+b,0)/winsArr.length : 0;
  const avgLoss = lossArr.length ? lossArr.reduce((a,b)=>a+b,0)/lossArr.length : 0;
  const n = Math.max(trades.length, 1);
  const expectancy = (wins/n)*avgWin + (losses/n)*avgLoss;

  return { trades, wins, losses, winrate, expectancy, avgWin, avgLoss };
}
