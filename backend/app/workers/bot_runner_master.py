"""Task Celery do MasterBot (PAPER).

Para cada usuario com master_config, reconstroi o dict de regras (watchlist +
group_plans a partir de master_plans/master_config), percorre a watchlist,
resolve o plano de cada simbolo, decide o sinal (camada pura) e registra a
decisao. NAO envia ordem real.
"""
from datetime import datetime, timezone

from celery import shared_task
from binance.client import Client

from app.database import _get_session_factory
from app.models.user import User  # noqa: F401  (registra a tabela 'users' p/ resolver a FK)
from app.models.master import MasterPlan, MasterConfig
from app.models.bot_state import is_bot_enabled
from app.services import masterbot as mbot

TIMEFRAME_MAP = {
    "1m": Client.KLINE_INTERVAL_1MINUTE, "5m": Client.KLINE_INTERVAL_5MINUTE,
    "15m": Client.KLINE_INTERVAL_15MINUTE, "30m": Client.KLINE_INTERVAL_30MINUTE,
    "1h": Client.KLINE_INTERVAL_1HOUR, "1H": Client.KLINE_INTERVAL_1HOUR,
    "4h": Client.KLINE_INTERVAL_4HOUR, "4H": Client.KLINE_INTERVAL_4HOUR,
    "1d": Client.KLINE_INTERVAL_1DAY, "1D": Client.KLINE_INTERVAL_1DAY,
}
CANDLE_LIMIT = 250  # MasterBot precisa de warmup (EMA200 etc.)


def _fetch_candles(client: Client, symbol: str, tf: str) -> list[dict]:
    interval = TIMEFRAME_MAP.get(tf, Client.KLINE_INTERVAL_1HOUR)
    raw = client.get_klines(symbol=symbol, interval=interval, limit=CANDLE_LIMIT)
    return [
        {"open": float(k[1]), "high": float(k[2]), "low": float(k[3]),
         "close": float(k[4]), "volume": float(k[5]), "time": int(k[0])}
        for k in raw
    ]


def _rules_for_user(db, user_id: str) -> dict:
    cfg = db.get(MasterConfig, user_id)
    data = (cfg.data if cfg else {}) or {}
    plans = [p.data for p in db.query(MasterPlan).filter(MasterPlan.user_id == user_id).all()]
    return {
        "watchlist": data.get("watchlist", []),
        "active_plans": data.get("active_plans", []),
        "group_plans": plans,
    }


@shared_task(name="run_masterbot")
def run_masterbot():
    db = _get_session_factory()()
    client = Client()
    decisions = []
    try:
        configs = db.query(MasterConfig).all()
        for cfg in configs:
            if not is_bot_enabled(db, cfg.user_id, "master_enabled"):
                continue  # so opera para quem ligou o MasterBot
            rules = _rules_for_user(db, cfg.user_id)
            user_results = []
            for symbol in rules["watchlist"]:
                plan = mbot.get_plan_for_symbol(symbol, rules, "master")
                if not plan:
                    continue
                tf = (plan.get("timeframes") or ["1H"])[0]
                try:
                    candles = _fetch_candles(client, symbol, tf)
                    d = mbot.decide_signal_for_plan(plan, candles)
                except Exception as e:
                    user_results.append({"symbol": symbol, "error": str(e)})
                    continue
                rec = {"symbol": symbol, "plan": plan.get("name"), "strategy": plan.get("strategy"),
                       "action": d["action"], "side": d.get("side"), "reason": d.get("reason")}
                user_results.append(rec)
                decisions.append({"user": cfg.user_id, **rec})

            # grava o ultimo status (paper) no master_config.data.lastStatus do usuario
            now = datetime.now(timezone.utc).isoformat()
            new_data = dict(cfg.data or {})
            new_data["lastStatus"] = {"status": "waiting", "lastRun": now, "results": user_results}
            cfg.data = new_data
        db.commit()
        return {"status": "ok", "ts": datetime.now(timezone.utc).isoformat(), "decisions": decisions}
    finally:
        db.close()
