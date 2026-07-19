import csv
import io
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Query
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session
from sqlalchemy import func, extract
from app.database import get_db
from app.deps import get_current_user
from app.models.user import User
from app.models.trade_log import TradeLog
from app.models.position import Position

router = APIRouter()

@router.get("")
def list_trades(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
    page: int = Query(1, ge=1),
    per_page: int = Query(20, ge=1, le=100),
):
    offset = (page - 1) * per_page
    total = db.query(func.count(TradeLog.id)).filter(TradeLog.user_id == user.id).scalar()
    trades = (
        db.query(TradeLog)
        .filter(TradeLog.user_id == user.id)
        .order_by(TradeLog.executed_at.desc())
        .offset(offset)
        .limit(per_page)
        .all()
    )
    return {
        "total": total,
        "page": page,
        "per_page": per_page,
        "items": [_serialize(t) for t in trades],
    }

def _serialize(t: TradeLog) -> dict:
    return {
        "id": t.id,
        "strategy_id": t.strategy_id,
        "symbol": t.symbol,
        "side": t.side,
        "quantity": t.quantity,
        "price": t.price,
        "status": t.status,
        "error_message": t.error_message,
        "executed_at": t.executed_at,
    }


@router.get("/export")
def export_trades_csv(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
    from_date: str = Query(None, alias="from"),
    to_date: str = Query(None, alias="to"),
    strategy: str = Query(None),
    exchange: str = Query(None),
):
    """Exporta posições fechadas como CSV para apuração de IR."""
    q = db.query(Position).filter(
        Position.user_id == user.id,
        Position.status == "closed",
        Position.closed_at.isnot(None),
    )
    if from_date:
        try:
            dt = datetime.fromisoformat(from_date).replace(tzinfo=timezone.utc)
            q = q.filter(Position.closed_at >= dt)
        except ValueError:
            pass
    if to_date:
        try:
            dt = datetime.fromisoformat(to_date).replace(tzinfo=timezone.utc)
            q = q.filter(Position.closed_at <= dt)
        except ValueError:
            pass
    if strategy:
        q = q.filter(Position.strategy == strategy)
    if exchange:
        q = q.filter(Position.data["exchange"].astext == exchange)

    positions = q.order_by(Position.closed_at.asc()).all()

    def _exit_reason(p: Position) -> str:
        return (p.data or {}).get("exitReason") or ""

    def _exchange(p: Position) -> str:
        return (p.data or {}).get("exchange") or "binance"

    def generate():
        buf = io.StringIO()
        writer = csv.writer(buf)
        writer.writerow([
            "data_abertura", "data_fechamento", "exchange", "par", "lado",
            "quantidade", "preco_entrada", "preco_saida", "stop_loss", "take_profit",
            "pnl_usd", "motivo_saida", "estrategia", "plano", "timeframe",
        ])
        yield buf.getvalue()
        for p in positions:
            buf = io.StringIO()
            writer = csv.writer(buf)
            writer.writerow([
                p.opened_at.strftime("%Y-%m-%d %H:%M:%S") if p.opened_at else "",
                p.closed_at.strftime("%Y-%m-%d %H:%M:%S") if p.closed_at else "",
                _exchange(p),
                p.symbol or "",
                p.side or "LONG",
                f"{p.quantity:.8f}" if p.quantity else "",
                f"{p.entry_price:.8f}" if p.entry_price else "",
                f"{p.exit_price:.8f}" if p.exit_price else "",
                f"{p.stop_price:.8f}" if p.stop_price else "",
                f"{p.take_profit_price:.8f}" if p.take_profit_price else "",
                f"{p.pnl:.4f}" if p.pnl is not None else "",
                _exit_reason(p),
                p.strategy or "",
                p.plan or "",
                p.timeframe or "",
            ])
            yield buf.getvalue()

    filename = f"vexa_trades_{datetime.now(timezone.utc).strftime('%Y%m%d')}.csv"
    return StreamingResponse(
        generate(),
        media_type="text/csv",
        headers={"Content-Disposition": f"attachment; filename={filename}"},
    )


@router.get("/monthly-summary")
def monthly_summary(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
    months: int = Query(12, ge=1, le=36),
):
    """PnL por mês fechado para exibição no Diário e apuração de IR."""
    from sqlalchemy import case, Integer
    rows = (
        db.query(
            extract("year", Position.closed_at).label("year"),
            extract("month", Position.closed_at).label("month"),
            func.count(Position.id).label("trades"),
            func.sum(Position.pnl).label("pnl"),
            func.sum(
                case((Position.pnl > 0, 1), else_=0).cast(Integer)
            ).label("wins"),
        )
        .filter(
            Position.user_id == user.id,
            Position.status == "closed",
            Position.closed_at.isnot(None),
            Position.pnl.isnot(None),
        )
        .group_by("year", "month")
        .order_by("year", "month")
        .limit(months)
        .all()
    )
    return {
        "success": True,
        "months": [
            {
                "year": int(r.year),
                "month": int(r.month),
                "label": f"{int(r.month):02d}/{int(r.year)}",
                "trades": int(r.trades),
                "pnl": float(r.pnl or 0),
                "wins": int(r.wins or 0),
            }
            for r in rows
        ],
    }
