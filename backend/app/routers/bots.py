"""Endpoints de status dos bots MasterBot e Adaptive (leitura por usuario).

Espelham os shapes que o frontend espera (botMasterStatus, adaptiveStatus),
lendo das tabelas que as tasks Celery gravam (master_config.data.lastStatus,
adaptive_params/adaptive_heartbeat/adaptive_trades).
"""
from datetime import datetime, timezone, timedelta

from fastapi import APIRouter, Depends, Body
from sqlalchemy import text
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from app.database import get_db
from app.deps import get_current_user
from app.models.user import User
from app.models.master import MasterConfig, MasterPlan
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


# Campos gerais do MasterBot salvos em master_config.data.
_MASTER_CONFIG_KEYS = {
    "symbol", "timeframe", "strategy", "portfolio", "maxTrade",
    "paperTrading", "dailyMaxLoss", "loopInterval", "activePlan",
}


@router.patch("/config")
def update_master_config(
    body: dict = Body(...),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Salva config geral do MasterBot e aplica activePlans (liga/desliga MasterPlan.is_active)."""
    cfg = db.get(MasterConfig, current_user.id)
    if not cfg:
        cfg = MasterConfig(user_id=current_user.id, data={})
        db.add(cfg)
    data = dict(cfg.data or {})
    for k, v in (body or {}).items():
        if k in _MASTER_CONFIG_KEYS:
            data[k] = v

    # activePlans: lista de nomes de planos que devem ficar ativos.
    if isinstance(body.get("activePlans"), list):
        active = set(body["activePlans"])
        data["activePlans"] = body["activePlans"]
        plans = db.query(MasterPlan).filter(MasterPlan.user_id == current_user.id).all()
        for plan in plans:
            plan.is_active = plan.name in active

    cfg.data = data
    flag_modified(cfg, "data")
    db.commit()
    return {"success": True, "config": data}


# ─── Estratégias do MasterBot (planos) — leem/escrevem master_plans ───

def _plan_to_ui(plan: MasterPlan) -> dict:
    """Mapeia um MasterPlan (data JSONB) para o shape rico que a UI de estratégias espera."""
    d = plan.data or {}
    lb = d.get("lastBacktest") or None
    # Stats agregados do ultimo backtest (primeiro resultado, se houver).
    win_rate = 0.0
    profit_factor = 0.0
    net_profit = 0.0
    win_rate_target = None
    if lb and isinstance(lb.get("results"), list) and lb["results"]:
        st = lb["results"][0].get("stats") or {}
        win_rate = st.get("winRate", 0) or 0
        profit_factor = st.get("profitFactor", 0) or 0
        net_profit = st.get("netProfitPct", st.get("netProfit", 0)) or 0
        win_rate_target = st.get("winRateTarget")
    return {
        "name": d.get("name", plan.name),
        "description": d.get("description", ""),
        "symbols": d.get("symbols", []),
        "timeframes": d.get("timeframes", []),
        "strategy": d.get("strategy", ""),
        "mode": d.get("mode", "spot"),
        "leverage": d.get("leverage", 1),
        "active": plan.is_active,
        "winRate": win_rate,
        "profitFactor": profit_factor,
        "netProfit": net_profit,
        "totalTrades": (lb["results"][0].get("stats", {}).get("totalTrades", 0) if lb and lb.get("results") else 0),
        "filters": d.get("filters", {}),
        "sl": d.get("sl", {}),
        "tp": d.get("tp", {}),
        "statsSource": "backtest" if lb else "sem-dados",
        "realStats": None,
        "winRateTarget": win_rate_target,
        "lastBacktest": lb,
        "lastBacktestAt": (lb.get("ranAt") if lb else None),
    }


@router.get("/strategies")
def list_strategies(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    plans = (
        db.query(MasterPlan)
        .filter(MasterPlan.user_id == current_user.id)
        .order_by(MasterPlan.created_at.asc())
        .all()
    )
    return {"success": True, "strategies": [_plan_to_ui(p) for p in plans]}


@router.post("/strategies")
def create_strategy(
    body: dict = Body(...),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    name = (body or {}).get("name")
    if not name:
        return {"success": False, "error": "Nome obrigatório"}
    existing = (
        db.query(MasterPlan)
        .filter(MasterPlan.user_id == current_user.id, MasterPlan.name == name)
        .first()
    )
    if existing:
        existing.data = body
        flag_modified(existing, "data")
        db.commit()
        return {"success": True, "strategy": _plan_to_ui(existing)}
    plan = MasterPlan(
        id=f"PLAN-{current_user.id[:8]}-{name}",
        user_id=current_user.id,
        name=name,
        data=body,
        is_active=False,
    )
    db.add(plan)
    db.commit()
    return {"success": True, "strategy": _plan_to_ui(plan)}


def _set_plan_active(db: Session, user_id: str, name: str, active: bool) -> dict:
    plan = (
        db.query(MasterPlan)
        .filter(MasterPlan.user_id == user_id, MasterPlan.name == name)
        .first()
    )
    if not plan:
        return {"success": False, "error": "Estratégia não encontrada"}
    plan.is_active = active
    db.commit()
    return {"success": True}


@router.post("/strategies/{name}/activate")
def activate_strategy(name: str, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return _set_plan_active(db, current_user.id, name, True)


@router.post("/strategies/{name}/deactivate")
def deactivate_strategy(name: str, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return _set_plan_active(db, current_user.id, name, False)


@router.delete("/strategies/{name}")
def delete_strategy(name: str, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    plan = (
        db.query(MasterPlan)
        .filter(MasterPlan.user_id == current_user.id, MasterPlan.name == name)
        .first()
    )
    if not plan:
        return {"success": False, "error": "Estratégia não encontrada"}
    db.delete(plan)
    db.commit()
    return {"success": True}
