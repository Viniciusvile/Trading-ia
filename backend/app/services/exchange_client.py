"""Adapter unificado de exchange — Binance (nativo) e Coinbase (via ccxt).

Uma única interface para tudo que trading manual, leitura de saldo e os BOTS
precisam: candles, preço, saldos, compra a mercado por valor, venda a mercado,
OCO (quando suportada) e fechamento de posição.

Convenções:
  - Símbolos internos continuam no formato Binance ("BTCUSDT"). O adapter da
    Coinbase converte para "BTC/USDC" (Coinbase não negocia USDT como quote).
  - quote_asset informa à UI qual moeda de referência mostrar (USDT vs USDC).
  - supports_oco: a Coinbase não tem OCO. Nesse caso os RUNNERS protegem a
    posição por SOFTWARE: a cada ciclo comparam o preço com TP/SL gravados na
    Position e fecham a mercado quando batem (mesma mecânica do stop_failsafe).
"""
from __future__ import annotations

from sqlalchemy.orm import Session

from app.models.binance_config import BinanceConfig
from app.services.crypto import decrypt
from app.services import order_real as o


def get_active_config(db: Session, user_id: str) -> BinanceConfig | None:
    cfg = (
        db.query(BinanceConfig)
        .filter(BinanceConfig.user_id == user_id, BinanceConfig.is_active == True)  # noqa: E712
        .first()
    )
    if not cfg:
        cfg = db.query(BinanceConfig).filter(BinanceConfig.user_id == user_id).first()
    return cfg


class BinanceAdapter:
    exchange = "binance"
    quote_asset = "USDT"
    supports_oco = True

    def __init__(self, api_key: str, secret: str, testnet: bool):
        from binance.client import Client
        self.client = Client(api_key, secret, testnet=testnet)

    def price(self, symbol: str) -> float:
        return float(self.client.get_symbol_ticker(symbol=symbol)["price"])

    def free(self, asset: str) -> float:
        return o.get_free_balance(self.client, asset)

    def market_buy_quote(self, symbol: str, quote_amount: float) -> dict:
        return o.open_long(self.client, symbol, quote_amount)

    def market_sell(self, symbol: str, qty: float) -> dict:
        final_qty = o.fmt_qty(symbol, qty)
        if float(final_qty) <= 0:
            return {"ok": False, "error": "Quantidade arredondada para zero"}
        try:
            res = self.client.order_market_sell(symbol=symbol, quantity=final_qty)
        except Exception as e:
            return {"ok": False, "error": str(e)}
        filled = float(res.get("executedQty", 0) or 0)
        quote = float(res.get("cummulativeQuoteQty", 0) or 0)
        return {"ok": filled > 0, "qty": filled, "exitPrice": (quote / filled) if filled else 0.0,
                "totalQuote": quote}

    def place_oco_sell(self, symbol: str, qty: float, tp_price: float, sl_price: float) -> dict:
        oco_qty = o.fmt_qty(symbol, qty * 0.999)
        return o.place_oco_sell(self.client, symbol, oco_qty, tp_price, sl_price)

    def get_candles(self, symbol: str, interval: str = "5m", limit: int = 250) -> list[dict]:
        raw = self.client.get_klines(symbol=symbol, interval=interval.lower(), limit=limit)
        return [
            {"open": float(k[1]), "high": float(k[2]), "low": float(k[3]),
             "close": float(k[4]), "volume": float(k[5]), "vol": float(k[5]), "time": int(k[0])}
            for k in raw
        ]

    def get_oco_status(self, symbol: str, oco_id) -> dict:
        return o.get_oco(self.client, oco_id)

    def cancel_oco(self, symbol: str, oco_id) -> dict:
        return o.cancel_oco(self.client, symbol, oco_id)

    def close_long(self, symbol: str, qty: float, oco_id=None) -> dict:
        return o.close_long(self.client, symbol, qty, oco_id=oco_id)

    def total_quote_value(self) -> float:
        """Valor total da carteira em quote (USDT), só ativos com par direto.

        Faz 2 chamadas fixas (get_account + get_all_tickers) em vez de 1+N:
        antes cada ativo com saldo disparava um get_symbol_ticker próprio, o que
        deixava o saldo lento (N round-trips sequenciais até a Binance). Agora o
        preço de todos os pares vem numa única resposta e o resto é local.
        """
        account = self.client.get_account()
        balances = [
            (b["asset"], float(b["free"]) + float(b["locked"]))
            for b in account.get("balances", [])
        ]
        balances = [(a, q) for a, q in balances if q > 0]
        if not balances:
            return 0.0

        stables = ("USDT", "USDC", "BUSD", "FDUSD")
        needs_price = any(a not in stables for a, _ in balances)
        prices: dict[str, float] = {}
        if needs_price:
            for t in self.client.get_all_tickers():
                try:
                    prices[t["symbol"]] = float(t["price"])
                except (KeyError, TypeError, ValueError):
                    continue

        total = 0.0
        for asset, qty in balances:
            if asset in stables:
                total += qty
                continue
            px = prices.get(f"{asset}USDT")
            if px:
                total += qty * px
        return total


