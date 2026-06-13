from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session
from app.database import get_db
from app.deps import get_current_user
from app.models.user import User
from app.schemas.strategy import StrategyCreate, StrategyConditions
from app.services import strategy as strategy_service
from app.services.bot_templates import BOT_TEMPLATES, get_template

router = APIRouter()


class InstantiateRequest(BaseModel):
    template_id: str
    symbol: str | None = None
    timeframe: str | None = None
    size_percent: float | None = Field(default=None, ge=0.1, le=100)
    take_profit_percent: float | None = Field(default=None, ge=0.1, le=100)
    stop_loss_percent: float | None = Field(default=None, ge=0.1, le=100)
    custom_name: str | None = None


@router.get("")
def list_templates():
    return BOT_TEMPLATES


@router.post("/instantiate", status_code=201)
def instantiate(
    body: InstantiateRequest,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    template = get_template(body.template_id)
    if not template:
        raise HTTPException(status_code=404, detail="Template não encontrado")
    if not template.get("available", False):
        raise HTTPException(
            status_code=400,
            detail=template.get(
                "coming_soon_reason", "Esse bot ainda não está disponível."
            ),
        )

    conditions = dict(template["conditions"])
    if body.size_percent is not None:
        conditions["entry_action"]["size_percent"] = body.size_percent
    if body.take_profit_percent is not None:
        conditions["exit_conditions"]["take_profit_percent"] = body.take_profit_percent
    if body.stop_loss_percent is not None:
        conditions["exit_conditions"]["stop_loss_percent"] = body.stop_loss_percent

    create_payload = StrategyCreate(
        name=body.custom_name or template["name"],
        symbol=body.symbol or template["default_symbol"],
        timeframe=body.timeframe or template["default_timeframe"],
        conditions=StrategyConditions(**conditions),
    )

    s = strategy_service.create_strategy(db, user, create_payload)
    return {
        "id": s.id,
        "name": s.name,
        "symbol": s.symbol,
        "timeframe": s.timeframe,
        "is_active": s.is_active,
        "template_id": body.template_id,
    }
