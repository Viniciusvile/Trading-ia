from __future__ import annotations
import pandas as pd
from app.schemas.strategy import Condition
from app.services.indicators import get_indicator_value


def _parse_compare(spec: str) -> tuple[str, int]:
    """'EMA_21' -> ('EMA', 21). 'RSI' (sem período) usa default."""
    if "_" in spec:
        ind, period = spec.split("_", 1)
        return ind, int(period)
    return spec, 14


def _target(condition: Condition, prices: pd.Series, offset: int = 0) -> float:
    if condition.compare_to_indicator:
        ind, period = _parse_compare(condition.compare_to_indicator)
        series = prices.iloc[: len(prices) - offset] if offset else prices
        return get_indicator_value(ind, period, series)
    return float(condition.value) if condition.value is not None else 0.0


def evaluate_condition(condition: Condition, prices: pd.Series) -> bool:
    current = get_indicator_value(condition.indicator, condition.indicator_period, prices)
    target = _target(condition, prices)

    if condition.operator == "greater_than":
        return current > target
    if condition.operator == "less_than":
        return current < target
    if condition.operator in ("crosses_above", "crosses_below"):
        if len(prices) < 2:
            return False
        prev_prices = prices.iloc[:-1]
        prev = get_indicator_value(
            condition.indicator, condition.indicator_period, prev_prices
        )
        prev_target = _target(condition, prices, offset=1)
        if condition.operator == "crosses_above":
            return prev <= prev_target and current > target
        return prev >= prev_target and current < target
    return False


def evaluate_all_conditions(conditions: list[Condition], prices: pd.Series) -> bool:
    return all(evaluate_condition(c, prices) for c in conditions)


# ─── Motor candle-based (sem pandas) — para uso no MasterBot ───────────────
#
# Reusa os indicadores já portados em masterbot_signals.py (que são idênticos
# ao bot.js legado) em vez do indicators.py baseado em pandas, garantindo que
# o sinal ao vivo e o backtest usem a MESMA implementação numérica.

from app.services import masterbot_signals as mb

Candle = dict  # {open, high, low, close, volume, time}

# Rótulos legíveis (PT-BR) por indicador, para exibir nos cards de resultado.
_INDICATOR_LABELS = {
    "RSI": "RSI",
    "EMA": "EMA",
    "SMA": "SMA",
    "RMA": "RMA",
    "HMA": "HMA",
    "WMA": "WMA",
    "VWAP": "VWAP",
    "ATR": "ATR",
    "ATR_PCT": "ATR %",
    "ADX": "ADX",
    "PDI": "DI+",
    "MDI": "DI−",
    "MACD_HIST": "MACD Histograma",
    "MACD_LINE": "MACD Linha",
    "MACD_SIGNAL": "MACD Sinal",
    "BB_UPPER": "Bollinger Superior",
    "BB_LOWER": "Bollinger Inferior",
    "BB_BASIS": "Bollinger Média",
    "BB_PCT_B": "Bollinger %B",
    "SUPERTREND": "Supertrend",
    "STOCH_K": "Estocástico %K",
    "STOCH_D": "Estocástico %D",
    "CHOPPINESS": "Choppiness",
    "VOLUME": "Volume",
    "VOLUME_AVG": "Volume Médio",
    "CLOSE": "Preço (Close)",
    "HIGH": "Máxima",
    "LOW": "Mínima",
    "OPEN": "Abertura",
    # Fase 2 — novos indicadores
    "STOCH_RSI_K": "StochRSI %K",
    "STOCH_RSI_D": "StochRSI %D",
    "CCI": "CCI",
    "WILLIAMS_R": "Williams %R",
    "OBV": "OBV",
    "MFI": "MFI",
    "CMF": "CMF",
    "VWMA": "VWMA",
    "PIVOT": "Pivot",
    "PIVOT_R1": "Resistência R1",
    "PIVOT_R2": "Resistência R2",
    "PIVOT_S1": "Suporte S1",
    "PIVOT_S2": "Suporte S2",
    "PSAR": "Parabolic SAR",
    "PSAR_TREND": "Parabolic SAR Trend",
    "ICHIMOKU_TENKAN": "Tenkan-sen",
    "ICHIMOKU_KIJUN": "Kijun-sen",
    "ICHIMOKU_SENKOU_A": "Senkou A",
    "ICHIMOKU_SENKOU_B": "Senkou B",
    "ICHIMOKU_CLOUD_TOP": "Nuvem Topo",
    "ICHIMOKU_CLOUD_BOTTOM": "Nuvem Base",
}

