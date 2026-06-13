"""Testes de paridade do port do MasterBot (bot.js -> masterbot_signals.py).

Valores de referencia capturados rodando bot.js com a MESMA serie (mesmos
timestamps, pois o VWAP depende da sessao UTC).
"""
import math
from app.services import masterbot_signals as mb

CLOSES = [100, 101, 102, 101, 100, 99, 100, 102, 103, 102, 101, 100, 99,
          98, 99, 101, 103, 104, 103, 102, 104, 105, 106, 105, 104]
CANDLES = [
    {"open": c, "high": c + 1, "low": c - 1, "close": c, "volume": 1000 + i * 10,
     "time": 1700000000000 + i * 3600000}
    for i, c in enumerate(CLOSES)
]


def approx(a, b, tol=1e-9):
    return math.isclose(a, b, rel_tol=tol, abs_tol=tol)


def test_calc_atr_matches_legacy():
    assert approx(mb.calc_atr(CANDLES, 14), 2.2142857142857144)


def test_warrior_indicators_match_legacy():
    w = mb.run_safety_check_warrior(CANDLES)
    assert approx(w["indicators"]["ema9"], 103.7696287711924)
    assert approx(w["indicators"]["ema20"], 102.49379410548366)
    assert approx(w["indicators"]["rsi14"], 58.82352941176471)


def test_warrior_passes_on_uptrend():
    w = mb.run_safety_check_warrior(CANDLES)
    assert w["allPass"] is True
    assert w["side"] == "LONG"


def test_calc_plan_stop_tp_pct():
    r = mb.calc_plan_stop_tp(100, 2.0, {"sl": {"type": "pct", "value": 1.5}, "tp": {"type": "pct", "value": 3}}, "LONG")
    assert approx(r["stop"], 98.5)
    assert approx(r["tp"], 103)


def test_calc_plan_stop_tp_applies_min_floor():
    # sl/tp colados ao preco -> aplica pisos minimos (0.5% / 0.8%)
    r = mb.calc_plan_stop_tp(100, 0.01, {"sl_atr_mult": 0.1, "tp_atr_mult": 0.1}, "LONG")
    assert approx(r["stop"], 100 * (1 - mb.MIN_SL_PCT))
    assert approx(r["tp"], 100 * (1 + mb.MIN_TP_PCT))


def test_warrior_fails_on_downtrend():
    down = list(reversed(CLOSES))
    candles = [{"open": c, "high": c + 1, "low": c - 1, "close": c, "volume": 1000, "time": 1700000000000 + i * 3600000}
               for i, c in enumerate(down)]
    w = mb.run_safety_check_warrior(candles)
    assert w["allPass"] is False
    assert w["side"] is None
