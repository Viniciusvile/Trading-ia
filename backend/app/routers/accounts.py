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
    exchange: str = "binance"  # "binance" | "coinbase"


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
                "exchange": getattr(c, "exchange", "binance") or "binance",
                "createdAt": c.created_at.isoformat() if c.created_at else None,
            }
            for c in rows
        ],
    }


@router.post("")
def create_account(body: AccountCreate, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    exchange = (body.exchange or "binance").lower()
    if exchange not in ("binance", "coinbase"):
        raise HTTPException(status_code=400, detail=f"Exchange não suportada: {exchange}")
    if exchange == "coinbase" and body.isTestnet:
        raise HTTPException(status_code=400, detail="A Coinbase não possui testnet")

    # Valida a credencial ANTES de salvar (antes aceitava qualquer chave e o
    # erro só aparecia na primeira ordem).
    from app.services.exchange_client import validate_credentials
    ok, err = validate_credentials(exchange, body.apiKey, body.secretKey, body.isTestnet)
    if not ok:
        raise HTTPException(status_code=400, detail=f"Credencial inválida na {exchange.title()}: {err}")

    acc = BinanceConfig(
        id=str(uuid.uuid4()),
        user_id=user.id,
        label=body.name,
        exchange=exchange,
        encrypted_api_key=encrypt(body.apiKey),
        encrypted_secret_key=encrypt(body.secretKey),
        is_testnet=body.isTestnet,
        is_active=False,
        is_valid=True,
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
