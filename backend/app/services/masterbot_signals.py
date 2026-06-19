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


# ─── Medias em SERIE (alinhadas a `values`, na = None) — para gatilhos de cruzamento ───
# Fieis ao Pine: ta.sma / ta.ema / ta.rma / ta.wma / ta.hma.

def sma_series(values: list[float], period: int) -> list[float | None]:
    out: list[float | None] = [None] * len(values)
    if period <= 0:
        return out
    run = 0.0
    for i, v in enumerate(values):
        run += v
        if i >= period:
            run -= values[i - period]
        if i >= period - 1:
            out[i] = run / period
    return out


def ema_series(values: list[float], period: int) -> list[float | None]:
    """ta.ema: seed = SMA(period) na barra period-1, depois recursivo."""
    out: list[float | None] = [None] * len(values)
    if period <= 0 or len(values) < period:
        return out
    mult = 2 / (period + 1)
    ema = sum(values[:period]) / period
    out[period - 1] = ema
    for i in range(period, len(values)):
        ema = values[i] * mult + ema * (1 - mult)
        out[i] = ema
    return out


def rma_series(values: list[float], period: int) -> list[float | None]:
    """ta.rma (Wilder): alpha=1/period, seed = SMA(period)."""
    out: list[float | None] = [None] * len(values)
    if period <= 0 or len(values) < period:
        return out
    alpha = 1.0 / period
    rma = sum(values[:period]) / period
    out[period - 1] = rma
    for i in range(period, len(values)):
        rma = alpha * values[i] + (1 - alpha) * rma
        out[i] = rma
    return out


def wma_series(values: list[float], period: int) -> list[float | None]:
    """ta.wma: pesos lineares (period, period-1, ..., 1)."""
    out: list[float | None] = [None] * len(values)
    if period <= 0 or len(values) < period:
        return out
    denom = period * (period + 1) / 2.0
    for i in range(period - 1, len(values)):
        s = 0.0
        for k in range(period):
            # peso maior para o valor mais recente (Pine: ultimo = peso `period`)
            s += values[i - k] * (period - k)
        out[i] = s / denom
    return out