class CoinbaseAdapter:
    exchange = "coinbase"
    quote_asset = "USDC"
    supports_oco = False

    def __init__(self, api_key: str, secret: str, testnet: bool = False):
        import ccxt
        # Coinbase Advanced Trade não tem testnet — testnet é ignorado.
        # secret CDP vem com "\n" literais quando colado da UI; normaliza p/ PEM.
        self.client = ccxt.coinbase({
            "apiKey": api_key,
            "secret": secret.replace("\\n", "\n"),
            "options": {"createMarketBuyOrderRequiresPrice": False},
        })

    def _market(self, symbol: str) -> str:
        # "BTCUSDT" (interno) -> "BTC/USDC" (Coinbase)
        base = symbol.upper().replace("USDT", "").replace("USDC", "")
        return f"{base}/USDC"

    def price(self, symbol: str) -> float:
        t = self.client.fetch_ticker(self._market(symbol))
        return float(t["last"] or t["close"] or 0)

    def free(self, asset: str) -> float:
        bal = self.client.fetch_balance()
        a = "USDC" if asset == "USDT" else asset
        return float((bal.get(a) or {}).get("free") or 0)

    def market_buy_quote(self, symbol: str, quote_amount: float) -> dict:
        try:
            # createMarketBuyOrderRequiresPrice=False: amount = custo em quote
            order = self.client.create_order(self._market(symbol), "market", "buy", quote_amount)
            filled = float(order.get("filled") or 0)
            avg = float(order.get("average") or 0)
            if not filled:
                fetched = self.client.fetch_order(order["id"], self._market(symbol))
                filled = float(fetched.get("filled") or 0)
                avg = float(fetched.get("average") or avg or 0)
            return {"ok": filled > 0, "qty": filled, "avgPrice": avg, "raw": order}
        except Exception as e:
            return {"ok": False, "error": str(e), "raw": None}

    def market_sell(self, symbol: str, qty: float) -> dict:
        try:
            market = self._market(symbol)
            self.client.load_markets()
            amount = float(self.client.amount_to_precision(market, qty))
            order = self.client.create_order(market, "market", "sell", amount)
            filled = float(order.get("filled") or 0)
            avg = float(order.get("average") or 0)
            if not filled:
                fetched = self.client.fetch_order(order["id"], market)
                filled = float(fetched.get("filled") or 0)
                avg = float(fetched.get("average") or avg or 0)
            return {"ok": filled > 0, "qty": filled, "exitPrice": avg, "totalQuote": filled * avg}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def place_oco_sell(self, symbol: str, qty: float, tp_price: float, sl_price: float) -> dict:
        return {"ok": False, "error": "TP/SL automático (OCO) não suportado na Coinbase"}

    def place_stop_sell(self, symbol: str, qty: float, stop_price: float) -> dict:
        """Stop-limit real na Coinbase (stop_limit_stop_loss via Advanced Trade API).

        Limit = stop × (1 − 0.3%) — mesmo STOP_LIMIT_BUFFER_PCT calibrado na Binance.
        O watchdog por software continua como failsafe (preço ≤ stop×0.997 → fecha a mercado).
        """
        try:
            market = self._market(symbol)
            self.client.load_markets()
            limit_price = round(stop_price * (1 - 0.003), 8)
            amount = float(self.client.amount_to_precision(market, qty))
            order = self.client.create_order(
                market, "limit", "sell", amount, limit_price,
                params={
                    "stopPrice": stop_price,
                    "stopDirection": "STOP_DIRECTION_STOP_DOWN",
                },
            )
            return {"ok": True, "orderId": order.get("id"), "raw": order}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def cancel_stop(self, symbol: str, order_id: str) -> dict:
        """Cancela ordem stop antes de fechar a posição (evita ordem órfã)."""
        try:
            self.client.cancel_order(order_id, self._market(symbol))
            return {"ok": True}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def get_candles(self, symbol: str, interval: str = "5m", limit: int = 250) -> list[dict]:
        # Coinbase limita ~300 candles por chamada; ccxt retorna [ts,o,h,l,c,v]
        ohlcv = self.client.fetch_ohlcv(self._market(symbol), timeframe=interval.lower(),
                                        limit=min(limit, 300))
        return [
            {"open": float(r[1]), "high": float(r[2]), "low": float(r[3]),
             "close": float(r[4]), "volume": float(r[5] or 0), "vol": float(r[5] or 0),
             "time": int(r[0])}
            for r in ohlcv
        ]

    def get_oco_status(self, symbol: str, oco_id) -> dict:
        return {"ok": False, "status": None, "error": "OCO não suportada na Coinbase"}

    def cancel_oco(self, symbol: str, oco_id) -> dict:
        return {"ok": True}  # nada a cancelar — proteção é por software

    def close_long(self, symbol: str, qty: float, oco_id=None) -> dict:
        return self.market_sell(symbol, qty)

    def total_quote_value(self) -> float:
        bal = self.client.fetch_balance()
        totals = {a: float(q or 0) for a, q in (bal.get("total") or {}).items() if float(q or 0) > 0}
        if not totals:
            return 0.0

        stables = ("USDC", "USD", "USDT")
        needs_price = any(a not in stables for a in totals)
        # Uma única chamada fetch_tickers em vez de um fetch_ticker por ativo.
        tickers: dict = {}
        if needs_price:
            try:
                tickers = self.client.fetch_tickers()
            except Exception:
                tickers = {}

        total = 0.0
        for asset, q in totals.items():
            if asset in stables:
                total += q
                continue
            t = tickers.get(f"{asset}/USDC") or tickers.get(f"{asset}/USD")
            px = float((t or {}).get("last") or (t or {}).get("close") or 0) if t else 0.0
            if px:
                total += q * px
        return total


Adapter = BinanceAdapter | CoinbaseAdapter


def build_adapter(exchange: str, api_key: str, secret: str, testnet: bool) -> Adapter:
    if (exchange or "binance").lower() == "coinbase":
        return CoinbaseAdapter(api_key, secret)
    return BinanceAdapter(api_key, secret, testnet)


def get_adapter(db: Session, user_id: str) -> Adapter:
    cfg = get_active_config(db, user_id)
    if not cfg:
        raise ValueError("Nenhuma conta de corretora configurada")
    return build_adapter(
        getattr(cfg, "exchange", "binance") or "binance",
        decrypt(cfg.encrypted_api_key),
        decrypt(cfg.encrypted_secret_key),
        bool(cfg.is_testnet),
    )


def validate_credentials(exchange: str, api_key: str, secret: str, testnet: bool) -> tuple[bool, str | None]:
    """Testa a credencial com uma chamada autenticada leve. (ok, erro)."""
    try:
        adapter = build_adapter(exchange, api_key, secret, testnet)
        if isinstance(adapter, CoinbaseAdapter):
            adapter.client.fetch_balance()
        else:
            adapter.client.get_account()
        return True, None
    except Exception as e:
        msg = str(e)
        return False, msg[:300]
