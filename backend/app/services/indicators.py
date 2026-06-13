import pandas as pd

def calculate_rsi(prices: pd.Series, period: int = 14) -> float:
    delta = prices.diff()
    gain = delta.clip(lower=0)
    loss = -delta.clip(upper=0)
    avg_gain = gain.ewm(com=period - 1, min_periods=period).mean()
    avg_loss = loss.ewm(com=period - 1, min_periods=period).mean()
    rs = avg_gain / avg_loss
    rsi = 100 - (100 / (1 + rs))
    return float(rsi.iloc[-1])

def calculate_ema(prices: pd.Series, period: int = 20) -> float:
    result = prices.ewm(span=period, adjust=False).mean()
    return float(result.iloc[-1])

def calculate_sma(prices: pd.Series, period: int = 20) -> float:
    result = prices.rolling(window=period).mean()
    return float(result.iloc[-1])

def calculate_bollinger(prices: pd.Series, period: int = 20) -> tuple[float, float]:
    sma = prices.rolling(window=period).mean()
    std = prices.rolling(window=period).std()
    upper = sma + (2 * std)
    lower = sma - (2 * std)
    return float(upper.iloc[-1]), float(lower.iloc[-1])

def get_indicator_value(indicator: str, period: int, prices: pd.Series) -> float:
    if indicator == "RSI":
        return calculate_rsi(prices, period)
    elif indicator == "EMA":
        return calculate_ema(prices, period)
    elif indicator == "SMA":
        return calculate_sma(prices, period)
    elif indicator == "BB_UPPER":
        upper, _ = calculate_bollinger(prices, period)
        return upper
    elif indicator == "BB_LOWER":
        _, lower = calculate_bollinger(prices, period)
        return lower
    elif indicator == "VOLUME":
        return float(prices.iloc[-1])
    else:
        raise ValueError(f"Indicador desconhecido: {indicator}")
