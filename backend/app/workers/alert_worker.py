"""Task Celery que verifica alertas de preço a cada 60s.

Agrupa símbolos únicos → 1 chamada Binance por símbolo → dispara notificações
para alertas que cruzaram o preço-alvo. Anti-spam: alertas recorrentes têm
cooldown de 30 min entre disparos.
"""
from celery import shared_task
from datetime import datetime, timedelta

from app.database import _get_session_factory
from app.models.price_alert import PriceAlert
from app.models.notification import Notification


@shared_task(name="check_price_alerts")
def check_price_alerts():
    db = _get_session_factory()()
    try:
        alerts = db.query(PriceAlert).filter(PriceAlert.is_active == True).all()
        if not alerts:
            return {"checked": 0}

        symbols = list({a.symbol for a in alerts})

        from binance.client import Client
        client = Client()
        prices: dict[str, float] = {}
        for sym in symbols:
            try:
                t = client.get_ticker(symbol=sym)
                prices[sym] = float(t["lastPrice"])
            except Exception:
                pass

        now = datetime.utcnow()
        cooldown = timedelta(minutes=30)
        fired = 0

        for alert in alerts:
            price = prices.get(alert.symbol)
            if price is None:
                continue

            triggered = (
                (alert.condition == "above" and price >= alert.target_price)
                or (alert.condition == "below" and price <= alert.target_price)
            )
            if not triggered:
                continue

            if alert.recurring and alert.last_triggered_at:
                if now - alert.last_triggered_at < cooldown:
                    continue

            direction = "subiu acima de" if alert.condition == "above" else "caiu abaixo de"
            notif = Notification(
                user_id=alert.user_id,
                title=f"🔔 {alert.symbol} {direction} US$ {alert.target_price:,.2f}",
                message=f"Preço atual: US$ {price:,.2f}",
                type="warning",
            )
            db.add(notif)

            alert.triggered_at = now
            alert.last_triggered_at = now
            if not alert.recurring:
                alert.is_active = False

            fired += 1

        db.commit()
        return {"checked": len(alerts), "fired": fired}
    finally:
        db.close()
