from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session
from sqlalchemy import func
from app.database import get_db
from app.deps import get_current_user
from app.models.user import User
from app.models.trade_log import TradeLog

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
