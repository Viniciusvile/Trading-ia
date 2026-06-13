"""Testes de paridade do port do scalper (signals.js -> scalper_signals.py).

Os valores esperados foram capturados rodando o signals.js legado com a MESMA
serie de candles, garantindo paridade numerica na origem.
"""
import math

from app.services import scalper_signals as s

# Serie fixa usada para capturar os valores de referencia no legado.
CLOSES = [100, 101, 102, 101, 100, 99, 100, 102, 103, 102,
          101, 100, 99, 98, 99, 101, 103, 104, 103, 102]
CANDLES = [
    {"open": c, "high": c + 1, "low": c - 1, "close": c, "volume": 1000 + i * 10, "vol": 1000 + i * 10}
    for i, c in enumerate(CLOSES)
]


def approx(a, b, tol=1e-9):
    return math.isclose(a, b, rel_tol=tol, abs_tol=tol)


def test_calc_ema_matches_legacy():
    assert approx(s.calc_ema(CLOSES, 8), 101.82472481116463)


def test_calc_rsi_period3_matches_legacy():
    assert approx(s.calc_rsi(CLOSES, 3), 33.33333333333333)


def test_calc_rsi_period14_matches_legacy():
    assert approx(s.calc_rsi(CLOSES, 14), 58.82352941176471)


def test_calc_bb_matches_legacy():
    bb = s.calc_bb(CLOSES, 20, 1.8)
    assert approx(bb["basis"], 101)
    assert approx(bb["upper"], 103.84604989415155)
    assert approx(bb["lower"], 98.15395010584845)


def test_calc_atr_pct_matches_legacy():
    assert approx(s.calc_atr_pct(CANDLES, 14), 2.170868347338936)


def test_rsi_all_gains_returns_100():
    assert s.calc_rsi([1, 2, 3, 4, 5], 3) == 100


def test_rsi_insufficient_bars_returns_50():
    assert s.calc_rsi([1, 2], 3) == 50


# ─── Sinais completos (paridade com o legado) ───

def _mk(closes):
    return [{"open": c, "high": c + 0.3, "low": c - 0.3, "close": c, "volume": 1000, "vol": 1000} for c in closes]


def test_micro_scalp_buy_matches_legacy():
    # Serie de alta com micro-dip no ultimo candle -> buy no legado.
    up = [100, 100.5, 101, 101.5, 102, 102.5, 103, 103.5, 104, 104.5,
          105, 105.5, 106, 106.5, 107, 107.5, 108, 108.5, 109, 108.6]
    sig = s.micro_scalp_signal(_mk(up), {"ema_period": 8, "rsi_period": 3,
                                         "min_dip": 0.001, "min_rsi": 20, "max_rsi": 90})
    assert sig["signal"] == "buy"
    assert sig["reason"] == "bull-trend micro-dip"
    assert approx(sig["ema"], 107.56476702906279)
    assert approx(sig["rsi"], 71.42857142857113, tol=1e-6)


def test_micro_scalp_flat_on_flat_series():
    flat = [100] * 20
    assert s.micro_scalp_signal(_mk(flat), {"min_dip": 0.001})["signal"] == "flat"


def test_turbo_reversion_flat_on_flat_series():
    flat = [100] * 20
    assert s.turbo_reversion_signal(_mk(flat), {})["signal"] == "flat"


def test_micro_scalp_not_enough_bars():
    assert s.micro_scalp_signal(_mk([100, 101]), {})["signal"] == "flat"
