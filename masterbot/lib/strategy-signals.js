/**
 * strategy-signals.js — Adapter que transforma um plano (group_plan do
 * rules.json) em uma signalFn para o backtest-engine.
 *
 * Reutiliza exatamente as mesmas funções que o bot usa ao vivo
 * (applyPlanFilters, runSafetyCheckWarrior, runSafetyCheckRangeV2,
 * calcPlanStopTP), garantindo que o backtest simula o comportamento real.
 *
 * Limitação conhecida: filtros dual-timeframe (adx_4h_max) são ignorados no
 * backtest — o resultado pode ser otimista para planos que os usam.
 */
import {
  applyPlanFilters,
  runSafetyCheckWarrior,
  runSafetyCheckRangeV2,
  calcATR,
  calcPlanStopTP,
} from "../bot.js";
import { microScalpSignal, turboReversionSignal } from "../../src/scalper/signals.js";

export function createSignalFn(plan) {
  const strategy = plan.strategy || "warrior";

  // ── Modos do Micro Scalper (micro-dip / turbo-reversion) ──
  // Reutiliza as MESMAS funções de sinal do robô scalper ao vivo, com SL/TP
  // percentuais (sl_pct/tp_pct) — long-only, igual ao scalper em spot.
  if (strategy === "micro-dip" || strategy === "turbo-reversion") {
    const p = plan.scalper || plan.filters || {};
    const tpPct = p.tp_pct ?? 0.01;
    const slPct = p.sl_pct ?? 0.005;
    const sharedOpts = {
      trendEmaPeriod: p.trend_ema_period || 0,
      trendSlopeBars: p.trend_slope_bars || 5,
      trendMaxDownPct: p.trend_max_down_pct || 0,
      minAtrPct: p.min_atr_pct || 0,
    };
    return function scalperSignalFn(window) {
      const sig = strategy === "turbo-reversion"
        ? turboReversionSignal(window, {
            bbLen: p.bb_length, bbMult: p.bb_mult,
            rsiLen: p.rsi_period, rsiLimit: p.rsi_limit, volMult: p.vol_mult,
            ...sharedOpts,
          })
        : microScalpSignal(window, {
            emaPeriod: p.ema_period, rsiPeriod: p.rsi_period,
            minDip: p.min_dip_pct, minRsi: p.min_rsi, maxRsi: p.max_rsi,
            ...sharedOpts,
          });
      if (sig.signal !== "buy") return null; // scalper ao vivo é long-only (spot)
      const price = window[window.length - 1].close;
      return { side: "LONG", stop: price * (1 - slPct), tp: price * (1 + tpPct) };
    };
  }

  // Spot não permite venda a descoberto: espelha a restrição do bot ao vivo
  const allowShort = plan.mode === "futures";

  return function signalFn(window) {
    // 1. Filtros de regime do plano (EMA tripla, ADX, volume, choppiness...)
    const filterResults = applyPlanFilters(window, plan);
    if (!filterResults.every((f) => f.pass)) return null;

    const price = window[window.length - 1].close;
    const atr = calcATR(window, 14);
    if (!atr) return null;

    // 2. Gatilho de entrada da estratégia base
    if (strategy === "range-v2") {
      const safety = runSafetyCheckRangeV2(window, plan.filters || {});
      if (!safety.allPass || !safety.side) return null;

      if (safety.side === "SHORT" && !allowShort) return null;

      // tp tipo 'boundary' (padrão do range) usa o alvo do próprio sinal
      // (resistência/suporte); senão respeita o SL/TP do plano (ATR/pct).
      const useBoundary = !plan.tp || plan.tp.type === "boundary";
      if (useBoundary && safety.takeProfitPrice != null && safety.stopPrice != null) {
        return { side: safety.side, stop: safety.stopPrice, tp: safety.takeProfitPrice };
      }
      const { stop, tp } = calcPlanStopTP(price, atr, plan, safety.side);
      return { side: safety.side, stop, tp };
    }

    // warrior (long-only, seguidor de tendência)
    const safety = runSafetyCheckWarrior(window);
    if (!safety.allPass) return null;
    const { stop, tp } = calcPlanStopTP(price, atr, plan, "LONG");
    return { side: "LONG", stop, tp };
  };
}

/**
 * Avisos sobre aspectos do plano que o backtest não consegue reproduzir.
 * O endpoint de backtest inclui isso na resposta para exibição na UI.
 */
export function getPlanWarnings(plan) {
  const warnings = [];
  if (plan?.filters?.adx_4h_max != null) {
    warnings.push("O filtro de ADX 4H (adx_4h_max) é ignorado no backtest — o resultado pode ser mais otimista que o bot ao vivo.");
  }
  if (plan?.mode !== "futures" && (plan?.strategy === "range-v2")) {
    warnings.push("Modo spot: sinais SHORT do Range v2 são descartados (sem venda a descoberto), igual ao bot ao vivo.");
  }
  if (plan?.strategy === "micro-dip" || plan?.strategy === "turbo-reversion") {
    warnings.push("O backtest do scalper avalia candles 5m fechados; o robô ao vivo reage em tempo real a cada poucos segundos — os resultados são uma aproximação.");
  }
  return warnings;
}