_OPERATOR_LABELS = {
    "greater_than": ">",
    "less_than": "<",
    "crosses_above": "cruza ↑",
    "crosses_below": "cruza ↓",
}


def _calc_indicator_candle(
    name: str, period: int, candles: list[Candle],
) -> float | None:
    """Calcula o valor ATUAL de um indicador sobre candles.

    Retorna None se dados insuficientes. Mapeia nomes para as funções de
    masterbot_signals.py (garantindo paridade numérica com o bot ao vivo).
    """
    closes = [c["close"] for c in candles]
    n = name.upper()

    # ── Preço puro ──
    if n == "CLOSE":
        return closes[-1] if closes else None
    if n == "HIGH":
        return candles[-1]["high"] if candles else None
    if n == "LOW":
        return candles[-1]["low"] if candles else None
    if n == "OPEN":
        return candles[-1]["open"] if candles else None

    # ── Médias Móveis ──
    if n == "EMA":
        return mb.calc_ema(closes, period) if len(closes) >= period else None
    if n == "SMA":
        s = mb.sma_series(closes, period)
        return s[-1] if s and s[-1] is not None else None
    if n == "RMA":
        s = mb.rma_series(closes, period)
        return s[-1] if s and s[-1] is not None else None
    if n == "HMA":
        s = mb.hma_series(closes, period)
        return s[-1] if s and s[-1] is not None else None
    if n == "WMA":
        s = mb.wma_series(closes, period)
        return s[-1] if s and s[-1] is not None else None

    # ── RSI ──
    if n == "RSI":
        return mb.calc_rsi(closes, period)

    # ── VWAP ──
    if n == "VWAP":
        return mb.calc_vwap(candles)

    # ── ATR ──
    if n == "ATR":
        return mb.calc_atr(candles, period)
    if n == "ATR_PCT":
        atr = mb.calc_atr(candles, period)
        if atr is None or closes[-1] == 0:
            return None
        return (atr / closes[-1]) * 100

    # ── ADX / DI ──
    if n in ("ADX", "PDI", "MDI"):
        di = mb.calc_adx(candles, period)
        if di is None:
            return None
        return di.get(n.lower(), di.get("adx"))

    # ── MACD ──
    if n in ("MACD_HIST", "MACD_LINE", "MACD_SIGNAL"):
        macd = mb.calc_macd(closes)
        if macd is None:
            return None
        key = {"MACD_HIST": "hist", "MACD_LINE": "macd", "MACD_SIGNAL": "signal"}[n]
        return macd[key]

    # ── Bollinger Bands ──
    if n in ("BB_UPPER", "BB_LOWER", "BB_BASIS", "BB_PCT_B"):
        bb = mb.calc_bollinger(closes, period)
        if bb is None:
            return None
        key = {"BB_UPPER": "upper", "BB_LOWER": "lower", "BB_BASIS": "basis",
               "BB_PCT_B": "pct_b"}[n]
        return bb[key]

    # ── Supertrend ──
    if n == "SUPERTREND":
        st = mb.calc_supertrend(candles, period)
        return st["trend"] if st else None  # 1 = bull, -1 = bear

    # ── Stochastic ──
    if n in ("STOCH_K", "STOCH_D"):
        stoch = mb.calc_stochastic(candles, period)
        if stoch is None:
            return None
        return stoch["k"] if n == "STOCH_K" else stoch["d"]

    # ── Choppiness ──
    if n == "CHOPPINESS":
        return mb.calc_choppiness(candles, period)

    # ── Volume ──
    if n == "VOLUME":
        return candles[-1].get("volume", candles[-1].get("vol", 0)) if candles else None
    if n == "VOLUME_AVG":
        vols = [c.get("volume", c.get("vol", 0)) for c in candles]
        window = vols[-period:] if len(vols) >= period else vols
        return sum(window) / len(window) if window else None

    # ── Fase 2: Novos indicadores ──

    # Stochastic RSI
    if n in ("STOCH_RSI_K", "STOCH_RSI_D"):
        sr = mb.calc_stoch_rsi(closes, period)
        if sr is None:
            return None
        return sr["k"] if n == "STOCH_RSI_K" else sr["d"]

    # CCI
    if n == "CCI":
        return mb.calc_cci(candles, period)

    # Williams %R
    if n == "WILLIAMS_R":
        return mb.calc_williams_r(candles, period)

    # OBV
    if n == "OBV":
        return mb.calc_obv(candles)

    # MFI
    if n == "MFI":
        return mb.calc_mfi(candles, period)

    # CMF
    if n == "CMF":
        return mb.calc_cmf(candles, period)

    # VWMA
    if n == "VWMA":
        return mb.calc_vwma(candles, period)

    # Pivot Points
    if n in ("PIVOT", "PIVOT_R1", "PIVOT_R2", "PIVOT_S1", "PIVOT_S2"):
        pp = mb.calc_pivot_points(candles)
        if pp is None:
            return None
        key = {"PIVOT": "pivot", "PIVOT_R1": "r1", "PIVOT_R2": "r2",
               "PIVOT_S1": "s1", "PIVOT_S2": "s2"}[n]
        return pp[key]

    # Parabolic SAR
    if n == "PSAR":
        ps = mb.calc_parabolic_sar(candles)
        return ps["sar"] if ps else None
    if n == "PSAR_TREND":
        ps = mb.calc_parabolic_sar(candles)
        return ps["trend"] if ps else None  # 1 = bull, -1 = bear

    # Ichimoku
    if n in ("ICHIMOKU_TENKAN", "ICHIMOKU_KIJUN", "ICHIMOKU_SENKOU_A",
             "ICHIMOKU_SENKOU_B", "ICHIMOKU_CLOUD_TOP", "ICHIMOKU_CLOUD_BOTTOM"):
        ichi = mb.calc_ichimoku(candles)
        if ichi is None:
            return None
        key = {
            "ICHIMOKU_TENKAN": "tenkan", "ICHIMOKU_KIJUN": "kijun",
            "ICHIMOKU_SENKOU_A": "senkou_a", "ICHIMOKU_SENKOU_B": "senkou_b",
            "ICHIMOKU_CLOUD_TOP": "cloud_top", "ICHIMOKU_CLOUD_BOTTOM": "cloud_bottom",
        }[n]
        return ichi[key]

    return None


