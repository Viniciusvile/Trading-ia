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


RANGE_CLOSES = [110, 109, 108, 107, 106, 105, 104, 103, 102, 101, 100, 99, 98, 97, 96,
                95, 94, 93, 92, 91, 90, 89, 88, 89, 90, 89, 88, 89, 90]
RANGE_CANDLES = [
    {"open": c, "high": c + 0.5, "low": c - 0.5, "close": c, "volume": 1000,
     "time": 1700000000000 + i * 3600000}
    for i, c in enumerate(RANGE_CLOSES)
]


def test_range_v2_indicators_match_legacy():
    r = mb.run_safety_check_range_v2(RANGE_CANDLES, {})
    ind = r["indicators"]
    assert approx(ind["rsi"], 28.57142857142857)
    assert approx(ind["stoch"]["k"], 31.25)
    assert approx(ind["stoch"]["d"], 17.63888888888889)
    assert approx(ind["stoch"]["prevK"], 16.666666666666664)
    assert approx(ind["support"], 87.5)
    assert approx(ind["resistance"], 105.5)


def test_range_v2_no_entry_when_stoch_above_30():
    # K=31.25 > 30 -> nao dispara LONG (paridade: side=null no legado)
    r = mb.run_safety_check_range_v2(RANGE_CANDLES, {})
    assert r["side"] is None
    assert r["allPass"] is False


def test_calc_stochastic_none_when_insufficient():
    assert mb.calc_stochastic(RANGE_CANDLES[:5], 14, 3) is None


def test_warrior_fails_on_downtrend():
    down = list(reversed(CLOSES))
    candles = [{"open": c, "high": c + 1, "low": c - 1, "close": c, "volume": 1000, "time": 1700000000000 + i * 3600000}
               for i, c in enumerate(down)]
    w = mb.run_safety_check_warrior(candles)
    assert w["allPass"] is False
    assert w["side"] is None
