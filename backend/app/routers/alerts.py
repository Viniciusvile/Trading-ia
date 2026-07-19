from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from pydantic import BaseModel
from app.database import get_db
from app.deps import get_current_user
from app.models.user import User
from app.models.price_alert import PriceAlert

router = APIRouter()


class AlertCreate(BaseModel):
    symbol: str
    condition: str
    target_price: float
    recurring: bool = False


def _serialize(a: PriceAlert) -> dict:
    return {
        "id": a.id,
        "symbol": a.symbol,
        "condition": a.condition,
        "target_price": a.target_price,
        "recurring": a.recurring,
        "is_active": a.is_active,
        "triggered_at": a.triggered_at.isoformat() + "Z" if a.triggered_at else None,
        "created_at": a.created_at.isoformat() + "Z",
    }


@router.get("")
def list_alerts(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    rows = (
        db.query(PriceAlert)
        .filter(PriceAlert.user_id == user.id)
        .order_by(PriceAlert.created_at.desc())
        .all()
    )
    return {"success": True, "alerts": [_serialize(r) for r in rows]}


@router.post("")
def create_alert(
    body: AlertCreate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    if body.condition not in ("above", "below"):
        raise HTTPException(400, "condition deve ser 'above' ou 'below'")
    if body.target_price <= 0:
        raise HTTPException(400, "target_price deve ser maior que zero")

    alert = PriceAlert(
        user_id=user.id,
        symbol=body.symbol.upper().strip(),
        condition=body.condition,
        target_price=body.target_price,
        recurring=body.recurring,
    )
    db.add(alert)
    db.commit()
    db.refresh(alert)
    return {"success": True, "alert": _serialize(alert)}


@router.delete("/{alert_id}")
def delete_alert(
    alert_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    a = db.query(PriceAlert).filter(
        PriceAlert.id == alert_id, PriceAlert.user_id == user.id
    ).first()
    if not a:
        raise HTTPException(404, "Alerta não encontrado")
    db.delete(a)
    db.commit()
    return {"success": True}


@router.patch("/{alert_id}/toggle")
def toggle_alert(
    alert_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    a = db.query(PriceAlert).filter(
        PriceAlert.id == alert_id, PriceAlert.user_id == user.id
    ).first()
    if not a:
        raise HTTPException(404, "Alerta não encontrado")
    a.is_active = not a.is_active
    db.commit()
    return {"success": True, "is_active": a.is_active}
