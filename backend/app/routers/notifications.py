from fastapi import APIRouter, Depends, Query, Body
from sqlalchemy.orm import Session
from app.database import get_db
from app.deps import get_current_user
from app.models.user import User
from app.models.notification import Notification
from typing import List, Optional

router = APIRouter()

@router.get("")
def list_notifications(
    limit: Optional[int] = Query(None),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    query = db.query(Notification).filter(Notification.user_id == user.id).order_by(Notification.created_at.desc())
    if limit:
        query = query.limit(limit)
    
    rows = query.all()
    
    notifications_list = []
    for r in rows:
        notifications_list.append({
            "id": r.id,
            "title": r.title,
            "message": r.message,
            "type": r.type,
            "isRead": r.is_read,
            "createdAt": r.created_at.isoformat() + "Z",
        })
        
    return {
        "success": True,
        "notifications": notifications_list
    }

@router.post("/read")
def read_notifications(
    body: Optional[dict] = Body(None),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    ids = body.get("ids") if body else None
    
    query = db.query(Notification).filter(Notification.user_id == user.id)
    if ids:
        query = query.filter(Notification.id.in_(ids))
        
    query.update({Notification.is_read: True}, synchronize_session=False)
    db.commit()
    return {"success": True}
