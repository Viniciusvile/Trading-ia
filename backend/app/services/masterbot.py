"""Orquestracao do MasterBot (port de strategy-signals.js createSignalFn + ciclo).

decide_signal_for_plan: parte PURA que, dado um group_plan e os candles, escolhe
o gatilho (warrior/range-v2), aplica mode (spot bloqueia SHORT) e calcula stop/tp.
Espelha o adapter do legado. 'custom'/'micro-dip'/'turbo-reversion' ficam de fora
deste port inicial (custom depende de applyPlanFilters; modos scalper ja vivem no
servico do scalper).
"""
from __future__ import annotations

from app.services import masterbot_signals as mb


def decide_signal_for_plan(plan: dict, candles: list[dict]) -> dict:
    """PURA: decide entrada para um group_plan. Retorna {action, side, stop, tp, strategy}
    ou {action: 'none', reason}.
    """
    strategy = plan.get("strategy", "warrior")
    allow_short = plan.get("mode") == "futures"
    price = candles[-1]["close"]
    atr = mb.calc_atr(candles, 14)
    if atr is None:
        return {"action": "none", "reason": "atr indisponivel"}

    # FILTROS DE REGIME do plano (adx/choppiness/ema_triple/volume) — rodam ANTES do
    # safety check, igual ao legado. Se algum reprova, NAO opera (evita trades ruins).
    plan_filters = mb.apply_plan_filters(candles, plan)
    if plan_filters and not all(fr["pass"] for fr in plan_filters):
        return {"action": "none", "reason": "filtros de regime reprovados",
                "strategy": strategy, "conditions": plan_filters}

    if strategy == "range-v2":
        safety = mb.run_safety_check_range_v2(candles, plan.get("filters") or {})
        if not safety["allPass"] or not safety["side"]:
            return {"action": "none", "reason": "range-v2 sem setup", "strategy": strategy, "conditions": safety.get("results", [])}
        if safety["side"] == "SHORT" and not allow_short:
            return {"action": "none", "reason": "short bloqueado (spot)", "strategy": strategy, "conditions": safety.get("results", [])}
        # tp 'boundary' (padrao do range) usa alvo do proprio sinal; senao sl/tp do plano
        tp_cfg = plan.get("tp")
        use_boundary = not tp_cfg or tp_cfg.get("type") == "boundary"
        if use_boundary and safety["takeProfitPrice"] is not None and safety["stopPrice"] is not None:
            return {"action": "enter", "side": safety["side"], "stop": safety["stopPrice"],
                    "tp": safety["takeProfitPrice"], "strategy": strategy, "conditions": safety.get("results", [])}
        st = mb.calc_plan_stop_tp(price, atr, plan, safety["side"])
        return {"action": "enter", "side": safety["side"], "stop": st["stop"], "tp": st["tp"], "strategy": strategy, "conditions": safety.get("results", [])}

    if strategy == "state-ma-cross":
        safety = mb.run_safety_check_state_ma_cross(candles, plan.get("filters") or {})
        if not safety["allPass"] or not safety["side"]:
            return {"action": "none", "reason": "state-ma-cross sem cruzamento",
                    "strategy": strategy, "conditions": safety.get("results", [])}
        # script original é long-only (crossunder fecha, não abre short)
        st = mb.calc_plan_stop_tp(price, atr, plan, "LONG")
        return {"action": "enter", "side": "LONG", "stop": st["stop"], "tp": st["tp"],
                "strategy": strategy, "conditions": safety.get("results", [])}

    if strategy == "volatility-envelope":
        safety = mb.run_safety_check_volatility_envelope(candles, plan.get("filters") or {})
        if not safety["allPass"] or not safety["side"]:
            return {"action": "none", "reason": "envelope sem cruzamento de momentum",
                    "strategy": strategy, "conditions": safety.get("results", [])}
        if safety["side"] == "SHORT" and not allow_short:
            return {"action": "none", "reason": "short bloqueado (spot)",
                    "strategy": strategy, "conditions": safety.get("results", [])}
        st = mb.calc_plan_stop_tp(price, atr, plan, safety["side"])
        return {"action": "enter", "side": safety["side"], "stop": st["stop"], "tp": st["tp"],
                "strategy": strategy, "conditions": safety.get("results", [])}

    # warrior (long-only, seguidor de tendencia) — default
    safety = mb.run_safety_check_warrior(candles)
    if not safety["allPass"]:
        return {"action": "none", "reason": "warrior sem setup", "strategy": "warrior", "conditions": safety.get("results", [])}
    st = mb.calc_plan_stop_tp(price, atr, plan, "LONG")
    return {"action": "enter", "side": "LONG", "stop": st["stop"], "tp": st["tp"], "strategy": "warrior", "conditions": safety.get("results", [])}


def get_active_plan_names(rules: dict) -> list[str]:
    """Nomes dos planos ativos (active_plans array, fallback active_plan), igual ao bot.js."""
    ap = rules.get("active_plans")
    if isinstance(ap, list) and ap:
        return ap
    single = rules.get("active_plan")
    return [single] if single else []


def get_plan_for_symbol(symbol: str, rules: dict, run_mode: str = "master") -> dict | None:
    """Resolve o plano que cobre o simbolo, respeitando active_plans e mode, igual ao bot.js."""
    plans = rules.get("group_plans") or []
    active_names = get_active_plan_names(rules)
    if active_names:
        for name in active_names:
            fixed = next((p for p in plans if p.get("name") == name), None)
            if not fixed or symbol not in (fixed.get("symbols") or []):
                continue
            if run_mode != "futures" and fixed.get("mode") == "futures":
                continue
            if run_mode == "futures" and fixed.get("mode") != "futures":
                continue
            return fixed
        return None
    if run_mode == "futures":
        return next((p for p in plans if p.get("mode") == "futures" and symbol in (p.get("symbols") or [])), None)
    return next((p for p in plans if p.get("mode") != "futures" and symbol in (p.get("symbols") or [])), None)
