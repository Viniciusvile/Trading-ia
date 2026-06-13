import pandas as pd
from celery import shared_task
from sqlalchemy.orm import Session
from binance.client import Client
from app.database import _get_session_factory
from app.models.strategy import Strategy
from app.schemas.strategy import StrategyConditions
from app.services.condition_evaluator import evaluate_all_conditions
from app.services.order_executor import execute_buy, get_binance_client

TIMEFRAME_MAP = {
    "1m": Client.KLINE_INTERVAL_1MINUTE,
    "5m": Client.KLINE_INTERVAL_5MINUTE,
    "15m": Client.KLINE_INTERVAL_15MINUTE,
    "1h": Client.KLINE_INTERVAL_1HOUR,
    "4h": Client.KLINE_INTERVAL_4HOUR,
    "1d": Client.KLINE_INTERVAL_1DAY,
}

@shared_task(name="run_strategy", bind=True, max_retries=3)
def run_strategy(self, strategy_id: str):
    db: Session = _get_session_factory()()
    try:
        strategy = db.query(Strategy).filter(
            Strategy.id == strategy_id,
            Strategy.is_active == True  # noqa: E712
        ).first()

        if not strategy:
            return {"status": "skipped", "reason": "estratégia não encontrada ou inativa"}

        conditions = StrategyConditions.model_validate_json(strategy.conditions_json)
        client = get_binance_client(db, strategy.user_id)
        interval = TIMEFRAME_MAP.get(strategy.timeframe, Client.KLINE_INTERVAL_1HOUR)

        klines = client.get_klines(symbol=strategy.symbol, interval=interval, limit=200)
        closes = pd.Series([float(k[4]) for k in klines])

        should_enter = evaluate_all_conditions(conditions.entry_conditions, closes)

        if should_enter:
            log = execute_buy(
                db, strategy.user_id, strategy.id,
                strategy.symbol, conditions.entry_action.size_percent
            )
            return {"status": "executed", "action": "buy", "log_id": log.id}

        return {"status": "no_signal"}

    except Exception as e:
        raise self.retry(exc=e, countdown=60)
    finally:
        db.close()
