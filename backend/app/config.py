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
    stripe_webhook_secret: str = ""

    class Config:
        env_file = ".env"

settings = Settings()
