from pydantic import BaseModel, EmailStr

class RegisterRequest(BaseModel):
    email: EmailStr
    password: str

class LoginRequest(BaseModel):
    email: EmailStr
    password: str

class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"

class UserResponse(BaseModel):
    id: str
    email: str
    name: str | None = None
    picture: str | None = None
    plan: str
    max_bots: int
    max_strategies: int
    stripe_customer_id: str | None = None
    stripe_subscription_id: str | None = None
    plan_status: str
    is_active: bool

    class Config:
        from_attributes = True

class PasswordResetRequest(BaseModel):
    email: EmailStr

class PasswordResetConfirm(BaseModel):
    token: str
    new_password: str

class GoogleLoginRequest(BaseModel):
    credential: str

