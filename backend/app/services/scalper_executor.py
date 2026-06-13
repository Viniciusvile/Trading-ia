"""Ciclo de gestão de posição do scalper — port da lógica de gestão de micro-scalper.js
(breakeven trailing + timeout) e src/scalper/position.js (evaluate_exit).

Separação: `decide_management` é PURA (testável sem Binance) e decide a AÇÃO para
uma posição aberta; a orquestração que TOCA a Binance (consultar OCO, recolocar
OCO no breakeven, fechar no timeout) fica em manage_open_position, chamada pela task.

Modelo de saída: como usamos OCO REAL, a Binance fecha sozinha quando TP/SL batem.
O ciclo só PRECISA: (a) detectar OCO ALL_DONE -> registrar saida; (b) breakeven ->
cancelar+recolocar OCO com SL mais alto; (c) timeout -> fechar a mercado.
"""
from __future__ import annotations


def compute_tp_sl(entry_price: float, tp_pct: float, sl_pct: float, side: str = "buy") -> dict:
    """TP/SL a partir de percentuais (port de createPosition)."""
    if side == "buy":
        return {"tp": entry_price * (1 + tp_pct), "sl": entry_price * (1 - sl_pct)}
    return {"tp": entry_price * (1 - tp_pct), "sl": entry_price * (1 + sl_pct)}


def decide_management(pos: dict, price: float, now_ms: int) -> dict:
    """PURA: decide a acao para uma posicao aberta (side buy/long).

    pos: {entry_price, sl_price, opened_at_ms, max_hold_ms, breakeven_pct,
          breakeven_triggered}
    Retorna {action: 'hold'|'breakeven'|'timeout_exit', new_sl?: float, reason?: str}.

    Ordem de prioridade espelha o legado: breakeven (ajusta SL) e avaliado a cada
    ciclo; timeout dispara saida a mercado. TP/SL "naturais" sao tratados pela OCO
    na Binance (nao aqui).
    """
    entry = pos["entry_price"]
    breakeven_pct = pos.get("breakeven_pct") or 0
    triggered = pos.get("breakeven_triggered", False)

    # 1) Breakeven trailing: preco subiu breakeven_pct -> SL sobe p/ entrada +0.05%
    if breakeven_pct and not triggered:
        threshold = entry * (1 + breakeven_pct)
        if price >= threshold:
            return {"action": "breakeven", "new_sl": entry * 1.0005,
                    "reason": "breakeven_triggered"}

    # 2) Timeout: posicao velha demais -> sai a mercado
    max_hold = pos.get("max_hold_ms") or 0
    opened = pos.get("opened_at_ms") or 0
    if max_hold and opened and (now_ms - opened) >= max_hold:
        return {"action": "timeout_exit", "reason": "timeout"}

    return {"action": "hold"}
