"""Camada de ordem REAL — port de micro-scalper.js (fmtQty/openLong/closeLong) +
src/exchange/binance.js (placeOCO/cancelOCO/getBalances).

ATENÇÃO: este módulo envia ordens REAIS à Binance. Por padrão opera em TESTNET
(o client vem do binance_config do usuário, que respeita is_testnet). A virada
para mainnet é decisão explícita do usuário (Fase 6).

Funções PURAS (fmt_qty/fmt_quote/auto_precision) são testadas isoladamente —
formatação errada = ordem rejeitada ou tamanho errado, o erro mais comum e caro.
"""
from __future__ import annotations

import math
from binance.client import Client
from binance.exceptions import BinanceAPIException


# ─── Formatação (PURA, testável sem Binance) ───

def fmt_qty(symbol: str, n: float, config: dict | None = None) -> str:
    """Trunca (floor, nunca arredonda pra cima) a quantidade às casas decimais do ativo.

    Default por ativo igual ao legado: BTC=5, ETH=4, SOL=2, outros=0.
    """
    config = config or {}
    decimals = config.get("qty_decimals")
    if decimals is None:
        if symbol.startswith("BTC"):
            decimals = 5
        elif symbol.startswith("ETH"):
            decimals = 4
        elif symbol.startswith("SOL"):
            decimals = 2
        else:
            decimals = 0
    f = 10 ** decimals
    return f"{math.floor(n * f) / f:.{decimals}f}"


def fmt_quote(n: float, config: dict | None = None) -> str:
    config = config or {}
    d = config.get("quote_decimals", 2)
    f = 10 ** d
    return f"{math.floor(n * f) / f:.{d}f}"


def auto_precision(price: float, min_prec: int = 4) -> int:
    """Casas decimais p/ preço de OCO: ao menos 4 dígitos significativos, cap em 8.

    ATENÇÃO: isto é um FALLBACK. O correto é alinhar ao tickSize real do símbolo
    (price_decimals_for_symbol) — para BTC (tickSize 0.01) este heurístico erraria
    dando 4 casas e violaria o PRICE_FILTER da Binance.
    """
    if price <= 0:
        return min_prec
    needed = max(min_prec, math.ceil(-math.log10(price)) + 3)
    return min(needed, 8)


# Cache do tickSize por símbolo (evita chamar exchange_info a cada ordem).
_TICK_DECIMALS_CACHE: dict[str, int] = {}


def price_decimals_for_symbol(client: Client, symbol: str) -> int:
    """Casas decimais válidas p/ PREÇO do símbolo, derivadas do tickSize real (PRICE_FILTER).

    Ex.: BTCUSDT tickSize 0.01 -> 2 casas; XRPUSDT tickSize 0.0001 -> 4. Resolve o
    erro 'Filter failure: PRICE_FILTER' de preços com casas a mais que o tick.
    """
    if symbol in _TICK_DECIMALS_CACHE:
        return _TICK_DECIMALS_CACHE[symbol]
    try:
        info = client.get_symbol_info(symbol)
        tick = None
        for f in (info or {}).get("filters", []):
            if f.get("filterType") == "PRICE_FILTER":
                tick = f.get("tickSize")
                break
        if tick:
            # nº de casas decimais significativas do tickSize ("0.01000000" -> 2)
            t = tick.rstrip("0")
            decimals = len(t.split(".")[1]) if "." in t else 0
            _TICK_DECIMALS_CACHE[symbol] = decimals
            return decimals
    except Exception:
        pass
    return 2  # fallback conservador


# ─── Ordens (tocam a Binance via python-binance) ───

def open_long(client: Client, symbol: str, quote_usdt: float, config: dict | None = None) -> dict:
    """Market BUY por valor em USDT (quoteOrderQty). Retorna {ok, qty, avgPrice, raw}."""
    try:
        res = client.order_market_buy(symbol=symbol, quoteOrderQty=fmt_quote(quote_usdt, config))
    except BinanceAPIException as e:
        return {"ok": False, "error": e.message, "raw": None}
    qty = float(res.get("executedQty", 0) or 0)
    quote_spent = float(res.get("cummulativeQuoteQty", 0) or 0)
    avg_price = (quote_spent / qty) if qty > 0 else 0.0
    return {"ok": qty > 0, "qty": qty, "avgPrice": avg_price, "raw": res}


# Distância máxima entre o gatilho do stop e o preço-limite da venda.
# Auditoria 11-30/jun: o buffer antigo de 1% (stop*0.99) deixava a venda executar
# até 1% ABAIXO do stop em livro raso (saída média 0,56% abaixo do stop no 4H),
# inflando cada perda em ~35%. 0,3% cobre o gap normal sem doar o fill.
STOP_LIMIT_BUFFER_PCT = 0.003


