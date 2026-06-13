from pydantic import BaseModel, field_validator
from typing import Literal
from datetime import datetime

ALLOWED_SYMBOLS = ["BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT"]
ALLOWED_TIMEFRAMES = ["1m", "5m", "15m", "1h", "4h", "1d"]
ALLOWED_INDICATORS = ["RSI", "EMA", "SMA", "BB_UPPER", "BB_LOWER", "VOLUME"]
ALLOWED_OPERATORS = ["greater_than", "less_than", "crosses_above", "crosses_below"]

class Condition(BaseModel):
    indicator: str
    indicator_period: int = 14
    operator: str
    value: float | None = None
    compare_to_indicator: str | None = None

    @field_validator("indicator")
    @classmethod
    def validate_indicator(cls, v):
        if v not in ALLOWED_INDICATORS:
            raise ValueError(f"Indicador inválido. Permitidos: {ALLOWED_INDICATORS}")
        return v

    @field_validator("operator")
    @classmethod
    def validate_operator(cls, v):
        if v not in ALLOWED_OPERATORS:
            raise ValueError(f"Operador inválido. Permitidos: {ALLOWED_OPERATORS}")
        return v

class Action(BaseModel):
    type: Literal["buy", "sell"]
    size_percent: float

class ExitCondition(BaseModel):
    take_profit_percent: float
    stop_loss_percent: float

class StrategyConditions(BaseModel):
    entry_conditions: list[Condition]
    entry_action: Action
    exit_conditions: ExitCondition

class StrategyCreate(BaseModel):
    name: str
    symbol: str
    timeframe: str
    conditions: StrategyConditions

    @field_validator("symbol")
    @classmethod
    def validate_symbol(cls, v):
        if v not in ALLOWED_SYMBOLS:
            raise ValueError(f"Par inválido. Permitidos: {ALLOWED_SYMBOLS}")
        return v

    @field_validator("timeframe")
    @classmethod
    def validate_timeframe(cls, v):
        if v not in ALLOWED_TIMEFRAMES:
            raise ValueError(f"Timeframe inválido. Permitidos: {ALLOWED_TIMEFRAMES}")
        return v

class StrategyResponse(BaseModel):
    id: str
    name: str
    symbol: str
    timeframe: str
    conditions: StrategyConditions
    is_active: bool
    created_at: datetime

    model_config = {"from_attributes": True}
