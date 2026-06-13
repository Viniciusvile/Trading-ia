from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from app.database import get_db
from app.deps import get_current_user
from app.models.user import User
from app.models.binance_config import BinanceConfig
from app.schemas.binance import BinanceConfigCreate, BinanceTestResult
from app.services import binance as binance_service

router = APIRouter()

@router.post("/config", status_code=201)
def save_config(body: BinanceConfigCreate, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    binance_service.save_binance_config(db, user, body.api_key, body.secret_key, body.is_testnet)
    return {"message": "Configuração salva. Use /test para validar."}

@router.get("/config")
def get_config(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    config = binance_service.get_binance_config(db, user)
    if not config:
        raise HTTPException(status_code=404, detail="Nenhuma configuração encontrada")
    return config

@router.delete("/config", status_code=204)
def delete_config(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    config = db.query(BinanceConfig).filter(BinanceConfig.user_id == user.id).first()
    if config:
        db.delete(config)
        db.commit()

@router.post("/test", response_model=BinanceTestResult)
def test_connection(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    return binance_service.check_binance_connection(db, user)
