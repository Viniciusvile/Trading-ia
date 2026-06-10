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

export function createSignalFn(plan) {
  const strategy = plan.strategy || "warrior";

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
  return warnings;
}