def _resolve_target_candle(cond: dict, candles: list[Candle]) -> float | None:
    """Resolve o alvo de comparação: valor fixo ou outro indicador."""
    compare = cond.get("compare_to_indicator")
    if compare:
        parts = compare.rsplit("_", 1)
        if len(parts) == 2 and parts[1].isdigit():
            ind_name, ind_period = parts[0], int(parts[1])
        else:
            ind_name, ind_period = compare, int(cond.get("indicator_period", 14))
        return _calc_indicator_candle(ind_name, ind_period, candles)
    v = cond.get("value")
    return float(v) if v is not None else None


def _compare(operator: str, current: float, target: float,
             prev_current: float | None, prev_target: float | None) -> bool:
    """Aplica o operador de comparação."""
    if operator == "greater_than":
        return current > target
    if operator == "less_than":
        return current < target
    if operator == "crosses_above":
        if prev_current is None or prev_target is None:
            return False
        return prev_current <= prev_target and current > target
    if operator == "crosses_below":
        if prev_current is None or prev_target is None:
            return False
        return prev_current >= prev_target and current < target
    return False


def _label_for_condition(cond: dict) -> str:
    """Gera um rótulo legível (PT-BR) para exibir no frontend."""
    ind = cond.get("indicator", "?")
    period = cond.get("indicator_period", "")
    op = _OPERATOR_LABELS.get(cond.get("operator", ""), cond.get("operator", "?"))
    ind_label = _INDICATOR_LABELS.get(ind.upper(), ind)

    compare = cond.get("compare_to_indicator")
    if compare:
        parts = compare.rsplit("_", 1)
        if len(parts) == 2 and parts[1].isdigit():
            tgt_label = f"{_INDICATOR_LABELS.get(parts[0].upper(), parts[0])}({parts[1]})"
        else:
            tgt_label = _INDICATOR_LABELS.get(compare.upper(), compare)
        return f"{ind_label}({period}) {op} {tgt_label}"

    val = cond.get("value", "?")
    if isinstance(val, float) and val == int(val):
        val = int(val)
    return f"{ind_label}({period}) {op} {val}"


def evaluate_candle_condition(cond: dict, candles: list[Candle]) -> dict:
    """Avalia UMA condição programável sobre candles (sem pandas).

    Retorna {"label": str, "pass": bool}.
    """
    ind = cond.get("indicator", "CLOSE")
    period = int(cond.get("indicator_period", 14))
    operator = cond.get("operator", "greater_than")

    current = _calc_indicator_candle(ind, period, candles)
    target = _resolve_target_candle(cond, candles)
    label = _label_for_condition(cond)

    if current is None or target is None:
        return {"label": label, "pass": False}

    # Para cruzamentos, calcular o valor anterior (candles[:-1])
    prev_current = None
    prev_target = None
    if operator in ("crosses_above", "crosses_below") and len(candles) > 1:
        prev_candles = candles[:-1]
        prev_current = _calc_indicator_candle(ind, period, prev_candles)
        prev_target = _resolve_target_candle(cond, prev_candles)

    passed = _compare(operator, current, target, prev_current, prev_target)
    return {"label": label, "pass": passed}


