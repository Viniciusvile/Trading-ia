from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session
from app.database import get_db
from app.schemas.auth import (
    RegisterRequest, LoginRequest, TokenResponse,
    UserResponse, PasswordResetRequest, PasswordResetConfirm,
    GoogleLoginRequest
)
from app.services import auth as auth_service
from app.deps import get_current_user
from app.models.user import User

router = APIRouter()

@router.post("/register", response_model=UserResponse, status_code=201)
def register(body: RegisterRequest, db: Session = Depends(get_db)):
    return auth_service.register_user(db, body.email, body.password)

@router.post("/login", response_model=TokenResponse)
def login(body: LoginRequest, db: Session = Depends(get_db)):
    token = auth_service.login_user(db, body.email, body.password)
    return TokenResponse(access_token=token)

@router.post("/google", response_model=TokenResponse)
def login_google(body: GoogleLoginRequest, db: Session = Depends(get_db)):
    token = auth_service.login_google_user(db, body.credential)
    return TokenResponse(access_token=token)

@router.get("/me", response_model=UserResponse)
def me(current_user: User = Depends(get_current_user)):
    return current_user

@router.post("/password-reset/request")
def request_reset(body: PasswordResetRequest, db: Session = Depends(get_db)):
    auth_service.create_reset_token(db, body.email)
    return {"message": "Se o email existir, você receberá as instruções"}

@router.post("/password-reset/confirm")
def confirm_reset(body: PasswordResetConfirm, db: Session = Depends(get_db)):
    auth_service.reset_password(db, body.token, body.new_password)
    return {"message": "Senha alterada com sucesso"}
