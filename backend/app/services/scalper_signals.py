"""Port PURO de src/scalper/signals.js (legado) para Python.

Mantém listas/loops puros (sem pandas) para paridade numérica exata com o JS:
- calc_ema inicia em closes[0] e itera (mesmo que o legado);
- calc_rsi usa soma de ganhos/perdas na janela (period);
- calc_bb usa desvio-padrão populacional (divide por N);
- calc_atr_pct usa True Range médio em % do último close.

Funções determinísticas, sem I/O — testadas em tests/test_scalper_signals.py
contra valores capturados do legado.
"""
from __future__ import annotations

Candle = dict  # {open, high, low, close, volume|vol}


def calc_ema(closes: list[float], period: int) -> float:
    if not closes:
        return 0.0
    k = 2 / (period + 1)
    ema = closes[0]
    for i in range(1, len(closes)):
        ema = closes[i] * k + ema * (1 - k)
    return ema


def calc_rsi(closes: list[float], period: int = 3) -> float:
    if len(closes) < period + 1:
        return 50.0
    gains = 0.0
    losses = 0.0
    for i in range(len(closes) - period, len(closes)):
        diff = closes[i] - closes[i - 1]
        if diff > 0:
            gains += diff
        else:
            losses -= diff
    if losses == 0:
        return 100.0
    if gains == 0:
        return 0.0
    rs = gains / losses
    return 100 - 100 / (1 + rs)


def calc_standard_deviation(values: list[float]) -> float:
    avg = sum(values) / len(values)
    square_diffs = [(v - avg) ** 2 for v in values]
    avg_square_diff = sum(square_diffs) / len(values)
    return avg_square_diff ** 0.5


def calc_bb(closes: list[float], length: int = 20, mult: float = 1.8) -> dict:
    if len(closes) < length:
        last = closes[-1]
        return {"basis": last, "upper": last, "lower": last}
    sl = closes[len(closes) - length:]
    basis = sum(sl) / length
    dev = calc_standard_deviation(sl)
    return {"basis": basis, "upper": basis + dev * mult, "lower": basis - dev * mult}


def _vol(c: Candle) -> float:
    v = c.get("vol")
    if v is None:
        v = c.get("volume", 0)
    return v or 0


def calc_atr_pct(candles: list[Candle], period: int = 14) -> float:
    if len(candles) < period + 1:
        return 0.0
    trs = []
    for i in range(len(candles) - period, len(candles)):
        c = candles[i]
        prev = candles[i - 1]
        tr = max(
            c["high"] - c["low"],
            abs(c["high"] - prev["close"]),
            abs(c["low"] - prev["close"]),
        )
        trs.append(tr)
    atr = sum(trs) / len(trs)
    last_close = candles[-1]["close"]
    return (atr / last_close) * 100 if last_close else 0.0


def micro_scalp_signal(candles: list[Candle], opts: dict | None = None) -> dict:
    opts = opts or {}
    ema_period = opts.get("ema_period", 8)
    rsi_period = opts.get("rsi_period", 3)
    min_dip = opts.get("min_dip", 0.0005)
    max_rsi = opts.get("max_rsi", 75)
    min_rsi = opts.get("min_rsi", 25)
    trend_ema_period = opts.get("trend_ema_period", 0)
    trend_slope_bars = opts.get("trend_slope_bars", 5)
    trend_max_down_pct = opts.get("trend_max_down_pct", 0)
    min_atr_pct = opts.get("min_atr_pct", 0)

    if len(candles) < max(ema_period, rsi_period, trend_ema_period) + 2:
        return {"signal": "flat", "reason": "not enough bars"}

    closes = [c["close"] for c in candles]
    last = closes[-1]
    prev = closes[-2]
    ema = calc_ema(closes, ema_period)
    rsi = calc_rsi(closes, rsi_period)
    dip_pct = (prev - last) / prev
    bump_pct = (last - prev) / prev

    trend_ok = True
    if trend_ema_period > 0:
        trend_ema = calc_ema(closes, trend_ema_period)
        trend_ema_prev = calc_ema(closes[: len(closes) - trend_slope_bars], trend_ema_period)
        slope_pct = (trend_ema - trend_ema_prev) / trend_ema_prev
        trend_ok = slope_pct >= -trend_max_down_pct

    atr_ok = True
    if min_atr_pct > 0:
        atr_ok = calc_atr_pct(candles, 14) >= min_atr_pct

    if last > ema and dip_pct >= min_dip and min_rsi <= rsi <= max_rsi and trend_ok and atr_ok:
        return {"signal": "buy", "reason": "bull-trend micro-dip", "last": last, "ema": ema, "rsi": rsi, "dipPct": dip_pct}
    if last < ema and bump_pct >= min_dip and min_rsi <= rsi <= max_rsi and trend_ok and atr_ok:
        return {"signal": "sell", "reason": "bear-trend micro-bounce", "last": last, "ema": ema, "rsi": rsi, "bumpPct": bump_pct}
    blocked = "downtrend filter" if not trend_ok else ("low volatility" if not atr_ok else "no micro setup")
    return {"signal": "flat", "reason": blocked, "last": last, "ema": ema, "rsi": rsi}


def turbo_reversion_signal(candles: list[Candle], opts: dict | None = None) -> dict:
    opts = opts or {}
    bb_len = opts.get("bb_len", 20)
    bb_mult = opts.get("bb_mult", 1.8)
    rsi_len = opts.get("rsi_len", 14)
    rsi_limit = opts.get("rsi_limit", 35)
    vol_mult = opts.get("vol_mult", 1.3)
    trend_ema_period = opts.get("trend_ema_period", 0)
    trend_slope_bars = opts.get("trend_slope_bars", 5)
    trend_max_down_pct = opts.get("trend_max_down_pct", 0)
    min_atr_pct = opts.get("min_atr_pct", 0)

    if len(candles) < max(bb_len, rsi_len, trend_ema_period) + 2:
        return {"signal": "flat", "reason": "not enough bars"}

    closes = [c["close"] for c in candles]
    vols = [_vol(c) for c in candles]
    last = closes[-1]
    last_vol = vols[-1]
    bb = calc_bb(closes, bb_len, bb_mult)
    rsi = calc_rsi(closes, rsi_len)
    vol_slice = vols[max(0, len(vols) - 20):]
    avg_vol = (sum(vol_slice) / len(vol_slice)) or 1
    is_oversold = last < bb["lower"] and rsi < rsi_limit
    is_vol_spike = last_vol > avg_vol * vol_mult

    trend_ok = True
    if trend_ema_period > 0:
        ema_now = calc_ema(closes, trend_ema_period)
        ema_prev = calc_ema(closes[: len(closes) - trend_slope_bars], trend_ema_period)
        slope_pct = (ema_now - ema_prev) / ema_prev
        trend_ok = slope_pct >= -trend_max_down_pct

    atr_ok = True
    if min_atr_pct > 0:
        atr_ok = calc_atr_pct(candles, 14) >= min_atr_pct

    if is_oversold and is_vol_spike and trend_ok and atr_ok:
        return {"signal": "buy", "reason": "turbo-reversion-bottom", "last": last, "lower": bb["lower"], "rsi": rsi}
    if last > bb["upper"]:
        return {"signal": "sell", "reason": "turbo-reversion-top", "last": last, "upper": bb["upper"], "rsi": rsi}
    blocked = "downtrend filter" if not trend_ok else ("low volatility" if not atr_ok else "no turbo setup")
    return {"signal": "flat", "reason": blocked, "last": last, "lower": bb["lower"], "rsi": rsi}
