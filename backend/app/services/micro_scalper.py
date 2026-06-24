"""Orquestracao do Micro-Scalper (port de micro-scalper.js).

Separa a parte PURA (decidir sinal a partir de plan+candles) da parte com I/O
(buscar candles na Binance, ler config no banco, registrar). A parte pura e
testavel; a orquestracao roda via task Celery.

Por enquanto opera apenas em PAPER: registra a decisao, nao envia ordem real.
A virada para execucao real (com order_executor + parar o scalper legado) e um
passo posterior, com aprovacao explicita.
"""
from __future__ import annotations

from app.services import scalper_signals as sig

# Mapeia os campos do plano (user_micro_config.data.plans[symbol]) para os
# opts esperados pelas funcoes de sinal. Espelha o adapter do legado.
def _plan_to_opts(plan: dict) -> dict:
    return {
        # micro-dip
        "ema_period": plan.get("ema_period", 8),
        "rsi_period": plan.get("rsi_period", 3),
        "min_dip": plan.get("min_dip_pct", 0.0005),
        "min_rsi": plan.get("min_rsi", 25),
        "max_rsi": plan.get("max_rsi", 75),
        # turbo-reversion
        "bb_len": plan.get("bb_length", 20),
        "bb_mult": plan.get("bb_mult", 1.8),
        "rsi_len": plan.get("rsi_period", 14),
        "rsi_limit": plan.get("rsi_limit", 35),
        "vol_mult": plan.get("vol_mult", 1.3),
        # filtros compartilhados
        "trend_ema_period": plan.get("trend_ema_period", 0),
        "trend_slope_bars": plan.get("trend_slope_bars", 5),
        "trend_max_down_pct": plan.get("trend_max_down_pct", 0),
        "min_atr_pct": plan.get("min_atr_pct", 0),
    }


def decide_signal_for_symbol(plan: dict, candles: list[dict]) -> dict:
    """PURA: dado o plano de um simbolo e os candles, retorna a decisao.

    Long-only em spot (igual ao scalper ao vivo): so 'buy' vira entrada.
    Retorna {action, entryPrice, slPrice, tpPrice, signal, reason} ou
    {action: 'none', reason}.
    """
    mode = plan.get("strategy_mode", "micro-dip")
    opts = _plan_to_opts(plan)

    if mode == "turbo-reversion":
        s = sig.turbo_reversion_signal(candles, opts)
    else:
        s = sig.micro_scalp_signal(candles, opts)

    if s.get("signal") != "buy":
        return {"action": "none", "reason": s.get("reason", "no setup"), "signal": s.get("signal")}

    price = candles[-1]["close"]
    sl_pct = plan.get("sl_pct", 0.005)
    tp_pct = plan.get("tp_pct", 0.01)
    return {
        "action": "buy",
        "entryPrice": price,
        "slPrice": price * (1 - sl_pct),
        "tpPrice": price * (1 + tp_pct),
        "signal": s.get("reason"),
        "reason": s.get("reason"),
    }


def active_symbols(config_data: dict) -> list[str]:
    """Simbolos ativos a operar, a partir do user_micro_config.data.

    NUNCA retorna simbolos que a IA desativou (deactivated_by_system): um par
    desativado nao pode abrir trade novo. Alem disso, uma lista active_symbols
    vazia ([]) significa "nenhum ativo" e e respeitada — so caimos no fallback
    para todos os planos quando a chave nunca foi definida (None), evitando o
    bug em que desativar todos os pares reativava todos via fallback.
    """
    deactivated = set(config_data.get("deactivated_by_system") or [])
    syms = config_data.get("active_symbols")
    if syms is not None:
        return [s for s in syms if s not in deactivated]
    # fallback (chave ausente): todos os simbolos com plano, menos os desativados
    return [s for s in (config_data.get("plans") or {}).keys() if s not in deactivated]
