from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session
from app.database import get_db
from app.deps import get_current_user
from app.models.user import User
from app.models.strategy import Strategy
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
