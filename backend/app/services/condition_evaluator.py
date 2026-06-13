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
