from pydantic import BaseModel
from datetime import datetime

class BinanceConfigCreate(BaseModel):
    api_key: str
    secret_key: str
    is_testnet: bool = False

class BinanceConfigResponse(BaseModel):
    id: str
    user_id: str
    is_testnet: bool
    is_valid: bool
    last_tested_at: datetime | None
    api_key_hint: str

    class Config:
        from_attributes = True

class BinanceTestResult(BaseModel):
    success: bool
    message: str
    account_type: str | None = None
