"""Router para gerenciar subscriptions de Web Push e expor a chave pública VAPID."""
from fastapi import APIRouter, Depends
from pydantic import BaseModel
from app.config import settings
from sqlalchemy.orm import Session
from sqlalchemy.exc import IntegrityError

from app.database import get_db
from app.deps import get_current_user
from app.models.user import User
from app.models.push_subscription import PushSubscription

router = APIRouter()


class SubscribeRequest(BaseModel):
    endpoint: str
    keys: dict  # {"p256dh": "...", "auth": "..."}


@router.get("/vapid-public-key")
def get_vapid_public_key():
    key = settings.vapid_public_key
    return {"success": bool(key), "publicKey": key}


@router.post("/subscribe")
def subscribe(
    body: SubscribeRequest,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    existing = (
        db.query(PushSubscription)
        .filter(PushSubscription.user_id == user.id,
                PushSubscription.endpoint == body.endpoint)
        .first()
    )
    if existing:
        existing.keys = body.keys
        db.commit()
        return {"success": True, "updated": True}

    sub = PushSubscription(user_id=user.id, endpoint=body.endpoint, keys=body.keys)
    db.add(sub)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
    return {"success": True}


@router.delete("/subscribe")
def unsubscribe(
    body: SubscribeRequest,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    db.query(PushSubscription).filter(
        PushSubscription.user_id == user.id,
        PushSubscription.endpoint == body.endpoint,
    ).delete()
    db.commit()
    return {"success": True}
