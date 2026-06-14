from datetime import datetime, timedelta
from jose import jwt, JWTError
import bcrypt
from sqlalchemy.orm import Session
from fastapi import HTTPException, status
from app.models.user import User
from app.config import settings
import secrets

def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()

def verify_password(plain: str, hashed: str) -> bool:
    return bcrypt.checkpw(plain.encode(), hashed.encode())

def create_access_token(user_id: str) -> str:
    expire = datetime.utcnow() + timedelta(minutes=settings.access_token_expire_minutes)
    payload = {"sub": user_id, "exp": expire}
    return jwt.encode(payload, settings.secret_key, algorithm=settings.algorithm)

def decode_token(token: str) -> str:
    try:
        payload = jwt.decode(token, settings.secret_key, algorithms=[settings.algorithm])
        user_id: str = payload.get("sub")
        if user_id is None:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Token inválido")
        return user_id
    except JWTError:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Token inválido ou expirado")

def register_user(db: Session, email: str, password: str) -> User:
    if not password or len(password) < 8:
        raise HTTPException(status_code=400, detail="A senha deve ter pelo menos 8 caracteres")
    if db.query(User).filter(User.email == email).first():
        raise HTTPException(status_code=400, detail="Email já cadastrado")
    user = User(email=email, hashed_password=hash_password(password))
    db.add(user)
    db.commit()
    db.refresh(user)
    return user

def login_user(db: Session, email: str, password: str) -> str:
    user = db.query(User).filter(User.email == email).first()
    if not user or not verify_password(password, user.hashed_password):
        raise HTTPException(status_code=401, detail="Credenciais inválidas")
    if not user.is_active:
        raise HTTPException(status_code=403, detail="Conta desativada")
    return create_access_token(user.id)

def create_reset_token(db: Session, email: str) -> str:
    user = db.query(User).filter(User.email == email).first()
    if not user:
        return ""
    token = secrets.token_urlsafe(32)
    user.reset_token = token
    user.reset_token_expires = datetime.utcnow() + timedelta(hours=1)
    db.commit()
    return token

def reset_password(db: Session, token: str, new_password: str) -> None:
    user = db.query(User).filter(User.reset_token == token).first()
    if not user or not user.reset_token_expires or user.reset_token_expires < datetime.utcnow():
        raise HTTPException(status_code=400, detail="Token inválido ou expirado")
    user.hashed_password = hash_password(new_password)
    user.reset_token = None
    user.reset_token_expires = None
    db.commit()
