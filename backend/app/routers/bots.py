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

from app.config import settings
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
             "plan": r.get("plan") or "", "conditions": r.get("conditions", [])}
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
    # Usa o COMBINED (agregado de todos os symbol×timeframe), nao results[0] (1o combo
    # so) — senao o card diverge do modal de Analise, que mostra o combined.
    win_rate = 0.0
    profit_factor = 0.0
    net_profit = 0.0      # USD (o card usa fmtUSD)
    total_trades = 0
    win_rate_target = lb.get("winRateTarget") if lb else None
    combined = (lb or {}).get("combined") if lb else None
    if combined:
        win_rate = combined.get("winRate", 0) or 0
        profit_factor = combined.get("profitFactor", 0) or 0
        net_profit = combined.get("netProfitUsd", 0) or 0
        total_trades = combined.get("totalTrades", 0) or 0
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
        "totalTrades": total_trades,
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


# ─── Compartilhamento & Importação de estratégias ───

# Campos da config que NUNCA são compartilhados (dados sensíveis / por-usuário).
_SHARE_BLOCKLIST = {"apiKey", "secretKey", "credentials", "userId", "user_id"}


def _public_strategy_data(data: dict) -> dict:
    """Copia da config sem dados sensíveis, pronta para importar por terceiros."""
    src = dict(data or {})
    out = {k: v for k, v in src.items() if k not in _SHARE_BLOCKLIST}
    out.pop("shareCode", None)
    return out


