import json
import time

from fastapi import APIRouter, HTTPException, Query
from binance.client import Client
from binance.exceptions import BinanceAPIException

router = APIRouter()

DEFAULT_REGIME_SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT"]

# Cache de cotações alimentado pelo serviço WebSocket (app/workers/price_ws.py).
# Ler daqui = peso REST ZERO na Binance (anti-ban -1003).
_TICKER_FIELDS = ("symbol", "price", "change_pct", "volume_usdt", "high", "low")
_TICKER_FRESH_S = 30  # o WS atualiza ~1x/seg; 30s de folga cobre reconexões curtas
_redis = None


def _redis_client():
    global _redis
    if _redis is None:
        import redis
        from app.config import settings
        _redis = redis.from_url(settings.redis_url)
    return _redis


def _cached_tickers(symbols: list[str]) -> tuple[list[dict], list[str]]:
    """Retorna (tickers frescos do cache WS, símbolos faltando/velhos p/ fallback)."""
    try:
        from app.workers.price_ws import REDIS_TICKERS_KEY
        raws = _redis_client().hmget(REDIS_TICKERS_KEY, symbols)
    except Exception:
        return [], list(symbols)
    now = int(time.time())
    found, missing = [], []
    for sym, raw in zip(symbols, raws):
        if raw:
            try:
                d = json.loads(raw)
                if now - int(d.get("ts", 0)) < _TICKER_FRESH_S:
                    found.append({k: d[k] for k in _TICKER_FIELDS})
                    continue
            except (ValueError, KeyError, TypeError):
                pass
        missing.append(sym)
    return found, missing


@router.get("/regime")
def get_market_regime(symbols: str = Query("BTCUSDT,ETHUSDT,SOLUSDT")):
    """Regime de mercado (bull/bear/neutral) de cada símbolo no 4H.

    Usa o mesmo detector EMA200+EMA50 dos bots, com cache de 15 min —
    chamadas repetidas da UI não geram carga extra na Binance.
    """
    from app.services.market_regime import get_regime
    client = Client()
    wanted = [s.strip().upper() for s in symbols.split(",") if s.strip()]
    regimes: dict[str, dict] = {}
    for sym in wanted:
        try:
            regimes[sym] = get_regime(client, sym)
        except Exception as e:
            regimes[sym] = {"regime": "neutral", "reason": str(e)}
    return {"success": True, "regimes": regimes}

DEFAULT_SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "ADAUSDT", "DOGEUSDT", "AVAXUSDT"]


@router.get("/tickers")
def get_tickers(symbols: str | None = Query(None)):
    """Cotação 24h só dos símbolos pedidos.

    A versão anterior baixava a lista COMPLETA de tickers da Binance (milhares
    de pares, ~2MB) a cada chamada — lenta e sujeita a falha/rate-limit, o que
    deixava a página Mercado com preço US$ 0,00. Uma chamada por símbolo pedido
    (tipicamente 1-4) é ordens de grandeza mais leve.
    """
    wanted = [s.strip().upper() for s in (symbols.split(",") if symbols else DEFAULT_SYMBOLS) if s.strip()]

    # 1) Cache do WebSocket (peso REST ZERO). Cobre o polling de 5s da UI.
    out, missing = _cached_tickers(wanted)
    if not missing:
        return out

    # 2) Fallback REST só para os que faltam no cache (ex.: WS acabou de subir).
    client = Client()
    errors = []
    for sym in missing:
        try:
            t = client.get_ticker(symbol=sym)
            out.append({
                "symbol": sym,
                "price": float(t["lastPrice"]),
                "change_pct": float(t["priceChangePercent"]),
                "volume_usdt": float(t["quoteVolume"]),
                "high": float(t["highPrice"]),
                "low": float(t["lowPrice"]),
            })
        except BinanceAPIException as e:
            errors.append(f"{sym}: {e.message}")
    if not out and errors:
        raise HTTPException(status_code=400, detail=f"Erro Binance: {'; '.join(errors)}")
    return out


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
