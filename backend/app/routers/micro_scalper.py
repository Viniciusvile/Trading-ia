"""Endpoints do Micro-Scalper (leitura de estado/config por usuario).

Espelham os shapes que o frontend (api.ts) espera:
  GET /status -> {success, running, activeSymbols}
  GET /config -> {success, config: {active_symbols, plans, ...}}
  GET /log    -> {success, trades}

Exigem login (JWT do Python). Operam por current_user.id, lendo
user_micro_config / micro_sessions / micro_heartbeat.
"""
from datetime import datetime, timezone, timedelta

from fastapi import APIRouter, Depends, Query, Body
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from app.database import get_db
from app.deps import get_current_user
from app.models.user import User
from app.models.micro import UserMicroConfig, MicroSession, MicroHeartbeat
from app.models.bot_state import is_bot_enabled
from app.services import micro_scalper as scalper

router = APIRouter()

# Considera o scalper "rodando" se o heartbeat foi atualizado recentemente.
HEARTBEAT_FRESH_SECONDS = 180


@router.get("/status")
def status(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    cfg = db.get(UserMicroConfig, current_user.id)
    data = (cfg.data if cfg else {}) or {}
    hb = db.get(MicroHeartbeat, 1)
    hb_fresh = bool(
        hb and hb.ts and (datetime.now(timezone.utc) - hb.ts) < timedelta(seconds=HEARTBEAT_FRESH_SECONDS)
    )
    # running = ligado pelo usuario (micro_enabled) E worker vivo (heartbeat).
    enabled = is_bot_enabled(db, current_user.id, "micro_enabled")
    return {"success": True, "running": bool(enabled and hb_fresh),
            "enabled": enabled, "activeSymbols": scalper.active_symbols(data)}


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


@router.patch("/config")
def update_config(
    body: dict = Body(...),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Mescla as chaves enviadas (ex.: max_trade_usdt, timeout_enabled) em user_micro_config.data."""
    cfg = db.get(UserMicroConfig, current_user.id)
    if not cfg:
        cfg = UserMicroConfig(user_id=current_user.id, data={})
        db.add(cfg)
    data = dict(cfg.data or {})
    allowed = {"max_trade_usdt", "timeout_enabled", "loop_interval_ms", "active_symbols"}
    for k, v in (body or {}).items():
        if k in allowed:
            data[k] = v
    cfg.data = data
    flag_modified(cfg, "data")
    db.commit()
    return {"success": True, "config": data}


@router.patch("/strategy")
def update_strategy(
    body: dict = Body(...),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Ativa/desativa ou atualiza parâmetros de uma estratégia específica do Micro-Scalper."""
    symbol = body.get("symbol")
    if not symbol:
        return {"success": False, "error": "Symbol is required"}

    cfg = db.get(UserMicroConfig, current_user.id)
    if not cfg:
        cfg = UserMicroConfig(user_id=current_user.id, data={})
        db.add(cfg)
    data = dict(cfg.data or {})

    # 1. Active toggle
    active = body.get("active")
    active_symbols = list(data.get("active_symbols") or [])
    if active is not None:
        if active:
            if symbol not in active_symbols:
                active_symbols.append(symbol)
        else:
            active_symbols = [s for s in active_symbols if s != symbol]
    data["active_symbols"] = active_symbols

    # 2. Plan update
    plan = body.get("plan")
    plans = dict(data.get("plans") or {})
    if plan is not None:
        symbol_plan = dict(plans.get(symbol) or {})
        for k, v in plan.items():
            symbol_plan[k] = v
        plans[symbol] = symbol_plan
    data["plans"] = plans

    # 3. Global update
    global_cfg = body.get("global")
    if global_cfg is not None:
        for k, v in global_cfg.items():
            data[k] = v

    cfg.data = data
    flag_modified(cfg, "data")
    db.commit()

    return {"success": True, "restarted": True, "config": data}

