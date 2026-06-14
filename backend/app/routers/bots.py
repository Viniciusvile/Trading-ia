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
from app.models.bot_state import UserBotState, is_bot_enabled
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
    enabled = is_bot_enabled(db, current_user.id, "master_enabled")
    # isAlive reflete o que o usuario controla (ligado/desligado). is_alive (heartbeat)
    # vira um indicador secundario de "worker processando" (workerFresh).
    return {
        "success": True,
        "isAlive": enabled,
        "enabled": enabled,
        "workerFresh": is_alive,
        "status": last.get("status", "waiting") if enabled else "stopped",
        "lastRun": last_run,
        "watchlist": data.get("watchlist", []),
        "lastResults": [
            {"symbol": r.get("symbol"), "timeframe": "", "allPass": r.get("action") == "enter",
             "side": r.get("side"), "signal": r.get("reason") or "", "strategy": r.get("strategy"),
             "conditions": r.get("conditions", [])}
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


@router.get("/config")
def get_master_config(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Config geral do MasterBot + groupPlans (todos os planos do user) + activePlans (ativos).

    É o que o modal de Configurações do MasterBot consome para listar as estratégias.
    """
    cfg = db.get(MasterConfig, current_user.id)
    data = (cfg.data if cfg else {}) or {}
    plans = (
        db.query(MasterPlan)
        .filter(MasterPlan.user_id == current_user.id)
        .order_by(MasterPlan.created_at.asc())
        .all()
    )
    group_plans = [
        {
            "name": p.name,
            "description": (p.data or {}).get("description", ""),
            "symbols": (p.data or {}).get("symbols", []),
        }
        for p in plans
    ]
    active_plans = [p.name for p in plans if p.is_active]
    return {
        "success": True,
        "strategyKey": data.get("strategy", "warrior"),
        "symbol": data.get("symbol", "BTCUSDT"),
        "timeframe": data.get("timeframe", "4H"),
        "portfolio": data.get("portfolio", 200),
        "maxTrade": data.get("maxTrade", 20),
        "paperTrading": data.get("paperTrading", True),
        "dailyMaxLoss": data.get("dailyMaxLoss", 0),
        "activePlan": data.get("activePlan"),
        "activePlans": active_plans,
        "loopInterval": data.get("loopInterval", "1h"),
        "groupPlans": group_plans,
    }


@router.get("/master/raw-log")
def master_raw_log(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Log textual do ultimo ciclo do MasterBot (de master_config.data.lastStatus)."""
    cfg = db.get(MasterConfig, current_user.id)
    data = (cfg.data if cfg else {}) or {}
    last = data.get("lastStatus") or {}
    lines: list[str] = []
    last_run = last.get("lastRun")
    if last_run:
        lines.append(f"Último ciclo: {last_run}")
    for r in last.get("results", []):
        action = r.get("action", "")
        sym = r.get("symbol", "")
        side = r.get("side", "")
        reason = r.get("reason", "")
        plan = r.get("plan", "")
        verb = "ENTRAR" if action == "enter" else "aguardar"
        lines.append(f"[{sym}] {plan} ({r.get('strategy','')}) -> {verb} {side} {('· ' + reason) if reason else ''}".strip())
    if not lines:
        lines.append("Sem atividade recente do MasterBot (paper).")
    return {"success": True, "lines": lines}


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


# ─── Saldo (spot) — reusa as credenciais Binance do usuario ───

@router.get("/balance")
def bot_balance(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Saldo total em USDT (spot). futures=0 (sem bot futures no Python).

    Falha graciosa: se nao houver credencial/erro Binance, retorna 0 sem quebrar a UI.
    """
    from app.models.binance_config import BinanceConfig
    from app.services.crypto import decrypt
    from binance.client import Client

    config = db.query(BinanceConfig).filter(BinanceConfig.user_id == current_user.id).first()
    if not config:
        return {"success": True, "spot": 0, "futures": 0}
    try:
        client = Client(decrypt(config.encrypted_api_key), decrypt(config.encrypted_secret_key), testnet=config.is_testnet)
        account = client.get_account()
        prices = {p["symbol"]: float(p["price"]) for p in client.get_all_tickers()}
        total = 0.0
        for b in account.get("balances", []):
            qty = float(b["free"]) + float(b["locked"])
            if qty <= 0:
                continue
            asset = b["asset"]
            if asset == "USDT":
                total += qty
            elif f"{asset}USDT" in prices:
                total += qty * prices[f"{asset}USDT"]
        return {"success": True, "spot": round(total, 2), "futures": 0}
    except Exception:
        return {"success": True, "spot": 0, "futures": 0}


# ─── Escrita de posicoes (PAPER: opera sobre a tabela positions, NAO toca a Binance) ───

@router.post("/positions/{pos_id}/close")
def close_position(
    pos_id: str,
    markOnly: bool = False,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Fecha uma posicao em PAPER: marca status=closed e registra closedAt. Nao envia ordem real."""
    pos = (
        db.query(Position)
        .filter(Position.id == pos_id, Position.user_id == current_user.id)
        .first()
    )
    if not pos:
        return {"success": False, "error": "Posição não encontrada"}
    if pos.status == "closed":
        return {"success": True, "error": None}
    pos.status = "closed"
    pos.closed_at = datetime.now(timezone.utc)
    d = dict(pos.data or {})
    d["status"] = "closed"
    d["closedAt"] = pos.closed_at.isoformat()
    d["exitReason"] = "manual_paper" if not markOnly else "mark_only"
    pos.data = d
    flag_modified(pos, "data")
    db.commit()
    return {"success": True}


@router.post("/reconcile")
def reconcile(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Reconciliacao em PAPER: como nao ha Binance, apenas reporta as posicoes abertas conhecidas."""
    open_positions = (
        db.query(Position)
        .filter(Position.user_id == current_user.id, Position.status == "open")
        .all()
    )
    return {
        "success": True,
        "checked": len(open_positions),
        "ghostsClosed": [],
        "missingOco": [],
        "ok": [p.id for p in open_positions],
        "untracked": [],
    }


@router.post("/emergency-sell")
def emergency_sell(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Fecha TODAS as posicoes abertas em PAPER (sem ordem real)."""
    open_positions = (
        db.query(Position)
        .filter(Position.user_id == current_user.id, Position.status == "open")
        .all()
    )
    now = datetime.now(timezone.utc)
    for pos in open_positions:
        pos.status = "closed"
        pos.closed_at = now
        d = dict(pos.data or {})
        d["status"] = "closed"
        d["closedAt"] = now.isoformat()
        d["exitReason"] = "emergency_paper"
        pos.data = d
        flag_modified(pos, "data")
    db.commit()
    return {"success": True, "message": f"{len(open_positions)} posição(ões) fechada(s) (paper)."}


@router.post("/force-trade")
def force_trade(
    body: dict = Body(...),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Force-trade em PAPER: nao executa ordem real. Retorna shape compativel com a UI."""
    symbol = (body or {}).get("symbol", "")
    side = (body or {}).get("side", "")
    return {
        "success": True,
        "exitCode": 0,
        "stdout": f"[PAPER] Force-trade simulado: {side} {symbol}. Execução real desativada nesta fase.",
        "stderr": "",
    }


# ─── Bot Futures: STUB (nao portado para o Python; aparece pausado na UI) ───

@router.get("/futures/status")
def futures_status(current_user: User = Depends(get_current_user)):
    return {"success": True, "isAlive": False, "status": "stopped", "openPositions": 0}


@router.post("/futures/start")
def futures_start(current_user: User = Depends(get_current_user)):
    return {"success": False, "error": "Bot Futures não está disponível no novo sistema."}


@router.post("/futures/stop")
def futures_stop(current_user: User = Depends(get_current_user)):
    return {"success": True}


# ─── Backtest: motor REAL (port de masterbot/lib/backtest-engine.js) ───

@router.post("/backtest")
def backtest(
    body: dict = Body(...),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Roda o backtest de um plano (symbols×timeframes) com candles reais da Binance.

    Aceita o plano completo no body OU apenas {name} (resolve do master_plans do user).
    Persiste o lastBacktest no master_plans correspondente, como o legado fazia.
    """
    from app.services import backtest as bt

    plan = dict(body or {})
    # Se veio só o nome, resolve o plano salvo do usuário.
    if plan.get("name") and not plan.get("symbols"):
        mp = (
            db.query(MasterPlan)
            .filter(MasterPlan.user_id == current_user.id, MasterPlan.name == plan["name"])
            .first()
        )
        if mp:
            plan = {**(mp.data or {}), "name": mp.name}

    try:
        result = bt.run_plan_backtest(plan)
    except ValueError as e:
        return {"success": False, "error": str(e)}
    except Exception as e:  # noqa: BLE001
        return {"success": False, "error": f"Erro no backtest: {e}"}

    # Persiste o lastBacktest na estratégia do usuário (se existir).
    if plan.get("name"):
        mp = (
            db.query(MasterPlan)
            .filter(MasterPlan.user_id == current_user.id, MasterPlan.name == plan["name"])
            .first()
        )
        if mp:
            data = dict(mp.data or {})
            data["lastBacktest"] = result
            mp.data = data
            flag_modified(mp, "data")
            db.commit()

    return {"success": True, **result}
