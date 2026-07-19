"""Endpoints do Micro-Scalper (leitura de estado/config por usuario).

Espelham os shapes que o frontend (api.ts) espera:
  GET /status -> {success, running, activeSymbols}
  GET /config -> {success, config: {active_symbols, plans, ...}}
  GET /log    -> {success, trades}

Exigem login (JWT do Python). Operam por current_user.id, lendo
user_micro_config / micro_sessions / micro_heartbeat.
"""
from datetime import datetime, timezone, timedelta

from fastapi import APIRouter, Depends, Query, Body, HTTPException
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


DEFAULT_MICRO_CONFIG = {
    "active_symbols": [],
    "max_trade_usdt": 25,
    "min_trade_usdt": 15,
    "loop_interval_ms": 5000,
    "max_session_ms": 86400000,
    "cooldown_ms": 5000,
    "cooldown_after_loss_ms": 10000,
    "max_trades": 50,
    "daily_profit_target_usdt": 0,
    "btc_drop_block_pct": 0.015,
    "timeout_enabled": False,
    "plans": {
        "BTCUSDT": {
            "strategy_mode": "turbo-reversion",
            "tp_pct": 0.006,
            "sl_pct": 0.003,
            "bb_length": 20,
            "bb_mult": 1.8,
            "rsi_period": 14,
            "rsi_limit": 35,
            "vol_mult": 1.3,
            "qty_decimals": 5,
            "quote_decimals": 2
        },
        "ETHUSDT": {
            "strategy_mode": "micro-dip",
            "tp_pct": 0.008,
            "sl_pct": 0.004,
            "ema_period": 20,
            "rsi_period": 3,
            "min_dip_pct": 0.0005,
            "min_rsi": 20,
            "max_rsi": 75,
            "qty_decimals": 4,
            "quote_decimals": 2
        },
        "SOLUSDT": {
            "strategy_mode": "micro-dip",
            "tp_pct": 0.010,
            "sl_pct": 0.005,
            "ema_period": 20,
            "rsi_period": 3,
            "min_dip_pct": 0.0005,
            "min_rsi": 20,
            "max_rsi": 75,
            "qty_decimals": 2,
            "quote_decimals": 2
        },
        "XRPUSDT": {
            "strategy_mode": "turbo-reversion",
            "tp_pct": 0.012,
            "sl_pct": 0.006,
            "bb_length": 20,
            "bb_mult": 1.8,
            "rsi_period": 14,
            "rsi_limit": 45,
            "vol_mult": 1.2,
            "qty_decimals": 1,
            "quote_decimals": 4
        }
    }
}


@router.get("/config")
def config(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    cfg = db.get(UserMicroConfig, current_user.id)
    if not cfg:
        cfg = UserMicroConfig(user_id=current_user.id, data=DEFAULT_MICRO_CONFIG)
        db.add(cfg)
        db.commit()
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
    from app.services.plans import PLAN_CATALOG
    plan_cfg = PLAN_CATALOG.get(current_user.plan, PLAN_CATALOG["free"])
    if not plan_cfg.get("micro_custom", False):
        non_active_keys = set(body or {}).difference({"active_symbols"})
        if non_active_keys:
            raise HTTPException(status_code=403, detail={"code": "plan_limit", "message": "Customização de parâmetros globais do Micro-Scalper só está disponível no plano Pro. Faça upgrade."})

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
    deactivated_by_system = list(data.get("deactivated_by_system") or [])
    if active is not None:
        if active:
            if symbol not in active_symbols:
                active_symbols.append(symbol)
        else:
            active_symbols = [s for s in active_symbols if s != symbol]
        if symbol in deactivated_by_system:
            deactivated_by_system.remove(symbol)
    data["active_symbols"] = active_symbols
    data["deactivated_by_system"] = deactivated_by_system

    # 2. Plan update
    plan = body.get("plan")
    plans = dict(data.get("plans") or {})
    if plan is not None:
        from app.services.plans import PLAN_CATALOG
        plan_cfg = PLAN_CATALOG.get(current_user.plan, PLAN_CATALOG["free"])
        if not plan_cfg.get("micro_custom", False):
            raise HTTPException(status_code=403, detail={"code": "plan_limit", "message": "Customização de parâmetros do Micro-Scalper só está disponível no plano Pro. Faça upgrade."})

        symbol_plan = dict(plans.get(symbol) or {})
        for k, v in plan.items():
            symbol_plan[k] = v
        plans[symbol] = symbol_plan
        # Se atualizou manualmente o plano, também limpa do bloqueio do sistema para permitir nova operação
        if symbol in deactivated_by_system:
            deactivated_by_system.remove(symbol)
            data["deactivated_by_system"] = deactivated_by_system
    data["plans"] = plans

    # 3. Global update
    global_cfg = body.get("global")
    if global_cfg is not None:
        from app.services.plans import PLAN_CATALOG
        plan_cfg = PLAN_CATALOG.get(current_user.plan, PLAN_CATALOG["free"])
        if not plan_cfg.get("micro_custom", False):
            raise HTTPException(status_code=403, detail={"code": "plan_limit", "message": "Customização de parâmetros do Micro-Scalper só está disponível no plano Pro. Faça upgrade."})

        for k, v in global_cfg.items():
            data[k] = v

    cfg.data = data
    flag_modified(cfg, "data")
    db.commit()

    return {"success": True, "restarted": True, "config": data}


@router.post("/optimize")
def optimize_strategy(
    body: dict = Body(...),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    symbol = (body or {}).get("symbol")
    if not symbol:
        raise HTTPException(status_code=400, detail="Symbol is required")
    
    from app.services.plans import PLAN_CATALOG
    plan_cfg = PLAN_CATALOG.get(current_user.plan, PLAN_CATALOG["free"])
    if not plan_cfg.get("micro_custom", False):
        raise HTTPException(status_code=403, detail={"code": "plan_limit", "message": "Otimização por IA do Micro-Scalper só está disponível no plano Pro. Faça upgrade."})

    from app.services.scalper_optimizer import optimize_symbol_for_user
    try:
        res = optimize_symbol_for_user(db, current_user.id, symbol, force_ia=True)
        return {"success": True, "restarted": True, **res}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

