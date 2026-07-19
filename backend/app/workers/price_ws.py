"""Serviço de preço via WebSocket da Binance (anti-ban -1003).

Antes, a página Mercado batia em `get_ticker` (REST) a cada 5s por símbolo — peso
de rate-limit constante que levava ao ban -1003 ("Way too much request weight").
A própria Binance recomenda WebSocket para dados ao vivo.

Este processo (pm2: saas-price-ws) mantém UMA conexão WebSocket com o stream
combinado `@ticker` dos símbolos monitorados e grava a última cotação de cada um
no Redis (hash `binance:tickers`). O endpoint /market/tickers lê desse cache —
peso REST ZERO enquanto o WS estiver fresco.

Roda standalone: `python -m app.workers.price_ws` (via ecosystem pm2).
"""
from __future__ import annotations

import asyncio
import json
import time

import redis
import websockets

from app.config import settings

# Hash no Redis onde ficam as cotações. Compartilhado com o endpoint /market/tickers.
REDIS_TICKERS_KEY = "binance:tickers"

# Símbolos monitorados (watchlist do master + pares da UI). Manter alinhado com
# DEFAULT_SYMBOLS do market router e a watchlist do MasterBot.
SYMBOLS = [
    "BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT", "BNBUSDT", "ADAUSDT",
    "DOGEUSDT", "AVAXUSDT", "LTCUSDT", "LINKUSDT", "TRXUSDT",
]

_WS_BASE = "wss://stream.binance.com:9443/stream?streams="


def _stream_url(symbols: list[str]) -> str:
    return _WS_BASE + "/".join(f"{s.lower()}@ticker" for s in symbols)


def _to_payload(d: dict) -> dict:
    """Converte o payload @ticker da Binance no mesmo formato do /market/tickers."""
    return {
        "symbol": d["s"],
        "price": float(d["c"]),          # último preço
        "change_pct": float(d["P"]),     # variação 24h %
        "volume_usdt": float(d["q"]),    # volume 24h em quote (USDT)
        "high": float(d["h"]),
        "low": float(d["l"]),
        "ts": int(time.time()),
    }


async def _run() -> None:
    r = redis.from_url(settings.redis_url)
    url = _stream_url(SYMBOLS)
    while True:
        try:
            async with websockets.connect(url, ping_interval=20, ping_timeout=20,
                                           max_queue=64) as ws:
                print(f"[price_ws] conectado a {len(SYMBOLS)} streams @ticker", flush=True)
                async for msg in ws:
                    try:
                        data = json.loads(msg).get("data") or {}
                        sym = data.get("s")
                        if not sym:
                            continue
                        r.hset(REDIS_TICKERS_KEY, sym, json.dumps(_to_payload(data)))
                    except Exception as e:  # noqa: BLE001 — 1 msg ruim não derruba o loop
                        print(f"[price_ws] msg ignorada: {e}", flush=True)
        except Exception as e:  # noqa: BLE001 — reconecta em qualquer falha de socket
            print(f"[price_ws] desconectado ({e}); reconectando em 5s...", flush=True)
            await asyncio.sleep(5)


def main() -> None:
    asyncio.run(_run())


if __name__ == "__main__":
    main()
