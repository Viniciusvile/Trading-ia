from pydantic_settings import BaseSettings

class Settings(BaseSettings):
    database_url: str
    secret_key: str
    algorithm: str = "HS256"
    access_token_expire_minutes: int = 60
    encryption_key: str
    redis_url: str = "redis://localhost:6379/0"
    frontend_url: str = "http://localhost:3001"
    stripe_secret_key: str = ""
    stripe_price_basic: str = ""
    stripe_price_pro: str = ""
    stripe_price_ultra: str = ""
    stripe_webhook_secret: str = ""
    google_client_id: str = ""
    gemini_api_key: str = ""
    # Liga/desliga a otimização automática por IA (Gemini) do Micro-Scalper.
    # OFF por padrão: a API do Gemini estava retornando 429/403 e, como a IA era
    # o único caminho de reativação de um par, isso trancava todos os pares para
    # sempre. Com OFF, o otimizador não desativa por backtest e a proteção fica
    # com os guards de runtime (risk_guard / market_regime).
    scalper_ia_enabled: bool = False
    vapid_public_key: str = ""
    vapid_private_pem_b64: str = ""
    vapid_subject: str = "mailto:admin@vexacripto.com.br"

    class Config:
        env_file = ".env"

settings = Settings()
