"""Task Celery do Micro-Scalper (PAPER).

Roda em paper: para cada usuario com config de scalper, busca candles publicos
da Binance, decide o sinal (camada pura) e registra a decisao numa micro_sessions
com event 'paper-signal'. NAO envia ordem real — a virada para real e posterior.
"""
from datetime import datetime, timezone

from celery import shared_task
from binance.client import Client

from app.database import _get_session_factory
from app.models.micro import UserMicroConfig, MicroSession, MicroHeartbeat
from app.services import micro_scalper as scalper

# O scalper opera em candles curtos (5m por padrao no legado).
SCALPER_INTERVAL = Client.KLINE_INTERVAL_5MINUTE
CANDLE_LIMIT = 100


def _fetch_candles(client: Client, symbol: str) -> list[dict]:
    raw = client.get_klines(symbol=symbol, interval=SCALPER_INTERVAL, limit=CANDLE_LIMIT)
    return [
        {"open": float(k[1]), "high": float(k[2]), "low": float(k[3]),
         "close": float(k[4]), "volume": float(k[5]), "vol": float(k[5])}
        for k in raw
    ]


@shared_task(name="run_micro_scalper")
def run_micro_scalper():
    db = _get_session_factory()()
    client = Client()  # publico, sem chave — suficiente para candles em paper
    decisions = []
    try:
        configs = db.query(UserMicroConfig).all()
        for cfg in configs:
            data = cfg.data or {}
            plans = data.get("plans") or {}
            for symbol in scalper.active_symbols(data):
                plan = plans.get(symbol)
                if not plan:
                    continue
                try:
                    candles = _fetch_candles(client, symbol)
                    d = scalper.decide_signal_for_symbol(plan, candles)
                except Exception as e:  # falha numa iteracao nao derruba a task
                    decisions.append({"user": cfg.user_id, "symbol": symbol, "error": str(e)})
                    continue

                if d["action"] == "buy":
                    _record_paper_signal(db, symbol, d)
                decisions.append({"user": cfg.user_id, "symbol": symbol, "action": d["action"]})

        # heartbeat singleton
        hb = db.get(MicroHeartbeat, 1)
        now = datetime.now(timezone.utc)
        if hb:
            hb.ts = now
        else:
            db.add(MicroHeartbeat(id=1, ts=now))
        db.commit()
        return {"status": "ok", "decisions": decisions}
    finally:
        db.close()


def _record_paper_signal(db, symbol: str, d: dict) -> None:
    """Registra a decisao paper na micro_sessions do dia/simbolo."""
    now = datetime.now(timezone.utc)
    day_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    sess = (
        db.query(MicroSession)
        .filter(MicroSession.symbol == symbol,
                MicroSession.account_id == "paper",
                MicroSession.session_start == day_start)
        .first()
    )
    entry = {
        "t": now.isoformat(),
        "event": "paper-signal",
        "side": "buy",
        "signal": d.get("signal"),
        "entryPrice": d.get("entryPrice"),
        "slPrice": d.get("slPrice"),
        "tpPrice": d.get("tpPrice"),
    }
    if sess:
        sess.trades = list(sess.trades) + [entry]
    else:
        db.add(MicroSession(session_start=day_start, symbol=symbol,
                            trades=[entry], account_id="paper"))
