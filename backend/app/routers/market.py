from fastapi import APIRouter, HTTPException, Query
from binance.client import Client
from binance.exceptions import BinanceAPIException

router = APIRouter()

DEFAULT_SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "ADAUSDT", "DOGEUSDT", "AVAXUSDT"]


@router.get("/tickers")
def get_tickers(symbols: str | None = Query(None)):
    try:
        client = Client()
        wanted = symbols.split(",") if symbols else DEFAULT_SYMBOLS
        all_24h = {t["symbol"]: t for t in client.get_ticker()}
        out = []
        for sym in wanted:
            t = all_24h.get(sym)
            if not t:
                continue
            out.append({
                "symbol": sym,
                "price": float(t["lastPrice"]),
                "change_pct": float(t["priceChangePercent"]),
                "volume_usdt": float(t["quoteVolume"]),
                "high": float(t["highPrice"]),
                "low": float(t["lowPrice"]),
            })
        return out
    except BinanceAPIException as e:
        raise HTTPException(status_code=400, detail=f"Erro Binance: {e.message}")


@router.get("/candles")
def get_candles(symbol: str = Query(...), interval: str = Query("1h"), limit: int = Query(100)):
    try:
        client = Client()
        raw = client.get_klines(symbol=symbol.upper(), interval=interval, limit=limit)
        return [
            {
                "time": k[0],
                "open": float(k[1]),
                "high": float(k[2]),
                "low": float(k[3]),
                "close": float(k[4]),
                "volume": float(k[5]),
            }
            for k in raw
        ]
    except BinanceAPIException as e:
        raise HTTPException(status_code=400, detail=f"Erro Binance: {e.message}")