def hma_series(values: list[float], period: int) -> list[float | None]:
    """ta.hma: WMA(2*WMA(n/2) - WMA(n), round(sqrt(n)))."""
    import math
    out: list[float | None] = [None] * len(values)
    if period <= 1 or len(values) < period:
        return out
    half = max(1, period // 2)
    sqrt_n = max(1, round(math.sqrt(period)))
    wma_half = wma_series(values, half)
    wma_full = wma_series(values, period)
    diff_vals: list[float] = []
    idx_map: list[int] = []
    for i in range(len(values)):
        if wma_half[i] is not None and wma_full[i] is not None:
            diff_vals.append(2 * wma_half[i] - wma_full[i])
            idx_map.append(i)
    if len(diff_vals) < sqrt_n:
        return out
    hma_of_diff = wma_series(diff_vals, sqrt_n)
    for j, i in enumerate(idx_map):
        if hma_of_diff[j] is not None:
            out[i] = hma_of_diff[j]
    return out


def ma_series(kind: str, values: list[float], period: int) -> list[float | None]:
    """Despacha por tipo de media (ema/sma/rma/wma/hma)."""
    k = (kind or "ema").lower()
    if k == "sma":
        return sma_series(values, period)
    if k == "rma":
        return rma_series(values, period)
    if k == "wma":
        return wma_series(values, period)
    if k == "hma":
        return hma_series(values, period)
    return ema_series(values, period)


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
    elif sl.get("type") == "trail":
        val = sl.get("value") or 1.5
        stop = price * (1 - dir_ * val / 100)
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


# Defaults do "State-aware MA Cross Strategy" (© chikaharu) — valores fixos do script.
_STATE_MA_DEFAULTS = {
    "base_period": 20,
    # estado: [tipo_short, periodo_short, tipo_long, periodo_long]
    "s00_short_type": "ema", "s00_short_len": 15, "s00_long_type": "hma", "s00_long_len": 24,
    "s01_short_type": "sma", "s01_short_len": 19, "s01_long_type": "rma", "s01_long_len": 45,
    "s10_short_type": "rma", "s10_short_len": 16, "s10_long_type": "hma", "s10_long_len": 59,
    "s11_short_type": "rma", "s11_short_len": 12, "s11_long_type": "rma", "s11_long_len": 36,
}


def run_safety_check_state_ma_cross(candles: list[Candle], plan_filters: dict | None = None) -> dict:
    """Gatilho 'state-ma-cross' — port do 'State-aware MA Cross Strategy' (© chikaharu).

    1) Define o ESTADO de mercado por base EMA(20): slope (sobe/desce) x preco (acima/abaixo).
       state = slope_up ? (above?'11':'10') : (above?'01':'00')
    2) Cada estado usa um PAR de medias (short/long) de tipos diferentes (ema/sma/rma/hma).
    3) ENTRA LONG no crossover(short, long). O crossunder fecha posicao (saida via SL/TP
       do motor; o motor nao tem saida por sinal, ver warning no backtest).

    Params (filters) sobrescrevem os defaults do script (_STATE_MA_DEFAULTS).
    """
    pf = {**_STATE_MA_DEFAULTS, **(plan_filters or {})}
    closes = [c["close"] for c in candles]
    base_period = int(pf["base_period"])

    # historico minimo: maior periodo usado + folga p/ HMA e p/ comparar 2 barras
    max_len = max(int(pf[f"s{st}_{side}_len"]) for st in ("00", "01", "10", "11") for side in ("short", "long"))
    need = max(max_len, base_period) + 10
    if len(closes) < need:
        return {"results": [{"label": "Dados insuficientes", "pass": False}],
                "allPass": False, "side": None, "stopPrice": None, "takeProfitPrice": None,
                "indicators": {}}

    base = ema_series(closes, base_period)
    i = len(closes) - 1
    if base[i] is None or base[i - 1] is None:
        return {"results": [{"label": "Base MA indisponível", "pass": False}],
                "allPass": False, "side": None, "stopPrice": None, "takeProfitPrice": None,
                "indicators": {}}

    def state_at(idx: int) -> str:
        slope_up = (base[idx] - base[idx - 1]) > 0
        above = closes[idx] > base[idx]
        if slope_up:
            return "11" if above else "10"
        return "01" if above else "00"

    # Estado calculado na barra atual e na anterior (igual ao Pine, que usa o estado corrente).
    st_now = state_at(i)
    st_prev = state_at(i - 1)

    def ma_pair(state: str):
        s = ma_series(pf[f"s{state}_short_type"], closes, int(pf[f"s{state}_short_len"]))
        l = ma_series(pf[f"s{state}_long_type"], closes, int(pf[f"s{state}_long_len"]))
        return s, l

    s_now, l_now = ma_pair(st_now)
    s_prev_series, l_prev_series = ma_pair(st_prev)

    if None in (s_now[i], l_now[i], s_prev_series[i - 1], l_prev_series[i - 1]):
        return {"results": [{"label": "Médias indisponíveis", "pass": False}],
                "allPass": False, "side": None, "stopPrice": None, "takeProfitPrice": None,
                "indicators": {"state": st_now}}

    # crossover(short, long): short estava <= long e agora está > long.
    cross_up = s_prev_series[i - 1] <= l_prev_series[i - 1] and s_now[i] > l_now[i]
    cross_down = s_prev_series[i - 1] >= l_prev_series[i - 1] and s_now[i] < l_now[i]

    side = "LONG" if cross_up else None
    results = [
        {"label": f"Estado de mercado: {st_now}", "pass": True},
        {"label": "MA curta cruzou ACIMA da MA longa", "pass": cross_up},
    ]
    if cross_down:
        results.append({"label": "MA curta cruzou ABAIXO (sinal de saída)", "pass": False})

    return {
        "results": results,
        "allPass": side is not None,
        "side": side,
        "stopPrice": None,
        "takeProfitPrice": None,
        "indicators": {"state": st_now, "shortMA": s_now[i], "longMA": l_now[i]},
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


def calc_macd(closes: list[float], fast_period: int = 12, slow_period: int = 26, signal_period: int = 9) -> dict | None:
    if len(closes) < max(fast_period, slow_period) + signal_period:
        return None
    fast_ema_arr = ema_series(closes, fast_period)
    slow_ema_arr = ema_series(closes, slow_period)
    
    macd_vals = []
    for f, s in zip(fast_ema_arr, slow_ema_arr):
        if f is not None and s is not None:
            macd_vals.append(f - s)
        else:
            macd_vals.append(None)
            
    valid_macd = [v for v in macd_vals if v is not None]
    if len(valid_macd) < signal_period:
        return None
    signal_ema_arr = ema_series(valid_macd, signal_period)
    padded_signal = [None] * (len(macd_vals) - len(signal_ema_arr)) + signal_ema_arr
    
    macd_val = macd_vals[-1]
    signal_val = padded_signal[-1]
    if macd_val is None or signal_val is None:
        return None
        
    hist = macd_val - signal_val
    prev_macd_val = macd_vals[-2]
    prev_signal_val = padded_signal[-2]
    prev_hist = None
    if prev_macd_val is not None and prev_signal_val is not None:
        prev_hist = prev_macd_val - prev_signal_val
        
    return {"macd": macd_val, "signal": signal_val, "hist": hist, "prev_hist": prev_hist}


def calc_bollinger(closes: list[float], period: int = 20, mult: float = 2.0) -> dict | None:
    if len(closes) < period:
        return None
    subset = closes[-period:]
    basis = sum(subset) / period
    import math
    variance = sum((x - basis) ** 2 for x in subset) / period
    std_dev = math.sqrt(variance)
    upper = basis + mult * std_dev
    lower = basis - mult * std_dev
    price = closes[-1]
    pct_b = (price - lower) / (upper - lower) if upper != lower else 0.5
    width = upper - lower
    compressed = (width / basis) < 0.05 if basis != 0 else False
    return {"basis": basis, "upper": upper, "lower": lower, "pct_b": pct_b, "compressed": compressed}


def calc_supertrend(candles: list[Candle], period: int = 10, mult: float = 3.0) -> dict | None:
    if len(candles) < period + 1:
        return None
    trs = []
    for i in range(1, len(candles)):
        h = candles[i]["high"]
        l = candles[i]["low"]
        pc = candles[i - 1]["close"]
        trs.append(max(h - l, abs(h - pc), abs(l - pc)))
    
    if len(trs) < period:
        return None
        
    atr_vals = rma_series(trs, period)
    n = len(candles)
    final_upper = [0.0] * n
    final_lower = [0.0] * n
    trend = [1] * n
    
    start_idx = period + 1
    if start_idx >= n:
        return None
        
    for i in range(start_idx, n):
        h = candles[i]["high"]
        l = candles[i]["low"]
        c = candles[i]["close"]
        hl2 = (h + l) / 2.0
        atr = atr_vals[i - 1]
        if atr is None:
            continue
            
        basic_upper = hl2 + mult * atr
        basic_lower = hl2 - mult * atr
        
        prev_close = candles[i - 1]["close"]
        prev_upper = final_upper[i - 1]
        prev_lower = final_lower[i - 1]
        prev_trend = trend[i - 1]
        
        if basic_upper < prev_upper or prev_close > prev_upper:
            final_upper[i] = basic_upper
        else:
            final_upper[i] = prev_upper
            
        if basic_lower > prev_lower or prev_close < prev_lower:
            final_lower[i] = basic_lower
        else:
            final_lower[i] = prev_lower
            
        if c > final_upper[i]:
            trend[i] = 1
        elif c < final_lower[i]:
            trend[i] = -1
        else:
            trend[i] = prev_trend
            
    return {"trend": trend[-1], "upper": final_upper[-1], "lower": final_lower[-1]}


def apply_plan_filters(candles: list[Candle], plan: dict) -> list[dict]:
    """Port de applyPlanFilters (bot.js) — Com suporte para todas as regras customizadas:
    ema_triple, adx_min/adx_max, di_direction, rsi_min/rsi_max, volume_mult,
    volume_max_mult, choppiness_min, macd_positive, macd_growing, bb_range,
    bb_pct_b_min, bb_pct_b_max, rsi_range_mid, supertrend.
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
            extra.append({"label": f"ADX <= {f['adx_max']}", "pass": di is not None and di["adx"] <= f["adx_max"]})
        if f.get("di_direction"):
            extra.append({"label": "DI+ > DI-", "pass": di is not None and di["pdi"] > di["mdi"]})

    if f.get("rsi_min") is not None or f.get("rsi_max") is not None:
        rsi = calc_rsi(closes, int(f.get("rsi_period", 14)))
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

    # MACD
    if f.get("macd_positive") or f.get("macd_growing"):
        macd = calc_macd(closes)
        if f.get("macd_positive"):
            extra.append({"label": "MACD > 0", "pass": macd is not None and macd["hist"] > 0})
        if f.get("macd_growing"):
            extra.append({"label": "MACD Acelerando", "pass": macd is not None and macd["prev_hist"] is not None and macd["hist"] > macd["prev_hist"]})

    # Bollinger Bands
    if f.get("bb_range") or f.get("bb_pct_b_min") is not None or f.get("bb_pct_b_max") is not None:
        period = int(f.get("bb_period", 20))
        mult = float(f.get("bb_mult", 2.0))
        bb = calc_bollinger(closes, period, mult)
        if f.get("bb_range"):
            extra.append({"label": "Bollinger Comprimido", "pass": bb is not None and bb["compressed"]})
        if f.get("bb_pct_b_min") is not None:
            extra.append({"label": f"%B >= {f['bb_pct_b_min']}", "pass": bb is not None and bb["pct_b"] >= float(f["bb_pct_b_min"])})
        if f.get("bb_pct_b_max") is not None:
            extra.append({"label": f"%B <= {f['bb_pct_b_max']}", "pass": bb is not None and bb["pct_b"] <= float(f["bb_pct_b_max"])})

    # RSI range mid
    if f.get("rsi_range_mid"):
        rsi = calc_rsi(closes, int(f.get("rsi_period", 14)))
        extra.append({"label": "RSI Neutro (40-60)", "pass": rsi is not None and 40 <= rsi <= 60})

    # Supertrend
    if f.get("supertrend_period") is not None or f.get("supertrend_mult") is not None:
        period = int(f.get("supertrend_period", 10))
        mult = float(f.get("supertrend_mult", 3.0))
        st = calc_supertrend(candles, period, mult)
        if st is not None:
            extra.append({"label": f"Supertrend ({period},{mult})", "pass": st["trend"] == 1})

    return extra


# ─── FASE 2: Novos indicadores (Gargalo 3) ─────────────────────────────────
#
# 10 indicadores populares do TradingView que estavam faltando no motor.
# Cada um é puro Python (sem pandas), seguindo as fórmulas padrão do TV.


def calc_stoch_rsi(closes: list[float], rsi_period: int = 14,
                   stoch_period: int = 14, k_smooth: int = 3,
                   d_smooth: int = 3) -> dict | None:
    """Stochastic RSI — RSI normalizado entre 0-100 como um estocástico.

    Retorna {"k": float, "d": float} ou None se dados insuficientes.
    """
    need = rsi_period + stoch_period + max(k_smooth, d_smooth)
    if len(closes) < need:
        return None

    # Calcula série de RSI para os últimos (stoch_period + k_smooth + d_smooth) candles
    rsi_values: list[float] = []
    for i in range(stoch_period + k_smooth + d_smooth):
        end = len(closes) - (stoch_period + k_smooth + d_smooth) + i + 1
        rsi_values.append(calc_rsi(closes[:end], rsi_period))

    # Estocástico sobre RSI
    raw_k: list[float] = []
    for i in range(stoch_period - 1, len(rsi_values)):
        window = rsi_values[i - stoch_period + 1: i + 1]
        hi, lo = max(window), min(window)
        raw_k.append(((rsi_values[i] - lo) / (hi - lo) * 100) if hi != lo else 50.0)

    # Suaviza %K com SMA
    k_vals = sma_series(raw_k, k_smooth)
    k = k_vals[-1] if k_vals and k_vals[-1] is not None else None
    # %D = SMA de %K
    k_clean = [v for v in k_vals if v is not None]
    d_vals = sma_series(k_clean, d_smooth) if len(k_clean) >= d_smooth else []
    d = d_vals[-1] if d_vals and d_vals[-1] is not None else k

    if k is None:
        return None
    return {"k": k, "d": d if d is not None else k}


def calc_cci(candles: list[Candle], period: int = 20) -> float | None:
    """Commodity Channel Index — mede desvio do preço típico vs média."""
    if len(candles) < period:
        return None
    tp = [(c["high"] + c["low"] + c["close"]) / 3 for c in candles[-period:]]
    mean_tp = sum(tp) / period
    mean_dev = sum(abs(t - mean_tp) for t in tp) / period
    if mean_dev == 0:
        return 0.0
    return (tp[-1] - mean_tp) / (0.015 * mean_dev)


def calc_williams_r(candles: list[Candle], period: int = 14) -> float | None:
    """Williams %R — oscilador momentum entre -100 e 0."""
    if len(candles) < period:
        return None
    window = candles[-period:]
    highest = max(c["high"] for c in window)
    lowest = min(c["low"] for c in window)
    if highest == lowest:
        return -50.0
    return ((highest - candles[-1]["close"]) / (highest - lowest)) * -100


def calc_obv(candles: list[Candle]) -> float:
    """On-Balance Volume — acumula volume por direção do preço."""
    if not candles:
        return 0.0
    obv = 0.0
    for i in range(1, len(candles)):
        vol = candles[i].get("volume", candles[i].get("vol", 0)) or 0
        if candles[i]["close"] > candles[i - 1]["close"]:
            obv += vol
        elif candles[i]["close"] < candles[i - 1]["close"]:
            obv -= vol
    return obv


def calc_mfi(candles: list[Candle], period: int = 14) -> float | None:
    """Money Flow Index — RSI ponderado por volume (0-100)."""
    if len(candles) < period + 1:
        return None
    pos_flow = 0.0
    neg_flow = 0.0
    for i in range(len(candles) - period, len(candles)):
        tp_curr = (candles[i]["high"] + candles[i]["low"] + candles[i]["close"]) / 3
        tp_prev = (candles[i - 1]["high"] + candles[i - 1]["low"] + candles[i - 1]["close"]) / 3
        vol = candles[i].get("volume", candles[i].get("vol", 0)) or 0
        raw = tp_curr * vol
        if tp_curr > tp_prev:
            pos_flow += raw
        elif tp_curr < tp_prev:
            neg_flow += raw
    if neg_flow == 0:
        return 100.0
    if pos_flow == 0:
        return 0.0
    ratio = pos_flow / neg_flow
    return 100 - 100 / (1 + ratio)


def calc_cmf(candles: list[Candle], period: int = 20) -> float | None:
    """Chaikin Money Flow — mede pressão de compra/venda."""
    if len(candles) < period:
        return None
    window = candles[-period:]
    mf_vol_sum = 0.0
    vol_sum = 0.0
    for c in window:
        hl = c["high"] - c["low"]
        vol = c.get("volume", c.get("vol", 0)) or 0
        clv = ((c["close"] - c["low"]) - (c["high"] - c["close"])) / hl if hl != 0 else 0
        mf_vol_sum += clv * vol
        vol_sum += vol
    if vol_sum == 0:
        return 0.0
    return mf_vol_sum / vol_sum


def calc_vwma(candles: list[Candle], period: int = 20) -> float | None:
    """Volume-Weighted Moving Average."""
    if len(candles) < period:
        return None
    window = candles[-period:]
    sum_cv = sum(c["close"] * (c.get("volume", c.get("vol", 0)) or 0) for c in window)
    sum_v = sum((c.get("volume", c.get("vol", 0)) or 0) for c in window)
    if sum_v == 0:
        return None
    return sum_cv / sum_v


def calc_pivot_points(candles: list[Candle]) -> dict | None:
    """Pivot Points tradicionais (baseado no candle anterior).

    Retorna {"pivot": float, "r1": float, "r2": float, "r3": float,
             "s1": float, "s2": float, "s3": float}.
    """
    if len(candles) < 2:
        return None
    prev = candles[-2]
    h, l, c = prev["high"], prev["low"], prev["close"]
    pivot = (h + l + c) / 3
    return {
        "pivot": pivot,
        "r1": 2 * pivot - l,
        "s1": 2 * pivot - h,
        "r2": pivot + (h - l),
        "s2": pivot - (h - l),
        "r3": h + 2 * (pivot - l),
        "s3": l - 2 * (h - pivot),
    }


def calc_parabolic_sar(candles: list[Candle], af_start: float = 0.02,
                       af_step: float = 0.02, af_max: float = 0.2) -> dict | None:
    """Parabolic SAR — stop-and-reverse trailing indicator.

    Retorna {"sar": float, "trend": 1 (bull) | -1 (bear)}.
    """
    if len(candles) < 3:
        return None

    # Inicializa
    trend = 1  # 1 = bull, -1 = bear
    sar = candles[0]["low"]
    ep = candles[0]["high"]  # extreme point
    af = af_start

    for i in range(1, len(candles)):
        prev_sar = sar
        sar = prev_sar + af * (ep - prev_sar)

        if trend == 1:
            # Limite: SAR não pode estar acima dos últimos 2 lows
            if i >= 2:
                sar = min(sar, candles[i - 1]["low"], candles[i - 2]["low"])
            else:
                sar = min(sar, candles[i - 1]["low"])

            if candles[i]["low"] < sar:
                # Reversal → bear
                trend = -1
                sar = ep
                ep = candles[i]["low"]
                af = af_start
            else:
                if candles[i]["high"] > ep:
                    ep = candles[i]["high"]
                    af = min(af + af_step, af_max)
        else:
            # Bear: SAR não pode estar abaixo dos últimos 2 highs
            if i >= 2:
                sar = max(sar, candles[i - 1]["high"], candles[i - 2]["high"])
            else:
                sar = max(sar, candles[i - 1]["high"])

            if candles[i]["high"] > sar:
                # Reversal → bull
                trend = 1
                sar = ep
                ep = candles[i]["high"]
                af = af_start
            else:
                if candles[i]["low"] < ep:
                    ep = candles[i]["low"]
                    af = min(af + af_step, af_max)

    return {"sar": sar, "trend": trend}


def calc_ichimoku(candles: list[Candle], tenkan_period: int = 9,
                  kijun_period: int = 26, senkou_b_period: int = 52) -> dict | None:
    """Ichimoku Cloud — componentes principais.

    Retorna {"tenkan": float, "kijun": float, "senkou_a": float,
             "senkou_b": float, "chikou": float,
             "cloud_top": float, "cloud_bottom": float,
             "price_above_cloud": bool}.
    """
    need = max(tenkan_period, kijun_period, senkou_b_period)
    if len(candles) < need + kijun_period:
        return None

    def mid(period: int, end_idx: int) -> float:
        window = candles[end_idx - period + 1: end_idx + 1]
        return (max(c["high"] for c in window) + min(c["low"] for c in window)) / 2

    last = len(candles) - 1
    tenkan = mid(tenkan_period, last)
    kijun = mid(kijun_period, last)

    # Senkou Span A e B são calculados com deslocamento de kijun_period para frente,
    # mas aqui mostramos o valor ATUAL da nuvem (kijun_period barras atrás no cálculo)
    senkou_a_idx = last - kijun_period
    if senkou_a_idx >= max(tenkan_period, kijun_period) - 1:
        sa_tenkan = mid(tenkan_period, senkou_a_idx)
        sa_kijun = mid(kijun_period, senkou_a_idx)
        senkou_a = (sa_tenkan + sa_kijun) / 2
    else:
        senkou_a = (tenkan + kijun) / 2

    senkou_b_idx = last - kijun_period
    if senkou_b_idx >= senkou_b_period - 1:
        senkou_b = mid(senkou_b_period, senkou_b_idx)
    else:
        senkou_b = mid(senkou_b_period, last)

    cloud_top = max(senkou_a, senkou_b)
    cloud_bottom = min(senkou_a, senkou_b)
    price = candles[-1]["close"]

    # Chikou Span = close deslocado kijun_period para trás
    chikou_idx = last - kijun_period
    chikou = candles[chikou_idx]["close"] if chikou_idx >= 0 else price

    return {
        "tenkan": tenkan,
        "kijun": kijun,
        "senkou_a": senkou_a,
        "senkou_b": senkou_b,
        "chikou": chikou,
        "cloud_top": cloud_top,
        "cloud_bottom": cloud_bottom,
        "price_above_cloud": price > cloud_top,
    }
