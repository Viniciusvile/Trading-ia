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


def calc_stochastic(candles: list[Candle], k_period: int = 14, d_period: int = 3) -> dict | None:
    """Stochastic (%K/%D + valores previos), igual ao bot.js."""
    if len(candles) < k_period + d_period:
        return None

    def get_k(subset: list[Candle]) -> float:
        close = subset[-1]["close"]
        high = max(c["high"] for c in subset)
        low = min(c["low"] for c in subset)
        return 50.0 if high == low else ((close - low) / (high - low)) * 100

    ks = []
    for i in range(len(candles) - d_period - 1, len(candles)):
        ks.append(get_k(candles[i - k_period + 1: i + 1]))

    k = ks[-1]
    d = sum(ks[-d_period:]) / d_period
    prev_k = ks[-2]
    prev_d = sum(ks[-d_period - 1: -1]) / d_period
    return {"k": k, "d": d, "prevK": prev_k, "prevD": prev_d}


def run_safety_check_range_v2(candles: list[Candle], plan_filters: dict | None = None) -> dict:
    """Gatilho 'range-v2' (mean reversion com S/R), igual ao bot.js.

    LONG: preco perto do suporte + RSI baixo + stoch K<30 com cross up.
    SHORT: espelho na resistencia. Valida R:R minimo (rejeita se baixo).
    """
    pf = plan_filters or {}
    last = candles[-1]
    price = last["close"]
    closes = [c["close"] for c in candles]
    atr = calc_atr(candles, 14)
    rsi = calc_rsi(closes, 14)
    stoch = calc_stochastic(candles, 14, 3)

    sr_bars = pf.get("sr_bars", 24)
    sr_atr_mult = pf.get("sr_atr_mult", 1.5)
    sr_window = candles[-sr_bars:]
    resistance = max(c["high"] for c in sr_window)
    support = min(c["low"] for c in sr_window)

    side = None
    stop_price = None
    take_profit_price = None

    is_rsi_long = rsi is not None and rsi < pf.get("rsi_long_max", 42)
    is_rsi_short = rsi is not None and rsi > pf.get("rsi_short_min", 58)
    is_stoch_long = (
        stoch is not None and stoch["k"] < pf.get("stoch_k_long_max", 30)
        and stoch["k"] > stoch["d"] and stoch["prevK"] <= stoch["prevD"]
    )
    is_stoch_short = (
        stoch is not None and stoch["k"] > pf.get("stoch_k_short_min", 70)
        and stoch["k"] < stoch["d"] and stoch["prevK"] >= stoch["prevD"]
    )

    entry_atr_buffer = (atr or 0) * sr_atr_mult
    in_long_zone = price <= support + entry_atr_buffer
    in_short_zone = price >= resistance - entry_atr_buffer

    if in_long_zone and is_rsi_long and is_stoch_long:
        side = "LONG"
        stop_price = support - (atr * 0.3)
        take_profit_price = resistance - (atr * 0.3)
    elif in_short_zone and is_rsi_short and is_stoch_short:
        side = "SHORT"
        stop_price = resistance + (atr * 0.3)
        take_profit_price = support + (atr * 0.3)

    results = [
        {"label": "RSI", "pass": (side == "LONG" and is_rsi_long) or (side == "SHORT" and is_rsi_short)
         or (side is None and (is_rsi_long or is_rsi_short))},
        {"label": "Stoch", "pass": (side == "LONG" and is_stoch_long) or (side == "SHORT" and is_stoch_short)
         or (side is None and (is_stoch_long or is_stoch_short))},
        {"label": "Zona", "pass": (side == "LONG" and in_long_zone) or (side == "SHORT" and in_short_zone)
         or (side is None and (in_long_zone or in_short_zone))},
    ]

    if side and stop_price is not None and take_profit_price is not None:
        risk = abs(price - stop_price)
        reward = abs(take_profit_price - price)
        rr = reward / risk if risk > 0 else 0
        min_rr = pf.get("min_rr", 1.5)
        rr_pass = rr >= min_rr
        results.append({"label": "RR", "pass": rr_pass})
        if not rr_pass:
            side = None

    all_pass = all(r["pass"] for r in results) and bool(side)
    return {
        "results": results, "allPass": all_pass, "side": side,
        "stopPrice": stop_price, "takeProfitPrice": take_profit_price,
        "indicators": {"rsi": rsi, "stoch": stoch, "support": support, "resistance": resistance},
    }


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


