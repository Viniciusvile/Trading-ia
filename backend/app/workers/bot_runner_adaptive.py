"""Task Celery do Adaptive-Bot (PAPER, SEM learner).

Le os params ativos (adaptive_params.is_active), gera sinal reusando
scalper_signals (mesmo motor do scalper, como no signal.js do legado) e registra
a decisao. O ciclo de aprendizado via Gemini (learner) NAO esta portado ainda —
roda com parametros fixos. NENHUMA ordem real.
"""
from datetime import datetime, timezone

from celery import shared_task
from binance.client import Client
from sqlalchemy import text

from app.database import _get_session_factory
from app.services import scalper_signals as sig

SYMBOL = "BTCUSDT"
INTERVAL = Client.KLINE_INTERVAL_5MINUTE
CANDLE_LIMIT = 250


def _params_to_opts(p: dict) -> dict:
    return {
        "ema_period": p.get("ema_period", 20),
        "rsi_period": p.get("rsi_period", 14),
        "min_dip": p.get("min_dip_pct", 0.004),
        "min_rsi": p.get("min_rsi", 20),
        "max_rsi": p.get("max_rsi", 45),
        "rsi_len": p.get("rsi_period", 14),
        "rsi_limit": p.get("min_rsi", 20),
        "trend_ema_period": p.get("trend_ema_period", 0),
        "min_atr_pct": p.get("min_atr_pct", 0),
    }


def decide(params: dict, candles: list[dict]) -> dict:
    """PURA: decide entrada do adaptive a partir dos params ativos. Long-only."""
    opts = _params_to_opts(params)
    if params.get("strategy") == "turbo-reversion":
        s = sig.turbo_reversion_signal(candles, opts)
    else:
        s = sig.micro_scalp_signal(candles, opts)
    if s.get("signal") != "buy":
        return {"action": "none", "reason": s.get("reason")}
    price = candles[-1]["close"]
    return {
        "action": "buy",
        "entryPrice": price,
        "slPrice": price * (1 - params.get("sl_pct", 0.006)),
        "tpPrice": price * (1 + params.get("tp_pct", 0.01)),
    }


@shared_task(name="run_adaptive")
def run_adaptive():
    db = _get_session_factory()()
    client = Client()
    try:
        row = db.execute(text(
            "SELECT version, params FROM adaptive_params WHERE is_active = true ORDER BY version DESC LIMIT 1"
        )).fetchone()
        if not row:
            return {"status": "skipped", "reason": "sem params ativos"}
        version, params = row[0], row[1]

        raw = client.get_klines(symbol=SYMBOL, interval=INTERVAL, limit=CANDLE_LIMIT)
        candles = [
            {"open": float(k[1]), "high": float(k[2]), "low": float(k[3]),
             "close": float(k[4]), "volume": float(k[5]), "vol": float(k[5]), "time": int(k[0])}
            for k in raw
        ]
        d = decide(params, candles)

        now = datetime.now(timezone.utc)
        db.execute(text(
            "INSERT INTO adaptive_heartbeat (id, ts) VALUES (1, :ts) "
            "ON CONFLICT (id) DO UPDATE SET ts = :ts"
        ), {"ts": now})
        db.commit()
        return {"status": "ok", "version": version, "action": d["action"], "reason": d.get("reason")}
    finally:
        db.close()
