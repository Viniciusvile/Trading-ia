from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from app.routers import auth, binance, strategy, trades, dashboard, billing, wallet, market, settings as settings_router, templates

app = FastAPI(title="Trading Bots SaaS", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router, prefix="/api/auth", tags=["auth"])
app.include_router(binance.router, prefix="/api/binance", tags=["binance"])
app.include_router(strategy.router, prefix="/api/strategies", tags=["strategies"])
app.include_router(trades.router, prefix="/api/trades", tags=["trades"])
app.include_router(dashboard.router, prefix="/api/dashboard", tags=["dashboard"])
app.include_router(billing.router, prefix="/api/billing", tags=["billing"])
app.include_router(wallet.router, prefix="/api/wallet", tags=["wallet"])
app.include_router(market.router, prefix="/api/market", tags=["market"])
app.include_router(settings_router.router, prefix="/api/settings", tags=["settings"])
app.include_router(templates.router, prefix="/api/templates", tags=["templates"])


@app.get("/health")
def health():
    return {"status": "ok"}
