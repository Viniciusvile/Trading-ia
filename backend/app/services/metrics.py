from sqlalchemy.orm import Session
from sqlalchemy import func
from app.models.trade_log import TradeLog

def get_dashboard_metrics(db: Session, user_id: str) -> dict:
    trades = db.query(TradeLog).filter(TradeLog.user_id == user_id).all()

    total = len(trades)
    filled = [t for t in trades if t.status == "filled"]
    errors = [t for t in trades if t.status == "error"]

    win_rate = round(len(filled) / total * 100, 1) if total > 0 else 0.0

    total_volume = sum(t.quantity * t.price for t in filled)

    buys = [t for t in filled if t.side == "BUY"]
    sells = [t for t in filled if t.side == "SELL"]

    buy_volume = sum(t.quantity * t.price for t in buys)
    sell_volume = sum(t.quantity * t.price for t in sells)
    pnl = sell_volume - buy_volume

    return {
        "total_trades": total,
        "filled_trades": len(filled),
        "error_trades": len(errors),
        "win_rate": win_rate,
        "total_volume_usdt": round(total_volume, 2),
        "estimated_pnl_usdt": round(pnl, 2),
    }
