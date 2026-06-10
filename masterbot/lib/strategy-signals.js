/**
 * strategy-signals.js — Adapter que transforma um plano (group_plan do
 * rules.json) em uma signalFn para o backtest-engine.
 *
 * Reutiliza exatamente as mesmas funções que o bot usa ao vivo
 * (applyPlanFilters, runSafetyCheckWarrior, runSafetyCheckRangeV2,
 * calcPlanStopTP), garantindo que o backtest simula o comportamento real.
 */
import {
  applyPlanFilters,
  runSafetyCheckWarrior,
  runSafetyCheckRangeV2,
  calcATR,
  calcPlanStopTP,
} from "../bot.js";

export function createSignalFn(plan) {
  const strategy = plan.strategy || "warrior";

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

      // tp tipo 'boundary' (padrão do range) usa o alvo do próprio sinal
      // (resistência/suporte); senão respeita o SL/TP do plano (ATR/pct).
      const useBoundary = !plan.tp || plan.tp.type === "boundary";
      if (useBoundary && safety.takeProfitPrice != null && safety.stopPrice != null) {
        return { side: safety.side, stop: safety.stopPrice, tp: safety.takeProfitPrice };
      }
      const { stop, tp } = calcPlanStopTP(price, atr, plan, safety.side);
      return { side: safety.side, stop: safety.stopPrice ?? stop, tp };
    }

    // warrior (long-only, seguidor de tendência)
    const safety = runSafetyCheckWarrior(window);
    if (!safety.allPass) return null;
    const { stop, tp } = calcPlanStopTP(price, atr, plan, "LONG");
    return { side: "LONG", stop, tp };
  };
}
