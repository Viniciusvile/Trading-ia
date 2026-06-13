import os
from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session
from app.database import get_db
from app.deps import get_current_user
from app.models.user import User, PlanType

router = APIRouter()

PLAN_PRICES = {
    "basic": os.getenv("STRIPE_PRICE_BASIC", ""),
    "pro": os.getenv("STRIPE_PRICE_PRO", ""),
}

PLAN_MAX_BOTS = {
    PlanType.free: 3,
    PlanType.basic: 10,
    PlanType.pro: 50,
}

def _get_stripe():
    try:
        import stripe
        stripe.api_key = os.getenv("STRIPE_SECRET_KEY", "")
        return stripe
    except ImportError:
        raise HTTPException(status_code=503, detail="Stripe não configurado")

@router.get("/plans")
def list_plans():
    return [
        {"id": "free", "name": "Free", "price_brl": 0, "max_bots": 3, "features": ["3 bots", "Backtesting básico"]},
        {"id": "basic", "name": "Basic", "price_brl": 49, "max_bots": 10, "features": ["10 bots", "Todos os indicadores", "Suporte por email"]},
        {"id": "pro", "name": "Pro", "price_brl": 149, "max_bots": 50, "features": ["50 bots", "Prioridade no suporte", "Webhooks personalizados"]},
    ]

@router.post("/checkout/{plan}")
def create_checkout(plan: str, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    if plan not in PLAN_PRICES or not PLAN_PRICES[plan]:
        raise HTTPException(status_code=400, detail="Plano inválido ou Stripe não configurado")

    stripe = _get_stripe()
    frontend_url = os.getenv("FRONTEND_URL", "http://localhost:3000")

    session = stripe.checkout.Session.create(
        payment_method_types=["card"],
        line_items=[{"price": PLAN_PRICES[plan], "quantity": 1}],
        mode="subscription",
        success_url=f"{frontend_url}/dashboard/billing?success=1",
        cancel_url=f"{frontend_url}/dashboard/billing?canceled=1",
        metadata={"user_id": user.id, "plan": plan},
    )
    return {"checkout_url": session.url}

@router.post("/webhook")
async def stripe_webhook(request: Request, db: Session = Depends(get_db)):
    stripe = _get_stripe()
    payload = await request.body()
    sig = request.headers.get("stripe-signature", "")
    webhook_secret = os.getenv("STRIPE_WEBHOOK_SECRET", "")

    try:
        event = stripe.Webhook.construct_event(payload, sig, webhook_secret)
    except Exception:
        raise HTTPException(status_code=400, detail="Webhook inválido")

    if event["type"] == "checkout.session.completed":
        session = event["data"]["object"]
        user_id = session["metadata"].get("user_id")
        plan_name = session["metadata"].get("plan")
        user = db.query(User).filter(User.id == user_id).first()
        if user and plan_name in ("basic", "pro"):
            user.plan = PlanType(plan_name)
            user.max_bots = PLAN_MAX_BOTS[user.plan]
            db.commit()

    return {"received": True}
