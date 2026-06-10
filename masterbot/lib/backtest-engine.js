/**
 * backtest-engine.js — Motor de backtest genérico e puro.
 *
 * Não conhece Binance nem indicadores: recebe candles e uma signalFn.
 *   signalFn(window) → null | { side: 'LONG'|'SHORT', stop: number, tp: number }
 *
 * A simulação caminha candle a candle: quando a signalFn dispara, entra no
 * close do candle atual e procura SL/TP nos candles seguintes (high/low),
 * com saída forçada no close após maxHold candles.
 */

export function simulateTrades(candles, signalFn, opts = {}) {
  const warmup = opts.warmup ?? 250;
  const maxHold = opts.maxHold ?? 96;
  const trades = [];
  let i = warmup;

  while (i < candles.length - 1) {
    const window = candles.slice(0, i + 1);
    let signal = null;
    try {
      signal = signalFn(window);
    } catch {
      signal = null; // indicador sem dados suficientes nessa janela
    }
    if (!signal || !signal.side || signal.stop == null || signal.tp == null) { i++; continue; }

    const bar = candles[i];
    const entryPrice = bar.close;
    const { side, stop, tp } = signal;

    let exitPrice = null, exitIdx = null, result = "timeout";
    const lastIdx = Math.min(candles.length - 1, i + maxHold);

    for (let j = i + 1; j <= lastIdx; j++) {
      const b = candles[j];
      if (side === "LONG") {
        if (b.low <= stop) { exitPrice = stop; exitIdx = j; result = "loss"; break; }
        if (b.high >= tp)  { exitPrice = tp;  exitIdx = j; result = "win";  break; }
      } else {
        if (b.high >= stop) { exitPrice = stop; exitIdx = j; result = "loss"; break; }
        if (b.low <= tp)    { exitPrice = tp;  exitIdx = j; result = "win";  break; }
      }
    }

    if (exitPrice == null) {
      exitIdx = lastIdx;
      exitPrice = candles[exitIdx].close;
      result = "timeout";
    }

    const returnPct = side === "LONG"
      ? ((exitPrice - entryPrice) / entryPrice) * 100
      : ((entryPrice - exitPrice) / entryPrice) * 100;

    trades.push({
      entryTime: bar.time,
      exitTime: candles[exitIdx].time,
      side,
      entryPrice,
      exitPrice,
      stop,
      tp,
      result,
      returnPct,
      holdBars: exitIdx - i,
    });
    i = exitIdx + 1;
  }

  return trades;
}

export function computeStats(trades, initialCapital = 10000) {
  if (!trades || !trades.length) return null;

  const wins = trades.filter((t) => t.returnPct > 0);
  const losses = trades.filter((t) => t.returnPct <= 0);
  const totalGains = wins.reduce((a, t) => a + t.returnPct, 0);
  const totalLosses = Math.abs(losses.reduce((a, t) => a + t.returnPct, 0));

  let equity = initialCapital;
  let peak = initialCapital;
  let maxDrawdownPct = 0;
  for (const t of trades) {
    equity *= 1 + t.returnPct / 100;
    if (equity > peak) peak = equity;
    const dd = ((peak - equity) / peak) * 100;
    if (dd > maxDrawdownPct) maxDrawdownPct = dd;
  }

  const n = trades.length;
  const avgWin = wins.length ? totalGains / wins.length : 0;
  const avgLoss = losses.length ? -totalLosses / losses.length : 0;

  return {
    totalTrades: n,
    wins: wins.length,
    losses: losses.length,
    winRate: wins.length / n,
    profitFactor: totalLosses > 0 ? totalGains / totalLosses : (totalGains > 0 ? 99 : 0),
    netProfitPct: trades.reduce((a, t) => a + t.returnPct, 0),
    netProfitUsd: equity - initialCapital,
    expectancyPct: (wins.length / n) * avgWin + (losses.length / n) * avgLoss,
    avgWinPct: avgWin,
    avgLossPct: avgLoss,
    maxDrawdownPct,
    avgHoldBars: trades.reduce((a, t) => a + (t.holdBars || 0), 0) / n,
  };
}

export function buildEquityCurve(trades, initialCapital = 10000) {
  const sorted = [...trades].sort((a, b) => (a.exitTime ?? 0) - (b.exitTime ?? 0));
  let equity = initialCapital;
  const curve = [{ time: sorted.length ? sorted[0].entryTime ?? sorted[0].exitTime : Date.now(), equity }];
  for (const t of sorted) {
    equity *= 1 + t.returnPct / 100;
    curve.push({ time: t.exitTime, equity: Math.round(equity * 100) / 100 });
  }
  return curve;
}
