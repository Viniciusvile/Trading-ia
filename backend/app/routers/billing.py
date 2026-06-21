from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session
from app.database import get_db
from app.deps import get_current_user
from app.models.user import User, PlanType
from app.config import settings

router = APIRouter()

# As chaves vêm do pydantic-settings (carrega o .env). os.getenv não enxerga
# o .env porque o pydantic-settings não exporta os valores para os.environ.
PLAN_PRICES = {
    "basic": settings.stripe_price_basic,
    "pro": settings.stripe_price_pro,
    "ultra": settings.stripe_price_ultra,
}

def _get_stripe():
    try:
        import stripe
        stripe.api_key = settings.stripe_secret_key
        return stripe
    except ImportError:
        raise HTTPException(status_code=503, detail="Stripe não configurado")

@router.get("/plans")
def list_plans():
    return [
        {"id": "free", "name": "Trial (Free)", "price_brl": 0, "max_bots": 1, "max_strategies": 3, "features": ["1 Robô ativo (MasterBot)", "Até 3 estratégias salvas", "Backtesting manual"]},
        {"id": "basic", "name": "Starter", "price_brl": 49, "max_bots": 1, "max_strategies": 3, "features": ["1 Robô ativo (MasterBot)", "Até 3 estratégias salvas", "Backtesting avançado"]},
        {"id": "pro", "name": "Plus", "price_brl": 79, "max_bots": 2, "max_strategies": 6, "features": ["Até 2 Robôs ativos (MasterBot + Micro-Scalper)", "Até 6 estratégias salvas", "Parâmetros padrão do Micro-Scalper"]},
        {"id": "ultra", "name": "Pro", "price_brl": 99, "max_bots": 3, "max_strategies": 6, "features": ["Até 3 Robôs ativos (MasterBot + Micro-Scalper + Adaptive)", "Até 6 estratégias salvas", "Customização completa do Micro-Scalper", "Suporte prioritário"]},
    ]

@router.post("/checkout/{plan}")
def create_checkout(plan: str, request: Request, user: User = Depends(get_current_user)):
    stripe_key = settings.stripe_secret_key
    
    # Resolve frontend_url de forma dinâmica usando o cabeçalho referer ou origin
    referer = request.headers.get("referer")
    origin = request.headers.get("origin")
    frontend_url = None
    
    if referer:
        from urllib.parse import urlparse
        parsed = urlparse(referer)
        frontend_url = f"{parsed.scheme}://{parsed.netloc}"
    elif origin:
        frontend_url = origin
        
    if not frontend_url:
        frontend_url = settings.frontend_url or "http://localhost:3000"

    # Valida o plano solicitado.
    if plan not in ("basic", "pro", "ultra"):
        raise HTTPException(status_code=400, detail="Plano inválido")

    # NUNCA ativar plano sem pagamento: se o Stripe não estiver configurado,
    # falha explicitamente em vez de liberar o plano de graça (modo mock removido).
    if not stripe_key or not PLAN_PRICES.get(plan):
        raise HTTPException(
            status_code=503,
            detail="Pagamento indisponível no momento. Tente novamente em instantes.",
        )

    stripe = _get_stripe()
    session = stripe.checkout.Session.create(
        payment_method_types=["card"],
        line_items=[{"price": PLAN_PRICES[plan], "quantity": 1}],
        mode="subscription",
        success_url=f"{frontend_url}/planos?success=1",
        cancel_url=f"{frontend_url}/planos?canceled=1",
        metadata={"user_id": user.id, "plan": plan},
    )
    return {"checkout_url": session.url}

@router.post("/portal")
def create_portal(request: Request, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    if not user.stripe_customer_id:
        raise HTTPException(status_code=400, detail="Usuário sem cliente configurado no Stripe.")
        
    stripe_key = settings.stripe_secret_key
    if not stripe_key:
        raise HTTPException(status_code=503, detail="Stripe não configurado no servidor.")
        
    # Resolve frontend_url de forma dinâmica
    referer = request.headers.get("referer")
    origin = request.headers.get("origin")
    frontend_url = None
    
    if referer:
        from urllib.parse import urlparse
        parsed = urlparse(referer)
        frontend_url = f"{parsed.scheme}://{parsed.netloc}/ajustes"
    elif origin:
        frontend_url = f"{origin}/ajustes"
        
    if not frontend_url:
        frontend_url = f"{settings.frontend_url or 'http://localhost:3000'}/ajustes"

    stripe = _get_stripe()
    try:
        session = stripe.billing_portal.Session.create(
            customer=user.stripe_customer_id,
            return_url=frontend_url,
        )
        return {"portal_url": session.url}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.post("/webhook")
async def stripe_webhook(request: Request, db: Session = Depends(get_db)):
    stripe = _get_stripe()
    payload = await request.body()
    sig = request.headers.get("stripe-signature", "")
    webhook_secret = settings.stripe_webhook_secret

    try:
        event = stripe.Webhook.construct_event(payload, sig, webhook_secret)
    except Exception:
        raise HTTPException(status_code=400, detail="Webhook inválido")

    from app.services.plans import apply_plan_entitlements, disable_disallowed_bots

    event_type = event["type"]
    # event["data"]["object"] é um StripeObject (ex: checkout._session.Session).
    # NÃO usar .get() aninhado nem dict() — ambos quebram (AttributeError/KeyError).
    # Acesso seguro só por indexação com checagem de presença.
    obj = event["data"]["object"]

    def _g(o, key, default=None):
        try:
            return o[key] if key in o else default
        except (TypeError, KeyError):
            return default

    if event_type == "checkout.session.completed":
        meta = _g(obj, "metadata") or {}
        user_id = _g(meta, "user_id")
        plan_name = _g(meta, "plan")

        user = None
        if user_id:
            user = db.query(User).filter(User.id == user_id).first()

        if user and plan_name in ("basic", "pro", "ultra"):
            user.stripe_customer_id = _g(obj, "customer")
            user.stripe_subscription_id = _g(obj, "subscription")
            user.plan = PlanType(plan_name)
            user.plan_status = "active"
            apply_plan_entitlements(user, plan_name)
            db.commit()

    elif event_type == "invoice.payment_succeeded":
        customer_id = _g(obj, "customer")
        subscription_id = _g(obj, "subscription")

        if customer_id:
            user = db.query(User).filter(User.stripe_customer_id == customer_id).first()
            if user:
                user.stripe_subscription_id = subscription_id
                user.plan_status = "active"
                db.commit()

    elif event_type == "customer.subscription.deleted":
        customer_id = _g(obj, "customer")

        if customer_id:
            user = db.query(User).filter(User.stripe_customer_id == customer_id).first()
            if user:
                user.plan = PlanType.free
                user.plan_status = "canceled"
                apply_plan_entitlements(user, "free")
                disable_disallowed_bots(db, user)
                db.commit()

    elif event_type == "customer.subscription.updated":
        customer_id = _g(obj, "customer")
        status = _g(obj, "status")

        if customer_id:
            user = db.query(User).filter(User.stripe_customer_id == customer_id).first()
            if user:
                user.plan_status = status
                if status not in ("active", "trialing"):
                    user.plan = PlanType.free
                    apply_plan_entitlements(user, "free")
                else:
                    plan_name = _g(_g(obj, "metadata") or {}, "plan")
                    if plan_name in ("basic", "pro", "ultra"):
                        user.plan = PlanType(plan_name)
                        apply_plan_entitlements(user, plan_name)
                # downgrade pode reduzir o plano: desliga bots não mais permitidos
                disable_disallowed_bots(db, user)
                db.commit()

    return {"received": True}