def run_safety_check_volatility_envelope(candles: list[Candle], plan_filters: dict | None = None) -> dict:
    """Gatilho 'volatility-envelope' — port do indicador Adaptive Volatility Envelope
    [QuantAlgo]. Sinal nativo do script: ENTRA quando o momentum cruza zero.

    - centerline adaptativa via efficiency ratio de Kaufman (choppy vs trend speed)
    - momentum = slope(centerline)/ATR * sensibilidade, limitado a [-1, 1]
    - bullTurn: momentum cruza ACIMA de 0 -> LONG
    - bearTurn: momentum cruza ABAIXO de 0 -> SHORT (so em futures, via decide_signal)

    Parametros (com defaults do preset 'Default' do script):
      adapt_length=20, choppy_speed=0.05, trend_speed=0.85, vol_length=20, color_sens=8
    """
    pf = plan_filters or {}
    adapt_length = int(pf.get("adapt_length", 20))
    choppy_speed = float(pf.get("choppy_speed", 0.05))
    trend_speed = float(pf.get("trend_speed", 0.85))
    vol_length = int(pf.get("vol_length", 20))
    color_sens = float(pf.get("color_sens", 8.0))

    # Precisa de historico suficiente para o lookback e para um momentum estavel.
    need = adapt_length + vol_length + 5
    if len(candles) < need:
        return {"results": [{"label": "Dados insuficientes", "pass": False}],
                "allPass": False, "side": None, "stopPrice": None, "takeProfitPrice": None,
                "indicators": {}}

    closes = [c["close"] for c in candles]

    # Centerline adaptativa (recursiva), calculada em serie do bar adapt_length em diante.
    centerline: list[float | None] = [None] * len(closes)
    for i in range(len(closes)):
        if i < adapt_length:
            continue
        price_change = abs(closes[i] - closes[i - adapt_length])
        total_movement = sum(abs(closes[j] - closes[j - 1]) for j in range(i - adapt_length + 1, i + 1))
        eff_ratio = price_change / total_movement if total_movement != 0 else 0.0
        smoothing = choppy_speed + (trend_speed - choppy_speed) * eff_ratio
        prev = centerline[i - 1]
        centerline[i] = closes[i] if prev is None else prev + smoothing * (closes[i] - prev)

    def momentum_at(i: int) -> float | None:
        """slope(centerline)/ATR * sens, limitado a [-1,1] (espelha o Pine)."""
        c0, c2 = centerline[i], centerline[i - 2] if i >= 2 else None
        if c0 is None:
            return None
        c2 = c2 if c2 is not None else c0
        slope = (c0 - c2) / 2.0
        atr_i = calc_atr(candles[: i + 1], vol_length)
        if not atr_i:
            return 0.0
        raw = slope / atr_i * color_sens
        return max(-1.0, min(1.0, raw))

    mom_now = momentum_at(len(closes) - 1)
    mom_prev = momentum_at(len(closes) - 2)
    if mom_now is None or mom_prev is None:
        return {"results": [{"label": "Momentum indisponível", "pass": False}],
                "allPass": False, "side": None, "stopPrice": None, "takeProfitPrice": None,
                "indicators": {}}

    bull_turn = mom_prev <= 0 and mom_now > 0
    bear_turn = mom_prev >= 0 and mom_now < 0

    side = "LONG" if bull_turn else ("SHORT" if bear_turn else None)
    results = [
        {"label": "Momentum cruzou para cima (bull)", "pass": bull_turn},
        {"label": "Momentum cruzou para baixo (bear)", "pass": bear_turn},
    ]
    # allPass = houve um cruzamento (entrada). decide_signal aplica SL/TP do plano.
    all_pass = side is not None
    return {
        "results": results,
        "allPass": all_pass,
        "side": side,
        "stopPrice": None,
        "takeProfitPrice": None,
        "indicators": {"momentum": mom_now, "momentumPrev": mom_prev,
                       "centerline": centerline[-1]},
    }


# ─── Indicadores p/ filtros de plano (port de bot.js: calcADX, calcChoppiness) ───

