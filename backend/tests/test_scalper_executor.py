"""Testes da gestao PURA de posicao do scalper (port de position.js + breakeven)."""
from app.services.scalper_executor import compute_tp_sl, decide_management


def test_compute_tp_sl_long():
    r = compute_tp_sl(100.0, tp_pct=0.02, sl_pct=0.01, side="buy")
    assert round(r["tp"], 4) == 102.0
    assert round(r["sl"], 4) == 99.0


def test_hold_quando_nada_dispara():
    pos = {"entry_price": 100, "sl_price": 99, "opened_at_ms": 1000,
           "max_hold_ms": 3_600_000, "breakeven_pct": 0.01, "breakeven_triggered": False}
    # preco abaixo do threshold de breakeven, dentro do tempo
    out = decide_management(pos, price=100.5, now_ms=1000 + 60_000)
    assert out["action"] == "hold"


def test_breakeven_dispara_quando_preco_sobe():
    pos = {"entry_price": 100, "sl_price": 99, "opened_at_ms": 1000,
           "max_hold_ms": 3_600_000, "breakeven_pct": 0.01, "breakeven_triggered": False}
    # preco >= 101 (entry * 1.01) dispara breakeven
    out = decide_management(pos, price=101.0, now_ms=1000 + 60_000)
    assert out["action"] == "breakeven"
    assert round(out["new_sl"], 4) == round(100 * 1.0005, 4)  # entrada +0.05%


def test_breakeven_nao_redispara_se_ja_acionado():
    pos = {"entry_price": 100, "sl_price": 100.05, "opened_at_ms": 1000,
           "max_hold_ms": 3_600_000, "breakeven_pct": 0.01, "breakeven_triggered": True}
    out = decide_management(pos, price=101.0, now_ms=1000 + 60_000)
    assert out["action"] == "hold"


def test_timeout_dispara_saida():
    pos = {"entry_price": 100, "sl_price": 99, "opened_at_ms": 1000,
           "max_hold_ms": 3_600_000, "breakeven_pct": 0, "breakeven_triggered": False}
    out = decide_management(pos, price=100.5, now_ms=1000 + 3_600_001)
    assert out["action"] == "timeout_exit"
    assert out["reason"] == "timeout"


def test_breakeven_tem_prioridade_sobre_timeout():
    # se ambos poderiam disparar, breakeven (ajuste de SL) vem primeiro
    pos = {"entry_price": 100, "sl_price": 99, "opened_at_ms": 1000,
           "max_hold_ms": 3_600_000, "breakeven_pct": 0.01, "breakeven_triggered": False}
    out = decide_management(pos, price=101.0, now_ms=1000 + 3_600_001)
    assert out["action"] == "breakeven"
