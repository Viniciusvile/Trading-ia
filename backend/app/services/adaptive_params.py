"""Port de adaptive-bot/lib/params.js — guardrails dos parametros do Adaptive-Bot.

O Gemini so pode propor valores DENTRO dos bounds; fora disso e clampado. A
variacao por ciclo e limitada a MAX_STEP_PCT (evita saltos bruscos). Puro/testavel.
"""
from __future__ import annotations

STRATEGIES = ["micro-dip", "turbo-reversion"]
MAX_STEP_PCT = 0.25

PARAM_BOUNDS = {
    "ema_period": {"min": 5, "max": 100, "int": True},
    "rsi_period": {"min": 5, "max": 30, "int": True},
    "min_dip_pct": {"min": 0.001, "max": 0.03},
    "min_rsi": {"min": 5, "max": 40},
    "max_rsi": {"min": 40, "max": 75},
    "sl_pct": {"min": 0.003, "max": 0.03},
    "tp_pct": {"min": 0.004, "max": 0.05},
    "min_atr_pct": {"min": 0, "max": 0.01},
    "trend_ema_period": {"min": 0, "max": 200, "int": True},
    "cooldown_min": {"min": 1, "max": 120, "int": True},
}

DEFAULT_PARAMS = {
    "strategy": "micro-dip",
    "ema_period": 20,
    "rsi_period": 14,
    "min_dip_pct": 0.004,
    "min_rsi": 20,
    "max_rsi": 45,
    "sl_pct": 0.006,
    "tp_pct": 0.01,
    "min_atr_pct": 0.0,
    "trend_ema_period": 50,
    "cooldown_min": 15,
}


def validate_proposal(proposal: dict) -> bool:
    """Lanca ValueError se chave desconhecida, tipo errado ou strategy invalida."""
    for key in proposal:
        if key != "strategy" and key not in PARAM_BOUNDS:
            raise ValueError(f"Parametro desconhecido na proposta: {key}")
    if proposal.get("strategy") is not None and proposal["strategy"] not in STRATEGIES:
        raise ValueError(f"strategy invalida: {proposal['strategy']}")
    for key in PARAM_BOUNDS:
        v = proposal.get(key)
        if v is None:
            continue
        if not isinstance(v, (int, float)) or isinstance(v, bool):
            raise ValueError(f"Parametro {key} deve ser numerico, recebido: {v}")
    return True


def clamp_params(proposal: dict, current: dict) -> dict:
    """Clampa aos bounds absolutos E a variacao maxima por ciclo. Retorna {params, changed}."""
    strategy = proposal.get("strategy")
    params = {"strategy": strategy if strategy in STRATEGIES else current["strategy"]}
    changed = []
    for key, bound in PARAM_BOUNDS.items():
        original = proposal[key] if proposal.get(key) is not None else current[key]
        v = original
        cur = current.get(key)
        if isinstance(cur, (int, float)) and cur > 0:
            lo = cur * (1 - MAX_STEP_PCT)
            hi = cur * (1 + MAX_STEP_PCT)
            v = min(hi, max(lo, v))
        v = min(bound["max"], max(bound["min"], v))
        if bound.get("int"):
            v = round(v)
        if v != original:
            changed.append(key)
        params[key] = v
    return {"params": params, "changed": changed}
