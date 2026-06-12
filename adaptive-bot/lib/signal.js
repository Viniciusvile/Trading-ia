// Converte os parâmetros ativos em uma signalFn compatível com o
// backtest-engine (mesmo contrato de masterbot/lib/strategy-signals.js).
// A MESMA função serve o bot ao vivo e o walk-forward do learner —
// garantia de que o que foi validado é o que roda.
import { microScalpSignal, turboReversionSignal } from "../../src/scalper/signals.js";

export function createSignalFn(params) {
  const sharedOpts = {
    trendEmaPeriod: params.trend_ema_period || 0,
    minAtrPct: params.min_atr_pct || 0,
  };
  return function adaptiveSignalFn(window) {
    const sig = params.strategy === "turbo-reversion"
      ? turboReversionSignal(window, {
          rsiLen: params.rsi_period,
          rsiLimit: params.min_rsi,
          ...sharedOpts,
        })
      : microScalpSignal(window, {
          emaPeriod: params.ema_period,
          rsiPeriod: params.rsi_period,
          minDip: params.min_dip_pct,
          minRsi: params.min_rsi,
          maxRsi: params.max_rsi,
          ...sharedOpts,
        });
    if (sig.signal !== "buy") return null; // long-only (spot)
    const price = window[window.length - 1].close;
    return {
      side: "LONG",
      stop: price * (1 - params.sl_pct),
      tp: price * (1 + params.tp_pct),
    };
  };
}
