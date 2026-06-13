"""Endpoints de status dos bots MasterBot e Adaptive (leitura por usuario).

Espelham os shapes que o frontend espera (botMasterStatus, adaptiveStatus),
lendo das tabelas que as tasks Celery gravam (master_config.data.lastStatus,
adaptive_params/adaptive_heartbeat/adaptive_trades).
"""
from datetime import datetime, timezone, timedelta

from fastapi import APIRouter, Depends
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.database import get_db
from app.deps import get_current_user
from app.models.user import User
from app.models.master import MasterConfig

router = APIRouter()

HEARTBEAT_FRESH_SECONDS = 360  # bots de 5min: considera vivo se heartbeat < 6min


@router.get("/master/status")
def master_status(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    cfg = db.get(MasterConfig, current_user.id)
    data = (cfg.data if cfg else {}) or {}
    last = data.get("lastStatus") or {}
    results = last.get("results", [])
    last_run = last.get("lastRun")
    is_alive = False
    if last_run:
        try:
            ts = datetime.fromisoformat(last_run)
            is_alive = (datetime.now(timezone.utc) - ts) < timedelta(seconds=HEARTBEAT_FRESH_SECONDS)
        except ValueError:
            is_alive = False
    return {
        "success": True,
        "isAlive": is_alive,
        "status": last.get("status", "stopped"),
        "lastRun": last_run,
        "watchlist": data.get("watchlist", []),
        "lastResults": [
            {"symbol": r.get("symbol"), "timeframe": "", "allPass": r.get("action") == "enter",
             "side": r.get("side"), "signal": r.get("reason") or "", "strategy": r.get("strategy")}
            for r in results
        ],
    }


@router.get("/adaptive/status")
def adaptive_status(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    row = db.execute(text(
        "SELECT version, params FROM adaptive_params WHERE is_active = true ORDER BY version DESC LIMIT 1"
    )).fetchone()
    hb = db.execute(text("SELECT ts FROM adaptive_heartbeat WHERE id = 1")).fetchone()
    running = False
    last_seen = None
    if hb and hb[0]:
        last_seen = hb[0].isoformat()
        running = (datetime.now(timezone.utc) - hb[0]) < timedelta(seconds=HEARTBEAT_FRESH_SECONDS)

    recent = db.execute(text(
        "SELECT id, result, return_pct, closed_at, params_version FROM adaptive_trades "
        "WHERE closed_at IS NOT NULL ORDER BY closed_at DESC LIMIT 10"
    )).fetchall()

    params = dict(row[1]) if row else None
    if params is not None:
        params["version"] = row[0]

    return {
        "success": True,
        "running": running,
        "lastSeen": last_seen,
        "paper": True,
        "params": params,
        "openTrades": [],
        "stats30d": {"trades": 0, "winRate": 0, "pnlPct": 0},
        "recentTrades": [
            {"id": r[0], "result": r[1], "returnPct": r[2] or 0,
             "closedAt": r[3].isoformat() if r[3] else "", "version": r[4]}
            for r in recent
        ],
        "lessons": [],
        "reviews": [],
    }