@router.post("/strategies/{name}/share")
def share_strategy(name: str, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Gera (ou reusa) um código de compartilhamento para a estratégia do usuário."""
    import secrets

    plan = (
        db.query(MasterPlan)
        .filter(MasterPlan.user_id == current_user.id, MasterPlan.name == name)
        .first()
    )
    if not plan:
        return {"success": False, "error": "Estratégia não encontrada"}

    data = dict(plan.data or {})
    code = data.get("shareCode")
    if not code:
        code = secrets.token_urlsafe(6).replace("-", "").replace("_", "")[:8].upper()
        data["shareCode"] = code
        plan.data = data
        flag_modified(plan, "data")
        db.commit()
    return {"success": True, "code": code}


@router.get("/strategies/shared/{code}")
def get_shared_strategy(code: str, db: Session = Depends(get_db)):
    """Busca a config pública de uma estratégia pelo código (sem auth — link público)."""
    code = (code or "").strip().upper()
    if not code:
        return {"success": False, "error": "Código inválido"}
    plan = (
        db.query(MasterPlan)
        .filter(text("data->>'shareCode' = :code"))
        .params(code=code)
        .first()
    )
    if not plan:
        return {"success": False, "error": "Código inválido"}
    pub = _public_strategy_data(plan.data or {})
    pub["code"] = code
    return {"success": True, "strategy": pub}


# ─── Importação de estratégia via TradingView / Pine Script ───

def _num(v):
    try:
        if v is None:
            return None
        n = float(v)
        return n
    except (TypeError, ValueError):
        return None


def _normalize_sl_tp(v: dict | None, default_pct: float) -> dict:
    """A IA emite {type:'percentage', value}; o motor usa type 'pct'. ATR é preservado."""
    if not isinstance(v, dict):
        return {"type": "pct", "value": default_pct}
    t = v.get("type")
    if t in ("percentage", "percent", "pct"):
        value = _num(v.get("value"))
        return {"type": "pct", "value": default_pct if (value is None or value <= 0) else value}
    if t == "atr" and v.get("multiplier") is not None:
        return {"type": "atr", "multiplier": _num(v.get("multiplier"))}
    value = _num(v.get("value"))
    if value is not None and value > 0:
        return {"type": "pct", "value": value}
    return {"type": "pct", "value": default_pct}


def _flatten_imported_filters(filters) -> dict:
    """Achata filtros aninhados da IA (rsi/bb/ema/macd/adx...) para chaves planas."""
    if not isinstance(filters, dict):
        return {}
    import json as _json
    f = filters
    out: dict = {}
    blob = _json.dumps(f).lower()

    rsi = f.get("rsi") or f.get("RSI")
    if isinstance(rsi, dict):
        os_ = _num(rsi.get("oversold") or rsi.get("lower") or rsi.get("min"))
        ob = _num(rsi.get("overbought") or rsi.get("upper") or rsi.get("max"))
        if os_ is not None:
            out["rsi_max"] = os_
        elif ob is not None:
            out["rsi_min"] = 0
        if _num(rsi.get("period")) is not None:
            out["rsi_period"] = _num(rsi.get("period"))
    if _num(f.get("rsi_min")) is not None:
        out["rsi_min"] = _num(f.get("rsi_min"))
    if _num(f.get("rsi_max")) is not None:
        out["rsi_max"] = _num(f.get("rsi_max"))

    bb = f.get("bb") or f.get("bollinger") or f.get("bollingerBands") or f.get("bollinger_bands")
    if isinstance(bb, dict):
        if _num(bb.get("period") or bb.get("length")) is not None:
            out["bb_period"] = _num(bb.get("period") or bb.get("length"))
        if _num(bb.get("mult") or bb.get("stdDev") or bb.get("deviation")) is not None:
            out["bb_mult"] = _num(bb.get("mult") or bb.get("stdDev") or bb.get("deviation"))
        out["bb_pct_b_max"] = 0.2

    if f.get("ma") or f.get("ema") or f.get("movingAverage") or f.get("moving_average") \
            or "moving" in blob or "ema" in blob or "média" in blob:
        out["ema_triple"] = True

    if f.get("macd") or "macd" in blob:
        out["macd_positive"] = True

    adx = f.get("adx") or f.get("ADX")
    if isinstance(adx, dict) and _num(adx.get("min") or adx.get("threshold")) is not None:
        out["adx_min"] = _num(adx.get("min") or adx.get("threshold"))
    if _num(f.get("adx_min")) is not None:
        out["adx_min"] = _num(f.get("adx_min"))
    if _num(f.get("adx_max")) is not None:
        out["adx_max"] = _num(f.get("adx_max"))

    st = f.get("supertrend") or f.get("superTrend")
    if isinstance(st, dict):
        out["supertrend_period"] = _num(st.get("period") or st.get("atrPeriod")) or 10
        if _num(st.get("mult") or st.get("factor")) is not None:
            out["supertrend_mult"] = _num(st.get("mult") or st.get("factor"))

    if _num(f.get("volume_mult")) is not None:
        out["volume_mult"] = _num(f.get("volume_mult"))
    vol = f.get("volume")
    if isinstance(vol, dict) and _num(vol.get("mult") or vol.get("multiplier")) is not None:
        out["volume_mult"] = _num(vol.get("mult") or vol.get("multiplier"))

    return out


# Parâmetros do gatilho 'volatility-envelope' (preservados crus nos filters).
_ENVELOPE_PARAM_KEYS = ("adapt_length", "choppy_speed", "trend_speed", "vol_length", "color_sens")


def _envelope_filters(raw_filters) -> dict:
    """Extrai os params do envelope dos filters da IA, com defaults do preset 'Default'."""
    f = raw_filters if isinstance(raw_filters, dict) else {}
    defaults = {"adapt_length": 20, "choppy_speed": 0.05, "trend_speed": 0.85,
                "vol_length": 20, "color_sens": 8.0}
    out: dict = {}
    for k, dflt in defaults.items():
        v = _num(f.get(k))
        out[k] = v if v is not None else dflt
    return out


_MA_TYPES = {"ema", "sma", "rma", "hma", "wma"}
# Defaults do "State-aware MA Cross Strategy" (© chikaharu).
_STATE_MA_DEFAULTS = {
    "base_period": 20,
    "s00_short_type": "ema", "s00_short_len": 15, "s00_long_type": "hma", "s00_long_len": 24,
    "s01_short_type": "sma", "s01_short_len": 19, "s01_long_type": "rma", "s01_long_len": 45,
    "s10_short_type": "rma", "s10_short_len": 16, "s10_long_type": "hma", "s10_long_len": 59,
    "s11_short_type": "rma", "s11_short_len": 12, "s11_long_type": "rma", "s11_long_len": 36,
}


def _state_ma_filters(raw_filters) -> dict:
    """Extrai os params do state-ma-cross dos filters da IA, com defaults do script."""
    f = raw_filters if isinstance(raw_filters, dict) else {}
    out: dict = {}
    for k, dflt in _STATE_MA_DEFAULTS.items():
        v = f.get(k)
        if k.endswith("_type"):
            out[k] = v.lower() if isinstance(v, str) and v.lower() in _MA_TYPES else dflt
        else:
            n = _num(v)
            out[k] = int(n) if n is not None and n > 0 else dflt
    return out


_VALID_TIMEFRAMES = {"5M", "15M", "30M", "1H", "4H", "1D"}


def _clean_reco_timeframes(raw) -> list[str]:
    """Filtra/normaliza os timeframes recomendados para os válidos do sistema."""
    if not isinstance(raw, list):
        return []
    out: list[str] = []
    for tf in raw:
        if not isinstance(tf, str):
            continue
        norm = tf.strip().upper().replace("MIN", "M").replace(" ", "")
        if norm in _VALID_TIMEFRAMES and norm not in out:
            out.append("1H" if norm == "1H" else norm)
    return out[:3]


def _clean_reco_symbols(raw) -> list[str]:
    """Mantém só pares cripto USDT (o que o bot opera)."""
    if not isinstance(raw, list):
        return []
    out: list[str] = []
    for s in raw:
        if not isinstance(s, str):
            continue
        sym = s.strip().upper().replace("/", "").replace("-", "")
        if sym.endswith("USDT") and len(sym) > 4 and sym not in out:
            out.append(sym)
    return out[:4]


def _normalize_imported_strategy(raw) -> dict:
    out = raw if isinstance(raw, dict) else {}
    name = out.get("name")
    symbols = out.get("symbols")
    timeframes = out.get("timeframes")
    strategy = out.get("strategy") if isinstance(out.get("strategy"), str) else "custom"
    if strategy == "volatility-envelope":
        filters = _envelope_filters(out.get("filters"))
    elif strategy == "state-ma-cross":
        filters = _state_ma_filters(out.get("filters"))
    else:
        filters = _flatten_imported_filters(out.get("filters"))

    reco_tfs = _clean_reco_timeframes(out.get("recommendedTimeframes"))
    reco_syms = _clean_reco_symbols(out.get("recommendedSymbols"))
    reason = out.get("recommendationReason")
    reason = reason.strip() if isinstance(reason, str) else ""

    # "Sugerir + preencher": usa a recomendação como valor inicial dos campos da
    # estratégia (o usuário ainda edita antes de salvar). Cai nos defaults se vazio.
    final_symbols = (symbols if isinstance(symbols, list) and symbols
                     else (reco_syms or ["BTCUSDT"]))
    final_tfs = (timeframes if isinstance(timeframes, list) and timeframes
                 else (reco_tfs or ["1H"]))

    return {
        "name": name.strip() if isinstance(name, str) and name.strip() else "Estratégia Importada",
        "description": out.get("description") if isinstance(out.get("description"), str) else "",
        "strategy": strategy,
        "symbols": final_symbols,
        "timeframes": final_tfs,
        "mode": "futures" if out.get("mode") == "futures" else "spot",
        "filters": filters,
        "sl": _normalize_sl_tp(out.get("sl"), 1.5),
        "tp": _normalize_sl_tp(out.get("tp"), 3.0),
        "recommendedTimeframes": reco_tfs,
        "recommendedSymbols": reco_syms,
        "recommendationReason": reason,
    }


def _parse_gemini_json(text: str) -> dict:
    import json as _json
    import re as _re
    t = (text or "").strip()
    fence = _re.search(r"```(?:json)?\s*([\s\S]*?)```", t, _re.IGNORECASE)
    if fence:
        t = fence.group(1).strip()
    first = t.find("{")
    last = t.rfind("}")
    if first >= 0 and last > first:
        t = t[first:last + 1]
    return _json.loads(t)


def _map_pine_with_gemini(pine_script: str, api_key: str) -> dict:
    import httpx
    system_prompt = (
        "Você é um compilador de estratégias de trading automatizadas.\n"
        "Analise o script em Pine Script (TradingView) fornecido e extraia:\n"
        "1. Indicadores utilizados (ex: RSI, Bandas de Bollinger, Médias Móveis, MACD, etc.).\n"
        "2. Parâmetros numéricos associados (ex: período do RSI, desvio padrão das BBs, comprimento das EMAs).\n"
        "3. Condições e gatilhos de Entrada (compra/venda).\n"
        "4. Valores de Stop Loss (SL) e Take Profit (TP), mapeando-os como porcentagem decimal.\n"
        "5. RECOMENDACAO de uso: com base na natureza da estrategia (frequencia de sinais, "
        "horizonte, sensibilidade a ruido, volatilidade ideal), recomende o(s) timeframe(s) e o(s) "
        "ativo(s) MAIS adequados. IMPORTANTE: o robo opera APENAS criptomoedas na Binance em pares "
        "USDT. Portanto recomende SOMENTE pares cripto USDT (ex.: BTCUSDT, ETHUSDT, SOLUSDT, BNBUSDT, "
        "XRPUSDT, ADAUSDT, AVAXUSDT, LINKUSDT). Timeframes validos: 5m, 15m, 30m, 1H, 4H, 1D. "
        "Justifique em 1-2 frases curtas em portugues.\n\n"
        "O campo \"strategy\" deve ser UM destes valores quando o script corresponder:\n"
        "- \"volatility-envelope\": indicadores de envelope/banda de volatilidade ADAPTATIVA "
        "que usam ATR + uma centerline adaptativa (efficiency ratio de Kaufman, choppy/trend speed) "
        "e sinalizam por virada de momentum (ex.: 'Adaptive Volatility Envelope'). "
        "Para este, preencha filters com os parametros do script: "
        "{\"adapt_length\": <Adaptation Length>, \"choppy_speed\": <Choppy Market Speed>, "
        "\"trend_speed\": <Trending Market Speed>, \"vol_length\": <Volatility Length>, "
        "\"color_sens\": <Color Sensitivity>}.\n"
        "- \"state-ma-cross\": estrategias que definem um ESTADO de mercado (ex.: posicao do preco "
        "vs uma media base e a inclinacao dela) e, para cada estado, usam um PAR de medias moveis "
        "(short/long) de tipos possivelmente diferentes (ema/sma/rma/hma/wma), entrando no CRUZAMENTO "
        "(crossover) da media curta sobre a longa (ex.: 'State-aware MA Cross Strategy'). "
        "Para este, preencha filters com os parametros detectados, usando tipos em minusculo "
        "(ema/sma/rma/hma/wma): "
        "{\"base_period\": <periodo da media base do estado>, "
        "\"s00_short_type\",\"s00_short_len\",\"s00_long_type\",\"s00_long_len\", "
        "\"s01_short_type\",\"s01_short_len\",\"s01_long_type\",\"s01_long_len\", "
        "\"s10_short_type\",\"s10_short_len\",\"s10_long_type\",\"s10_long_len\", "
        "\"s11_short_type\",\"s11_short_len\",\"s11_long_type\",\"s11_long_len\"}. "
        "Os estados seguem a convencao: '00'=slope para baixo e preco abaixo da base; "
        "'01'=slope para baixo e preco acima; '10'=slope para cima e preco abaixo; "
        "'11'=slope para cima e preco acima.\n"
        "- \"range-v2\": reversao a media / suporte-resistencia com RSI + estocastico.\n"
        "- \"warrior\": seguidor de tendencia (preco>VWAP, EMAs alinhadas, RSI).\n"
        "- \"custom\": quando nao se encaixa em nenhum acima.\n\n"
        "Retorne APENAS um objeto JSON válido, sem markdown ou explicações externas, no seguinte formato:\n"
        '{\n'
        '  "name": "Nome sugerido",\n'
        '  "description": "Breve descrição do comportamento do script",\n'
        '  "strategy": "volatility-envelope" | "state-ma-cross" | "range-v2" | "warrior" | "custom",\n'
        '  "filters": {},\n'
        '  "sl": { "type": "percentage", "value": 1.5 },\n'
        '  "tp": { "type": "percentage", "value": 3.0 },\n'
        '  "recommendedTimeframes": ["4H", "1D"],\n'
        '  "recommendedSymbols": ["BTCUSDT", "ETHUSDT"],\n'
        '  "recommendationReason": "Por que esses timeframes e ativos combinam com a estratégia."\n'
        '}\n\n'
        "### Pine Script:\n```\n" + pine_script[:20000] + "\n```"
    )
    models = ["gemini-2.5-flash", "gemini-1.5-flash"]
    last_err = None
    for model in models:
        try:
            resp = httpx.post(
                f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={api_key}",
                json={
                    "contents": [{"parts": [{"text": system_prompt}]}],
                    "generationConfig": {"temperature": 0.2, "responseMimeType": "application/json"},
                },
                timeout=45.0,
            )
            data = resp.json()
            if data.get("error"):
                last_err = RuntimeError(data["error"].get("message", "Erro Gemini"))
                continue
            try:
                txt = data["candidates"][0]["content"]["parts"][0]["text"]
            except (KeyError, IndexError, TypeError):
                txt = None
            if not txt:
                last_err = RuntimeError("Resposta vazia do Gemini")
                continue
            return _normalize_imported_strategy(_parse_gemini_json(txt))
        except Exception as e:  # noqa: BLE001
            last_err = e
    raise last_err or RuntimeError("Falha ao analisar o script com a IA")


def _scrape_pine_from_url(url: str) -> str:
    """Tenta extrair o código Pine de uma página pública do TradingView."""
    import re as _re
    import httpx
    if not _re.match(r"^https?://", url, _re.IGNORECASE):
        raise ValueError("invalid_url")
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                      "(KHTML, like Gecko) Chrome/120.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8",
    }
    try:
        resp = httpx.get(url, headers=headers, follow_redirects=True, timeout=15.0)
    except Exception:
        raise ValueError("fetch_failed")
    if resp.status_code != 200:
        raise ValueError("http_error")
    html = resp.text
    if _re.search(r"just a moment|cf-browser-verification|captcha|access denied|enable javascript",
                  html, _re.IGNORECASE):
        raise ValueError("blocked")
    for pat in (r'"scriptSource"\s*:\s*"((?:[^"\\]|\\.)*)"', r'"source"\s*:\s*"((?:[^"\\]|\\.)*)"'):
        m = _re.search(pat, html)
        if m:
            raw = m.group(1)
            # Decodifica escapes JSON básicos.
            return raw.encode().decode("unicode_escape")
    raise ValueError("not_found")


@router.post("/strategies/import-tradingview")
def import_strategy_tradingview(
    body: dict = Body(...),
    current_user: User = Depends(get_current_user),
):
    """Analisa um Pine Script (colado ou via URL pública) com a IA e devolve a config."""
    api_key = settings.gemini_api_key
    if not api_key:
        return {"success": False, "error": "Chave de API do Gemini não configurada no servidor"}

    raw_pine = ((body or {}).get("rawPineScript") or "").strip()
    url = ((body or {}).get("url") or "").strip()
    pine_script = raw_pine

    if not pine_script and url:
        try:
            pine_script = _scrape_pine_from_url(url)
        except ValueError as e:
            reason = str(e)
            return {
                "success": False,
                "reason": reason,
                "error": "Não foi possível ler o código pela URL. Muitos scripts do TradingView são "
                         "protegidos ou bloqueiam acesso automático — abra o script, copie o Pine Script "
                         "e cole no campo abaixo.",
            }

    if not pine_script:
        return {"success": False, "error": "Informe a URL do TradingView ou cole o código Pine Script"}

    try:
        mapped = _map_pine_with_gemini(pine_script, api_key)
        return {"success": True, "strategy": mapped}
    except Exception as e:  # noqa: BLE001
        return {"success": False, "error": str(e) or "Falha ao analisar o script"}


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
