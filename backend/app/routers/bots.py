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
from app.models.bot_state import UserBotState
from app.models.position import Position

router = APIRouter()

HEARTBEAT_FRESH_SECONDS = 360  # bots de 5min: considera vivo se heartbeat < 6min


def _set_bot_enabled(db: Session, user_id: str, flag: str, enabled: bool) -> None:
    """Liga/desliga um bot para o usuario (flag tipo 'master_enabled')."""
    st = db.get(UserBotState, user_id)
    if st is None:
        st = UserBotState(user_id=user_id, data={})
        db.add(st)
    new_data = dict(st.data or {})
    new_data[flag] = enabled
    st.data = new_data
    db.commit()


@router.post("/master/start")
def master_start(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    _set_bot_enabled(db, current_user.id, "master_enabled", True)
    return {"success": True}


@router.post("/master/stop")
def master_stop(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    _set_bot_enabled(db, current_user.id, "master_enabled", False)
    return {"success": True}


@router.post("/micro/start")
def micro_start(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    _set_bot_enabled(db, current_user.id, "micro_enabled", True)
    return {"success": True}


@router.post("/micro/stop")
def micro_stop(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    _set_bot_enabled(db, current_user.id, "micro_enabled", False)
    return {"success": True}


@router.post("/adaptive/start")
def adaptive_start(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    _set_bot_enabled(db, current_user.id, "adaptive_enabled", True)
    return {"success": True}


@router.post("/adaptive/stop")
def adaptive_stop(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    _set_bot_enabled(db, current_user.id, "adaptive_enabled", False)
    return {"success": True}


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


@router.get("/positions")
def list_positions(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Lista posicoes (abertas e fechadas) do usuario, no shape que a UI espera."""
    rows = (
        db.query(Position)
        .filter(Position.user_id == current_user.id)
        .order_by(Position.opened_at.desc().nullslast())
        .all()
    )
    positions = []
    for p in rows:
        d = p.data or {}
        positions.append({
            "id": p.id,
            "symbol": p.symbol,
            "timeframe": p.timeframe or "",
            "side": p.side or "",
            "entryPrice": p.entry_price or 0,
            "exitPrice": p.exit_price,
            "quantity": p.quantity or 0,
            "stopPrice": p.stop_price or 0,
            "takeProfitPrice": p.take_profit_price or 0,
            "pnl": p.pnl,
            "orderId": d.get("orderId") or "",
            "ocoOrderListId": d.get("ocoOrderListId"),
            "openedAt": p.opened_at.isoformat() if p.opened_at else "",
            "closedAt": p.closed_at.isoformat() if p.closed_at else None,
            "exitReason": d.get("exitReason"),
            "status": p.status,
            "strategy": p.strategy,
            "plan": p.plan,
        })
    return {"success": True, "positions": positions}
