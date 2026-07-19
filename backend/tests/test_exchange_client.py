"""Testes do adapter multi-exchange (partes puras, sem rede)."""
from app.services.exchange_client import CoinbaseAdapter, BinanceAdapter


def _coinbase_stub() -> CoinbaseAdapter:
    # instancia sem __init__ (não cria cliente ccxt) p/ testar lógica pura
    return CoinbaseAdapter.__new__(CoinbaseAdapter)


def test_coinbase_symbol_mapping():
    ad = _coinbase_stub()
    assert ad._market("BTCUSDT") == "BTC/USDC"
    assert ad._market("ETHUSDT") == "ETH/USDC"
    assert ad._market("XRPUSDT") == "XRP/USDC"
    assert ad._market("SOLUSDC") == "SOL/USDC"


def test_coinbase_capabilities():
    ad = _coinbase_stub()
    assert ad.exchange == "coinbase"
    assert ad.quote_asset == "USDC"
    assert ad.supports_oco is False
    # OCO na Coinbase deve falhar de forma explícita (runners caem no software TP/SL)
    assert ad.place_oco_sell("BTCUSDT", 0.1, 200, 100)["ok"] is False
    # cancel_oco é no-op seguro; get_oco_status nunca reporta ALL_DONE
    assert ad.cancel_oco("BTCUSDT", 123)["ok"] is True
    assert ad.get_oco_status("BTCUSDT", 123)["ok"] is False


def test_binance_capabilities():
    assert BinanceAdapter.exchange == "binance"
    assert BinanceAdapter.quote_asset == "USDT"
    assert BinanceAdapter.supports_oco is True
