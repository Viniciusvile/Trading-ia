"""Endpoints multi-conta Binance (sobre binance_configs), no shape do frontend.

Espelha accountsList/accountCreate/accountActivate/accountDelete do api.ts.
A api_key e retornada MASCARADA (nunca a chave inteira). Ativar uma conta
desativa as demais do usuario (apenas uma ativa por vez).
"""
import uuid
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.database import get_db
from app.deps import get_current_user
from app.models.user import User
from app.models.binance_config import BinanceConfig
from app.services.crypto import encrypt, decrypt

router = APIRouter()


class AccountCreate(BaseModel):
    name: str
    apiKey: str
    secretKey: str
    isTestnet: bool = False


def _mask(key: str) -> str:
    if len(key) <= 8:
        return "****"
    return f"{key[:4]}...{key[-4:]}"


@router.get("")
def list_accounts(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    rows = db.query(BinanceConfig).filter(BinanceConfig.user_id == user.id).all()
    return {
        "success": True,
        "accounts": [
            {
                "id": c.id,
                "name": c.label or "Conta",
                "apiKey": _mask(decrypt(c.encrypted_api_key)),
                "isActive": bool(c.is_active),
                "isTestnet": bool(c.is_testnet),
                "createdAt": c.created_at.isoformat() if c.created_at else None,
            }
            for c in rows
        ],
    }


@router.post("")
def create_account(body: AccountCreate, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    acc = BinanceConfig(
        id=str(uuid.uuid4()),
        user_id=user.id,
        label=body.name,
        encrypted_api_key=encrypt(body.apiKey),
        encrypted_secret_key=encrypt(body.secretKey),
        is_testnet=body.isTestnet,
        is_active=False,
    )
    db.add(acc)
    db.commit()
    return {"success": True, "id": acc.id}


@router.post("/{account_id}/activate")
def activate_account(account_id: str, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    target = db.query(BinanceConfig).filter(
        BinanceConfig.id == account_id, BinanceConfig.user_id == user.id
    ).first()
    if not target:
        raise HTTPException(status_code=404, detail="Conta não encontrada")
    # apenas uma ativa por usuario
    for c in db.query(BinanceConfig).filter(BinanceConfig.user_id == user.id).all():
        c.is_active = (c.id == account_id)
    db.commit()
    return {"success": True}


@router.delete("/{account_id}")
def delete_account(account_id: str, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    target = db.query(BinanceConfig).filter(
        BinanceConfig.id == account_id, BinanceConfig.user_id == user.id
    ).first()
    if not target:
        raise HTTPException(status_code=404, detail="Conta não encontrada")
    db.delete(target)
    db.commit()
    return {"success": True}