def place_oco_sell(client: Client, symbol: str, quantity: str, tp_price: float,
                   stop_price: float, stop_limit_price: float | None = None,
                   precision: int | None = None) -> dict:
    """OCO de venda: TP (limit) + SL (stop-limit) juntos. Espelha placeOCO do legado.

    Alinha os preços ao tickSize REAL do símbolo (evita 'Filter failure: PRICE_FILTER').
    Sem stop_limit_price explícito, usa stop * (1 - STOP_LIMIT_BUFFER_PCT).
    """
    prec = precision if precision is not None else price_decimals_for_symbol(client, symbol)
    sl_limit = stop_limit_price if stop_limit_price is not None else stop_price * (1 - STOP_LIMIT_BUFFER_PCT)
    # API nova da Binance (above/below): para um OCO de SELL,
    #   above = TP (LIMIT_MAKER, preço acima do mercado)
    #   below = SL (STOP_LOSS_LIMIT: stopPrice dispara, price é o limite de venda)
    try:
        res = client.create_oco_order(
            symbol=symbol,
            side="SELL",
            quantity=quantity,
            aboveType="LIMIT_MAKER",
            abovePrice=f"{tp_price:.{prec}f}",
            belowType="STOP_LOSS_LIMIT",
            belowStopPrice=f"{stop_price:.{prec}f}",
            belowPrice=f"{sl_limit:.{prec}f}",
            belowTimeInForce="GTC",
        )
        return {"ok": True, "orderListId": res.get("orderListId"), "raw": res}
    except BinanceAPIException as e:
        return {"ok": False, "error": e.message, "raw": None}


def cancel_oco(client: Client, symbol: str, order_list_id) -> dict:
    # DELETE /api/v3/orderList (a lib nao expoe cancel_order_list nomeado).
    try:
        res = client.v3_delete_order_list(symbol=symbol, orderListId=int(order_list_id))
        return {"ok": True, "raw": res}
    except BinanceAPIException as e:
        return {"ok": False, "error": e.message}


def get_oco(client: Client, order_list_id) -> dict:
    """Consulta o estado de uma OCO. Retorna {ok, status, filled_price, raw}.

    status do orderList: 'EXECUTING' (ativa) | 'ALL_DONE' (TP ou SL bateu) | 'REJECT'.
    Se ALL_DONE, busca a ordem FILLED para descobrir o preco real de saida.
    """
    if order_list_id is None:
        return {"ok": False, "error": "sem orderListId"}
    try:
        res = client.v3_get_order_list(orderListId=int(order_list_id))
    except BinanceAPIException as e:
        return {"ok": False, "error": e.message}
    status = res.get("listOrderStatus") or res.get("listStatusType")
    filled_price = None
    if status == "ALL_DONE":
        symbol = res.get("symbol")
        for refo in res.get("orders", []):
            try:
                o = client.get_order(symbol=symbol, orderId=refo["orderId"])
            except BinanceAPIException:
                continue
            if o.get("status") == "FILLED":
                eq = float(o.get("executedQty", 0) or 0)
                qq = float(o.get("cummulativeQuoteQty", 0) or 0)
                filled_price = (qq / eq) if eq > 0 else float(o.get("price") or o.get("stopPrice") or 0)
                break
    return {"ok": True, "status": status, "filled_price": filled_price, "raw": res}


def get_free_balance(client: Client, asset: str) -> float:
    account = client.get_account()
    row = next((b for b in account.get("balances", []) if b["asset"] == asset), None)
    return float(row["free"]) if row else 0.0


def close_long(client: Client, symbol: str, qty: float, config: dict | None = None,
               oco_id=None) -> dict:
    """Cancela OCO (se houver), confere saldo livre real e faz market SELL.

    Espelha closeLong do legado: vende o MIN(qty desejada, saldo livre) para não
    falhar por saldo bloqueado/poeira.
    """
    if oco_id:
        cancel_oco(client, symbol, oco_id)  # best-effort; ignora falha

    base_asset = symbol.replace("USDT", "")
    sell_qty = qty
    try:
        free = get_free_balance(client, base_asset)
        if free < qty:
            sell_qty = free
    except BinanceAPIException:
        pass

    final_qty = fmt_qty(symbol, sell_qty, config)
    if float(final_qty) <= 0:
        return {"ok": False, "error": f"Qty arredondada para zero ({symbol})"}

    try:
        res = client.order_market_sell(symbol=symbol, quantity=final_qty)
    except BinanceAPIException as e:
        return {"ok": False, "error": e.message}
    filled = float(res.get("executedQty", 0) or 0)
    filled_quote = float(res.get("cummulativeQuoteQty", 0) or 0)
    exit_price = (filled_quote / filled) if filled > 0 else 0.0
    return {"ok": filled > 0, "qty": filled, "exitPrice": exit_price, "raw": res}
