from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from binance.client import Client
from binance.exceptions import BinanceAPIException
from app.database import get_db
from app.deps import get_current_user
from app.models.user import User
from app.models.binance_config import BinanceConfig
from app.services.crypto import decrypt

router = APIRouter()


def _client_for(db: Session, user: User) -> Client:
    config = db.query(BinanceConfig).filter(BinanceConfig.user_id == user.id).first()
    if not config:
        raise HTTPException(status_code=400, detail="Configure a Binance em Configurações.")
    return Client(
        decrypt(config.encrypted_api_key),
        decrypt(config.encrypted_secret_key),
        testnet=config.is_testnet,
    )


@router.get("/balances")
def get_balances(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    try:
        client = _client_for(db, user)
        account = client.get_account()
        balances = []
        total_usdt = 0.0
        prices = {p["symbol"]: float(p["price"]) for p in client.get_all_tickers()}

        for b in account.get("balances", []):
            free = float(b["free"])
            locked = float(b["locked"])
            total = free + locked
            if total <= 0:
                continue
            asset = b["asset"]
            value_usdt = 0.0
            if asset == "USDT":
                value_usdt = total
            else:
                symbol = f"{asset}USDT"
                if symbol in prices:
                    value_usdt = total * prices[symbol]
            balances.append({
                "asset": asset,
                "free": free,
                "locked": locked,
                "total": total,
                "value_usdt": round(value_usdt, 2),
            })
            total_usdt += value_usdt

        balances.sort(key=lambda x: x["value_usdt"], reverse=True)
        return {
            "total_usdt": round(total_usdt, 2),
            "balances": balances,
            "account_type": account.get("accountType"),
        }
    except BinanceAPIException as e:
        raise HTTPException(status_code=400, detail=f"Erro Binance: {e.message}")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erro: {str(e)}")
