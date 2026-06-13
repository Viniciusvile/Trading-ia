"""Port PURO dos indicadores e gatilhos do MasterBot (masterbot/bot.js).

ATENCAO: os indicadores do MasterBot DIFEREM dos do scalper (scalper_signals.py):
- calc_ema aqui usa SEED por SMA dos primeiros `period` valores (bot.js),
  enquanto o do scalper inicia em closes[0]. NAO reaproveitar entre os dois.
- calc_atr aqui retorna valor ABSOLUTO (nao %), com janela especifica.

Funcoes determinISticas, testadas em tests/test_masterbot_signals.py contra
valores capturados do bot.js legado.
"""
from __future__ import annotations
from datetime import datetime, timezone

Candle = dict  # {open, high, low, close, volume, time(ms)}


def calc_ema(closes: list[float], period: int) -> float:
    """EMA com seed SMA dos primeiros `period` valores (igual ao bot.js)."""
    if len(closes) < period:
        # bot.js: reduce sobre slice(0,period) — com poucos dados ainda calcula a media parcial
        seed = sum(closes[:period]) / period if closes else 0.0
        return seed
    mult = 2 / (period + 1)
    ema = sum(closes[:period]) / period
    for i in range(period, len(closes)):
        ema = closes[i] * mult + ema * (1 - mult)
    return ema


def calc_rsi(closes: list[float], period: int = 14) -> float:
    """RSI do bot.js: ganhos/perdas medios na janela completa (Wilder simples)."""
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


def calc_atr(candles: list[Candle], period: int = 14) -> float | None:
    """ATR absoluto (bot.js): media dos `period` ultimos True Ranges."""
    if len(candles) <= period:
        return None
    trs = []
    for i in range(1, len(candles)):
        high = candles[i]["high"]
        low = candles[i]["low"]
        prev_close = candles[i - 1]["close"]
        trs.append(max(high - low, abs(high - prev_close), abs(low - prev_close)))
    return sum(trs[len(trs) - period:]) / period


def calc_vwap(candles: list[Candle], now_ms: int | None = None) -> float | None:
    """VWAP da sessao (reseta a meia-noite UTC), igual ao bot.js."""
    if now_ms is None:
        now_ms = candles[-1]["time"]
    midnight = datetime.fromtimestamp(now_ms / 1000, tz=timezone.utc).replace(
        hour=0, minute=0, second=0, microsecond=0
    )
    midnight_ms = int(midnight.timestamp() * 1000)
    session = [c for c in candles if c["time"] >= midnight_ms]
    if not session:
        return None
    cum_tpv = sum(((c["high"] + c["low"] + c["close"]) / 3) * c["volume"] for c in session)
    cum_vol = sum(c["volume"] for c in session)
    return None if cum_vol == 0 else cum_tpv / cum_vol


# Pisos minimos (bot.js)
MIN_SL_PCT = 0.005
MIN_TP_PCT = 0.008


def calc_plan_stop_tp(price: float, atr: float, plan: dict, side: str = "LONG") -> dict:
    """Calcula stop/tp conforme o plano (multiplos formatos), igual ao bot.js."""
    dir_ = 1 if side == "LONG" else -1
    sl = plan.get("sl") or {}
    tp = plan.get("tp") or {}

    if plan.get("sl_atr_mult") is not None:
        stop = price - dir_ * atr * plan["sl_atr_mult"]
    elif sl.get("type") == "pct":
        stop = price * (1 - dir_ * sl["value"] / 100)
    elif sl.get("multiplier") is not None:
        stop = price - dir_ * atr * sl["multiplier"]
    else:
        stop = price - dir_ * atr * 1.5

    if plan.get("tp_atr_mult") is not None:
        tpp = price + dir_ * atr * plan["tp_atr_mult"]
    elif tp.get("type") == "trail":
        tpp = price * (1 + dir_ * 10 / 100)
    elif tp.get("type") == "pct":
        tpp = price * (1 + dir_ * tp["value"] / 100)
    elif tp.get("multiplier") is not None:
        tpp = price + dir_ * atr * tp["multiplier"]
    else:
        tpp = price + dir_ * atr * 2.0

    if side == "LONG":
        min_stop = price * (1 - MIN_SL_PCT)
        min_tp = price * (1 + MIN_TP_PCT)
        if stop > min_stop:
            stop = min_stop
        if tpp < min_tp:
            tpp = min_tp

    return {"stop": stop, "tp": tpp}


def run_safety_check_warrior(candles: list[Candle], now_ms: int | None = None) -> dict:
    """Gatilho 'warrior' (long-only, seguidor de tendencia), igual ao bot.js.

    3 condicoes: preco > VWAP, EMA9 > EMA20, RSI14 >= 45.
    """
    if now_ms is None:
        now_ms = candles[-1]["time"]
    price = candles[-1]["close"]
    closes = [c["close"] for c in candles]
    ema9 = calc_ema(closes, 9)
    ema20 = calc_ema(closes, 20)
    vwap = calc_vwap(candles, now_ms)
    rsi14 = calc_rsi(closes, 14)

    results = [
        {"label": "Preço acima do VWAP", "pass": (price > vwap) if vwap else False},
        {"label": "EMA(9) > EMA(20)", "pass": (ema9 > ema20) if (ema9 and ema20) else False},
        {"label": "RSI > 45 (Momentum)", "pass": (rsi14 >= 45) if rsi14 else False},
    ]
    all_pass = all(r["pass"] for r in results)
    atr = calc_atr(candles, 14)
    stop_price = price - atr * 1.5 if atr else price * 0.985
    return {
        "results": results,
        "allPass": all_pass,
        "side": "LONG" if all_pass else None,
        "stopPrice": stop_price,
        "indicators": {"ema9": ema9, "ema20": ema20, "vwap": vwap, "rsi14": rsi14},
    }
