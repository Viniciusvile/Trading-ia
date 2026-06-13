"""Endpoints do Micro-Scalper (leitura de estado/config por usuario).

Espelham os shapes que o frontend (api.ts) espera:
  GET /status -> {success, running, activeSymbols}
  GET /config -> {success, config: {active_symbols, plans, ...}}
  GET /log    -> {success, trades}

Exigem login (JWT do Python). Operam por current_user.id, lendo
user_micro_config / micro_sessions / micro_heartbeat.
"""
from datetime import datetime, timezone, timedelta

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.database import get_db
from app.deps import get_current_user
from app.models.user import User
from app.models.micro import UserMicroConfig, MicroSession, MicroHeartbeat
from app.services import micro_scalper as scalper

router = APIRouter()

# Considera o scalper "rodando" se o heartbeat foi atualizado recentemente.
HEARTBEAT_FRESH_SECONDS = 180


@router.get("/status")
def status(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    cfg = db.get(UserMicroConfig, current_user.id)
    data = (cfg.data if cfg else {}) or {}
    hb = db.get(MicroHeartbeat, 1)
    running = bool(
        hb and hb.ts and (datetime.now(timezone.utc) - hb.ts) < timedelta(seconds=HEARTBEAT_FRESH_SECONDS)
    )
    return {"success": True, "running": running, "activeSymbols": scalper.active_symbols(data)}


@router.get("/config")
def config(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    cfg = db.get(UserMicroConfig, current_user.id)
    if not cfg:
        return {"success": True, "config": None}
    return {"success": True, "config": cfg.data}


@router.get("/log")
def log(limit: int = Query(25), current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    # Junta os trades das sessoes recentes (paper) em ordem cronologica inversa.
    sessions = (
        db.query(MicroSession)
        .order_by(MicroSession.session_start.desc())
        .limit(20)
        .all()
    )
    trades: list[dict] = []
    for s in sessions:
        for t in (s.trades or []):
            trades.append({**t, "symbol": s.symbol})
    trades.sort(key=lambda x: x.get("t", ""), reverse=True)
    return {"success": True, "trades": trades[:limit]}