def evaluate_candle_conditions(conditions: list[dict], candles: list[Candle]) -> dict:
    """Avalia TODAS as condições programáveis sobre candles (sem pandas).

    Retorna {"allPass": bool, "results": [{"label": str, "pass": bool}]}
    — formato compatível com o MasterBot UI (mesmo dos safety checks).
    """
    if not conditions:
        return {"allPass": False, "results": [{"label": "Nenhuma condição definida", "pass": False}]}

    results = [evaluate_candle_condition(c, candles) for c in conditions]
    all_pass = all(r["pass"] for r in results)
    return {"allPass": all_pass, "results": results}


# ─── Avaliação VETORIZADA (série completa) — para o backtest ────────────────
#
# O backtest chamava evaluate_candle_conditions() a cada barra sobre uma janela
# crescente (candles[:i+1]), recomputando cada indicador do zero — O(n²) (chegava
# a 11s por combo). Aqui computamos a SÉRIE de cada indicador UMA vez e avaliamos
# barra a barra por índice. Resultado idêntico (indicadores causais: o valor no
# índice i sobre a série completa == valor calculado sobre candles[:i+1]).


def indicator_series(name: str, period: int, candles: list[Candle]) -> list:
    """Série completa alinhada a `candles`; series[i] == _calc_indicator_candle(name, period, candles[:i+1]).

    Caminho rápido para preço e médias com série pronta em masterbot_signals;
    fallback O(n²) (exato) para indicadores sem série rápida — garante correção.
    """
    n = name.upper()
    closes = [c["close"] for c in candles]
    if n == "CLOSE":
        return closes[:]
    if n == "HIGH":
        return [c["high"] for c in candles]
    if n == "LOW":
        return [c["low"] for c in candles]
    if n == "OPEN":
        return [c["open"] for c in candles]
    if n == "SMA":
        return mb.sma_series(closes, period)
    if n == "RMA":
        return mb.rma_series(closes, period)
    if n == "WMA":
        return mb.wma_series(closes, period)
    if n == "HMA":
        return mb.hma_series(closes, period)
    # fallback exato (mesma função usada barra a barra), só p/ indicadores raros
    return [_calc_indicator_candle(name, period, candles[: i + 1]) for i in range(len(candles))]


def _target_series(cond: dict, candles: list[Candle]) -> list:
    compare = cond.get("compare_to_indicator")
    if compare:
        parts = compare.rsplit("_", 1)
        if len(parts) == 2 and parts[1].isdigit():
            nm, per = parts[0], int(parts[1])
        else:
            nm, per = compare, int(cond.get("indicator_period", 14))
        return indicator_series(nm, per, candles)
    v = cond.get("value")
    val = float(v) if v is not None else None
    return [val] * len(candles)


def evaluate_conditions_series(conditions: list[dict], candles: list[Candle]) -> list[bool]:
    """Retorna [bool] de tamanho len(candles): out[i] == (todas as condições passam na barra i).

    Equivale a chamar evaluate_candle_conditions(conditions, candles[:i+1])["allPass"]
    para cada i, mas em O(n) por indicador em vez de O(n²).
    """
    nbars = len(candles)
    if not conditions:
        return [False] * nbars

    prepared = []
    for c in conditions:
        ind = c.get("indicator", "CLOSE")
        per = int(c.get("indicator_period", 14))
        prepared.append((c.get("operator", "greater_than"),
                         indicator_series(ind, per, candles),
                         _target_series(c, candles)))

    out = [False] * nbars
    for i in range(nbars):
        ok = True
        for op, cur, tgt in prepared:
            a = cur[i] if i < len(cur) else None
            b = tgt[i] if i < len(tgt) else None
            if a is None or b is None:
                ok = False
                break
            if op == "greater_than":
                r = a > b
            elif op == "less_than":
                r = a < b
            elif op in ("crosses_above", "crosses_below"):
                pa = cur[i - 1] if i > 0 else None
                pb = tgt[i - 1] if i > 0 else None
                if pa is None or pb is None:
                    r = False
                elif op == "crosses_above":
                    r = pa <= pb and a > b
                else:
                    r = pa >= pb and a < b
            else:
                r = False
            if not r:
                ok = False
                break
        out[i] = ok
    return out
