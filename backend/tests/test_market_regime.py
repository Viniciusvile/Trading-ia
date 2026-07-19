"""Testes do detector de regime (parte PURA, sem Binance)."""
from app.services.market_regime import detect_regime


def _candles(closes):
    return [{"close": c} for c in closes]


def test_uptrend_is_bull():
    # série subindo de forma consistente: preço acima da EMA200, EMA50 subindo
    closes = [100 + i * 0.5 for i in range(250)]
    r = detect_regime(_candles(closes))
    assert r["regime"] == "bull"
    assert r["close"] > r["ema200"]
    assert r["slope_pct"] > 0


def test_downtrend_is_bear():
    # queda consistente (como o BTC 64k -> 58k de 22-30/jun)
    closes = [200 - i * 0.5 for i in range(250)]
    r = detect_regime(_candles(closes))
    assert r["regime"] == "bear"
    assert r["close"] < r["ema200"]
    assert r["slope_pct"] < 0


def test_flat_market_is_neutral():
    closes = [100.0] * 250
    r = detect_regime(_candles(closes))
    assert r["regime"] == "neutral"


def test_not_enough_bars_is_neutral():
    r = detect_regime(_candles([100.0] * 30))
    assert r["regime"] == "neutral"


def test_price_above_ema_but_falling_is_not_bull():
    # subiu muito e começou a cair: preço ainda acima da EMA200,
    # mas EMA50 virando para baixo -> não pode ser bull
    closes = [100 + i for i in range(200)] + [300 - i * 3 for i in range(50)]
    r = detect_regime(_candles(closes))
    assert r["regime"] != "bull"
