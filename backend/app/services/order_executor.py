from datetime import datetime
from sqlalchemy.orm import Session
from binance.client import Client
from binance.exceptions import BinanceAPIException
from app.models.trade_log import TradeLog
from app.models.binance_config import BinanceConfig
from app.services.crypto import decrypt

def get_binance_client(db: Session, user_id: str) -> Client:
    config = db.query(BinanceConfig).filter(BinanceConfig.user_id == user_id).first()
    if not config or not config.is_valid:
        raise ValueError("API Binance não configurada ou inválida")
    return Client(decrypt(config.encrypted_api_key), decrypt(config.encrypted_secret_key), testnet=config.is_testnet)

def execute_buy(db: Session, user_id: str, strategy_id: str, symbol: str, size_percent: float) -> TradeLog:
    log = TradeLog(user_id=user_id, strategy_id=strategy_id, symbol=symbol, side="BUY", quantity=0, price=0, status="error")
    try:
        client = get_binance_client(db, user_id)
        account = client.get_account()
        usdt_balance = next((float(a["free"]) for a in account["balances"] if a["asset"] == "USDT"), 0.0)
        usdt_to_use = usdt_balance * (size_percent / 100)

        ticker = client.get_symbol_ticker(symbol=symbol)
        price = float(ticker["price"])
        quantity = round(usdt_to_use / price, 6)

        if quantity <= 0:
            raise ValueError("Saldo insuficiente para executar ordem")

        client.order_market_buy(symbol=symbol, quantity=quantity)
        log.quantity = quantity
        log.price = price
        log.status = "filled"
    except (BinanceAPIException, ValueError) as e:
        log.status = "error"
        log.error_message = str(e)

    db.add(log)
    db.commit()
    return log

def execute_sell(db: Session, user_id: str, strategy_id: str, symbol: str) -> TradeLog:
    log = TradeLog(user_id=user_id, strategy_id=strategy_id, symbol=symbol, side="SELL", quantity=0, price=0, status="error")
    try:
        client = get_binance_client(db, user_id)
        asset = symbol.replace("USDT", "")
        account = client.get_account()
        balance = next((float(a["free"]) for a in account["balances"] if a["asset"] == asset), 0.0)

        if balance <= 0:
            raise ValueError(f"Sem saldo de {asset} para vender")

        ticker = client.get_symbol_ticker(symbol=symbol)
        price = float(ticker["price"])
        client.order_market_sell(symbol=symbol, quantity=round(balance, 6))
        log.quantity = balance
        log.price = price
        log.status = "filled"
    except (BinanceAPIException, ValueError) as e:
        log.status = "error"
        log.error_message = str(e)

    db.add(log)
    db.commit()
    return log
