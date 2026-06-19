from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session
from app.database import get_db
from app.deps import get_current_user
from app.models.user import User
from app.schemas.strategy import StrategyCreate, StrategyConditions
from app.services import strategy as strategy_service
from datetime import datetime

router = APIRouter()

def _serialize(s, conditions: StrategyConditions) -> dict:
    return {
        "id": s.id, "name": s.name, "symbol": s.symbol,
        "timeframe": s.timeframe, "is_active": s.is_active,
        "created_at": s.created_at,
        "activated_at": s.activated_at.isoformat() if s.activated_at else None,
        "conditions": conditions.model_dump()
    }

@router.post("", status_code=201)
def create(body: StrategyCreate, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    s = strategy_service.create_strategy(db, user, body)
    return _serialize(s, body.conditions)

@router.get("")
def list_all(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    strategies = strategy_service.list_strategies(db, user)
    return [_serialize(s, strategy_service.parse_conditions(s)) for s in strategies]

@router.get("/{strategy_id}")
def get_one(strategy_id: str, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    s = strategy_service.get_strategy(db, user, strategy_id)
    return _serialize(s, strategy_service.parse_conditions(s))

@router.delete("/{strategy_id}", status_code=204)
def delete(strategy_id: str, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    strategy_service.delete_strategy(db, user, strategy_id)

@router.post("/{strategy_id}/activate")
def activate(strategy_id: str, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    s = strategy_service.get_strategy(db, user, strategy_id)
    s.is_active = True
    s.activated_at = datetime.utcnow()
    db.commit()
    try:
        from app.workers.celery_app import celery
        from app.workers.bot_runner import run_strategy
        celery.add_periodic_task(300.0, run_strategy.s(strategy_id), name=f"bot-{strategy_id}")
    except Exception:
        pass  # Redis pode não estar disponível em desenvolvimento
    return {"status": "activated"}

@router.post("/{strategy_id}/deactivate")
def deactivate(strategy_id: str, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    s = strategy_service.get_strategy(db, user, strategy_id)
    s.is_active = False
    db.commit()
    return {"status": "deactivated"}
