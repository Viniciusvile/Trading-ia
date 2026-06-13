from datetime import datetime
from sqlalchemy.orm import Session
from binance.client import Client
from binance.exceptions import BinanceAPIException
from app.models.binance_config import BinanceConfig
from app.models.user import User
from app.services.crypto import encrypt, decrypt

def save_binance_config(db: Session, user: User, api_key: str, secret_key: str, is_testnet: bool) -> BinanceConfig:
    config = db.query(BinanceConfig).filter(BinanceConfig.user_id == user.id).first()
    if config:
        config.encrypted_api_key = encrypt(api_key)
        config.encrypted_secret_key = encrypt(secret_key)
        config.is_testnet = is_testnet
        config.is_valid = False
    else:
        config = BinanceConfig(
            user_id=user.id,
            encrypted_api_key=encrypt(api_key),
            encrypted_secret_key=encrypt(secret_key),
            is_testnet=is_testnet,
        )
        db.add(config)
    db.commit()
    db.refresh(config)
    return config

def get_binance_config(db: Session, user: User) -> dict | None:
    config = db.query(BinanceConfig).filter(BinanceConfig.user_id == user.id).first()
    if not config:
        return None
    decrypted_key = decrypt(config.encrypted_api_key)
    hint = "..." + decrypted_key[-4:] if len(decrypted_key) >= 4 else "***"
    return {
        "id": config.id,
        "user_id": config.user_id,
        "is_testnet": config.is_testnet,
        "is_valid": config.is_valid,
        "last_tested_at": config.last_tested_at,
        "api_key_hint": hint,
    }

def check_binance_connection(db: Session, user: User) -> dict:
    config = db.query(BinanceConfig).filter(BinanceConfig.user_id == user.id).first()
    if not config:
        return {"success": False, "message": "Nenhuma chave configurada"}
    try:
        api_key = decrypt(config.encrypted_api_key)
        secret_key = decrypt(config.encrypted_secret_key)
        client = Client(api_key, secret_key, testnet=config.is_testnet)
        account = client.get_account()
        config.is_valid = True
        config.last_tested_at = datetime.utcnow()
        db.commit()
        return {"success": True, "message": "Conexão bem-sucedida", "account_type": account.get("accountType")}
    except BinanceAPIException as e:
        config.is_valid = False
        db.commit()
        return {"success": False, "message": f"Erro Binance: {e.message}"}
    except Exception as e:
        return {"success": False, "message": f"Erro de conexão: {str(e)}"}
