from datetime import datetime, timezone, timedelta

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session
from app.database import get_db
from app.deps import get_current_user
from app.models.user import User
from app.models.strategy import Strategy
from app.models.position import Position
from app.services.metrics import get_dashboard_metrics

router = APIRouter()


@router.get("")
def get_dashboard(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    metrics = get_dashboard_metrics(db, user.id)
    active_bots = db.query(Strategy).filter(
        Strategy.user_id == user.id, Strategy.is_active == True  # noqa: E712
    ).count()
    total_bots = db.query(Strategy).filter(Strategy.user_id == user.id).count()
    return {
        **metrics,
        "active_bots": active_bots,
        "total_bots": total_bots,
        "plan": user.plan,
        "max_bots": user.max_bots,
    }


def _exit_reason(p: Position) -> str | None:
    return (p.data or {}).get("exitReason")


@router.get("/summary")
def dashboard_summary(
    tzOffset: int = Query(0, description="offset de fuso em minutos (Date.getTimezoneOffset do browser)"),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Resumo do dashboard calculado a partir das posicoes reais (entry/exit/pnl).

    PnL e win-rate vem de posicoes FECHADAS com pnl conhecido — fiel ao legado,
    ao contrario da metrica ingenua de trade_logs.
    """
    now = datetime.now(timezone.utc)
    # tzOffset do JS = minutos a SUBTRAIR do horario local p/ chegar no UTC (getTimezoneOffset).
    local_now = now - timedelta(minutes=tzOffset)
    local_midnight = local_now.replace(hour=0, minute=0, second=0, microsecond=0)
    day_start_utc = local_midnight + timedelta(minutes=tzOffset)
    window_30d = now - timedelta(days=30)

    positions = db.query(Position).filter(Position.user_id == user.id).all()

    closed = [p for p in positions if p.status == "closed"]
    open_positions = [p for p in positions if p.status == "open"]

    def _closed_at(p: Position):
        return p.closed_at

    def _opened_at(p: Position):
        return p.opened_at

    # --- Hoje (no fuso do usuario) ---
    closed_today = [p for p in closed if p.closed_at and p.closed_at >= day_start_utc]
    opened_today = [p for p in open_positions if p.opened_at and p.opened_at >= day_start_utc]
    pnl_today = round(sum((p.pnl or 0) for p in closed_today), 4)
    operations_today = len(closed_today) + len(opened_today)

    # --- Janela 30d ---
    closed_30d = [p for p in closed if p.closed_at and p.closed_at >= window_30d]
    wins = [p for p in closed_30d if (p.pnl or 0) > 0]
    losses = [p for p in closed_30d if (p.pnl or 0) <= 0]
    total_closed_30d = len(closed_30d)
    win_rate_30d = round(len(wins) / total_closed_30d * 100, 1) if total_closed_30d else None
    pnls_30d = [(p.pnl or 0) for p in closed_30d]

    tp_count = sum(1 for p in closed_30d if (_exit_reason(p) or "").lower() in ("take_profit", "tp"))
    sl_count = sum(1 for p in closed_30d if (_exit_reason(p) or "").lower() in ("stop_loss", "sl"))
    timeout_count = sum(1 for p in closed_30d if (_exit_reason(p) or "").lower() in ("timeout",))

    durations = []
    for p in closed_30d:
        if p.opened_at and p.closed_at:
            durations.append((p.closed_at - p.opened_at).total_seconds() / 60)
    avg_duration = round(sum(durations) / len(durations), 1) if durations else None

    stats_30d = {
        "wins": len(wins),
        "losses": len(losses),
        "totalPnl": round(sum(pnls_30d), 4),
        "bestPnl": round(max(pnls_30d), 4) if pnls_30d else 0,
        "worstPnl": round(min(pnls_30d), 4) if pnls_30d else 0,
        "avgDurationMin": avg_duration,
        "timeoutCount": timeout_count,
        "tpCount": tp_count,
        "slCount": sl_count,
        "totalClosed": total_closed_30d,
    } if total_closed_30d else None

    # --- Atividade recente (ultimos eventos: aberturas e fechamentos) ---
    events = []
    for p in positions:
        if p.opened_at:
            events.append((p.opened_at, {
                "time": p.opened_at.isoformat(),
                "kind": "open",
                "symbol": p.symbol,
                "title": f"Abriu {p.side or ''} {p.symbol}".strip(),
            }))
        if p.status == "closed" and p.closed_at:
            kind = "win" if (p.pnl or 0) > 0 else "loss"
            events.append((p.closed_at, {
                "time": p.closed_at.isoformat(),
                "kind": kind,
                "symbol": p.symbol,
                "title": f"Fechou {p.symbol} ({'+' if (p.pnl or 0) >= 0 else ''}{round(p.pnl or 0, 4)})",
            }))
    events.sort(key=lambda e: e[0], reverse=True)
    recent_activity = [e[1] for e in events[:15]]

    def _summary_trade(p: Position) -> dict:
        return {
            "id": p.id,
            "symbol": p.symbol,
            "side": p.side or "",
            "pnl": p.pnl,
            "entryPrice": p.entry_price or 0,
            "exitPrice": p.exit_price,
            "openedAt": p.opened_at.isoformat() if p.opened_at else "",
            "closedAt": p.closed_at.isoformat() if p.closed_at else None,
            "strategy": p.strategy,
            "exitReason": _exit_reason(p),
        }

    return {
        "success": True,
        "pnlToday": pnl_today,
        "operationsToday": operations_today,
        "winRate30d": win_rate_30d,
        "totalTrades30d": total_closed_30d,
        "openPositions": len(open_positions),
        "recentActivity": recent_activity,
        "todayTrades": [_summary_trade(p) for p in closed_today],
        "todayOpened": [_summary_trade(p) for p in opened_today],
        "stats30d": stats_30d,
    }