def calc_adx(candles: list[Candle], period: int = 14) -> dict | None:
    """Port IDENTICO de calcADX (bot.js): retorna {adx, pdi, mdi}. Usa DX (nao a
    media classica de ADX) — fiel ao legado para os resultados baterem."""
    if len(candles) < period * 2:
        return None

    def smooth(arr: list[float], p: int) -> float:
        val = sum(arr[:p])
        for i in range(p, len(arr)):
            val = val - val / p + arr[i]
        return val

    plus_dm, minus_dm, trs = [], [], []
    for i in range(1, len(candles)):
        up = candles[i]["high"] - candles[i - 1]["high"]
        down = candles[i - 1]["low"] - candles[i]["low"]
        plus_dm.append(up if (up > down and up > 0) else 0)
        minus_dm.append(down if (down > up and down > 0) else 0)
        tr = max(candles[i]["high"] - candles[i]["low"],
                 abs(candles[i]["high"] - candles[i - 1]["close"]),
                 abs(candles[i]["low"] - candles[i - 1]["close"]))
        trs.append(tr)

    s_tr = smooth(trs, period)
    s_pdm = smooth(plus_dm, period)
    s_mdm = smooth(minus_dm, period)
    if s_tr == 0:
        return {"adx": 0, "pdi": 0, "mdi": 0}
    pdi = 100 * s_pdm / s_tr
    mdi = 100 * s_mdm / s_tr
    dx = 0 if (pdi + mdi) == 0 else 100 * abs(pdi - mdi) / (pdi + mdi)
    return {"adx": dx, "pdi": pdi, "mdi": mdi}


def calc_choppiness(candles: list[Candle], period: int = 14) -> float | None:
    """Port IDENTICO de calcChoppiness (bot.js)."""
    import math
    if len(candles) < period + 1:
        return None
    sl = candles[-period:]
    high = max(c["high"] for c in sl)
    low = min(c["low"] for c in sl)
    sum_tr = 0.0
    for i in range(len(candles) - period, len(candles)):
        c, prev = candles[i], candles[i - 1]
        sum_tr += max(c["high"] - c["low"],
                      abs(c["high"] - prev["close"]),
                      abs(c["low"] - prev["close"]))
    if high == low:
        return 100.0
    return 100 * (math.log10(sum_tr / (high - low)) / math.log10(period))


def apply_plan_filters(candles: list[Candle], plan: dict) -> list[dict]:
    """Port de applyPlanFilters (bot.js) — SO os filtros usados hoje pelas estrategias:
    ema_triple, adx_min/adx_max, di_direction, rsi_min/rsi_max, volume_mult,
    volume_max_mult, choppiness_min. Cada um vira {label, pass}.

    CRITICO: a signalFn do legado roda isto ANTES do safety check e exige que TODOS
    passem. Sem isto, o bot opera em regime errado (gera trades ruins demais).
    """
    f = (plan or {}).get("filters") or {}
    closes = [c["close"] for c in candles]
    extra: list[dict] = []

    if f.get("ema_triple"):
        e9, e21 = calc_ema(closes, 9), calc_ema(closes, 21)
        e55, e200 = calc_ema(closes, 55), calc_ema(closes, 200)
        extra.append({"label": "EMA9>EMA21>EMA55>EMA200", "pass": e9 > e21 > e55 > e200})

    if f.get("adx_min") is not None or f.get("adx_max") is not None or f.get("di_direction"):
        di = calc_adx(candles, 14)
        if f.get("adx_min") is not None:
            extra.append({"label": f"ADX >= {f['adx_min']}", "pass": di is not None and di["adx"] >= f["adx_min"]})
        if f.get("adx_max") is not None:
            # mercado lateral: ADX abaixo do maximo (sem tendencia forte)
            extra.append({"label": f"ADX <= {f['adx_max']}", "pass": di is not None and di["adx"] <= f["adx_max"]})
        if f.get("di_direction"):
            extra.append({"label": "DI+ > DI-", "pass": di is not None and di["pdi"] > di["mdi"]})

    if f.get("rsi_min") is not None or f.get("rsi_max") is not None:
        rsi = calc_rsi(closes, 14)
        mn, mx = f.get("rsi_min", 0), f.get("rsi_max", 100)
        extra.append({"label": f"RSI {mn}-{mx}", "pass": rsi is not None and mn <= rsi <= mx})

    if f.get("volume_mult") is not None:
        vols = [c.get("volume", c.get("vol", 0)) for c in candles]
        avg = sum(vols[-21:-1]) / 20 if len(vols) >= 21 else 0
        cur = vols[-1]
        extra.append({"label": f"Volume >= {f['volume_mult']}x", "pass": avg > 0 and cur >= avg * f["volume_mult"]})

    if f.get("volume_max_mult") is not None:
        vols = [c.get("volume", c.get("vol", 0)) for c in candles]
        avg = sum(vols[-21:-1]) / 20 if len(vols) >= 21 else 0
        cur = vols[-1]
        extra.append({"label": f"Volume <= {f['volume_max_mult']}x", "pass": avg > 0 and cur <= avg * f["volume_max_mult"]})

    if f.get("choppiness_min") is not None:
        chop = calc_choppiness(candles, 14)
        extra.append({"label": f"Choppiness >= {f['choppiness_min']}", "pass": chop is not None and chop >= f["choppiness_min"]})

    return extra
