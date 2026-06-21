from sqlalchemy.orm import Session
from fastapi import HTTPException
from app.models.strategy import Strategy
from app.models.user import User
from app.schemas.strategy import StrategyCreate, StrategyConditions

def create_strategy(db: Session, user: User, data: StrategyCreate) -> Strategy:
    existing = db.query(Strategy).filter(Strategy.user_id == user.id).count()
    # Limite de estratégias usa max_strategies do plano (NÃO max_bots, que é o
    # nº de robôs liberados). A trava primária está no router; esta é defesa extra.
    if existing >= user.max_strategies:
        raise HTTPException(status_code=403, detail=f"Limite de {user.max_strategies} estratégias atingido")
    strategy = Strategy(
        user_id=user.id,
        name=data.name,
        symbol=data.symbol,
        timeframe=data.timeframe,
        conditions_json=data.conditions.model_dump_json(),
    )
    db.add(strategy)
    db.commit()
    db.refresh(strategy)
    return strategy

def list_strategies(db: Session, user: User) -> list[Strategy]:
    return db.query(Strategy).filter(Strategy.user_id == user.id).all()

def get_strategy(db: Session, user: User, strategy_id: str) -> Strategy:
    s = db.query(Strategy).filter(Strategy.id == strategy_id, Strategy.user_id == user.id).first()
    if not s:
        raise HTTPException(status_code=404, detail="Estratégia não encontrada")
    return s

def delete_strategy(db: Session, user: User, strategy_id: str) -> None:
    s = get_strategy(db, user, strategy_id)
    if s.is_active:
        raise HTTPException(status_code=400, detail="Pause o bot antes de deletar a estratégia")
    db.delete(s)
    db.commit()

def parse_conditions(strategy: Strategy) -> StrategyConditions:
    return StrategyConditions.model_validate_json(strategy.conditions_json)
