"""Fan-out de notificações: grava Notification + envia Web Push para subscriptions ativas.

Uso:
    from app.services.notify import notify
    notify(db, user_id, "Título", "Mensagem", "info")

Substitui o padrão de instanciar Notification diretamente nos workers/routers.
Web Push é disparado em background (thread) para não bloquear o ciclo do bot.
"""
from __future__ import annotations

import base64
import json
import threading
from typing import Literal

from sqlalchemy.orm import Session

from app.config import settings
from app.models.notification import Notification
from app.models.push_subscription import PushSubscription

NotifType = Literal["info", "success", "warning", "error"]


def _send_web_push(endpoint: str, keys: dict, title: str, body: str) -> None:
    """Envia uma Web Push notification. Silencia erros — push é best-effort."""
    try:
        from pywebpush import webpush, WebPushException
        vapid_private_b64 = settings.vapid_private_pem_b64
        vapid_subject = settings.vapid_subject
        if not vapid_private_b64:
            return
        private_pem = base64.b64decode(vapid_private_b64).decode()
        webpush(
            subscription_info={"endpoint": endpoint, "keys": keys},
            data=json.dumps({"title": title, "body": body}),
            vapid_private_key=private_pem,
            vapid_claims={"sub": vapid_subject},
        )
    except Exception:
        pass


def notify(
    db: Session,
    user_id: str,
    title: str,
    message: str,
    type: NotifType = "info",
) -> Notification:
    """Grava notificação in-app e dispara Web Push em background."""
    notif = Notification(user_id=user_id, title=title, message=message, type=type)
    db.add(notif)

    # Fan-out Web Push (best-effort, não bloqueia)
    subs = db.query(PushSubscription).filter(PushSubscription.user_id == user_id).all()
    for sub in subs:
        t = threading.Thread(
            target=_send_web_push,
            args=(sub.endpoint, sub.keys, title, message),
            daemon=True,
        )
        t.start()

    return notif
