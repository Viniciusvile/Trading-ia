"""Testes das funções PURAS de formatação de ordem (port de micro-scalper.js / binance.js).

Formatação de quantidade/preço é a parte mais propensa a erro com dinheiro real
(arredondar errado = ordem rejeitada ou tamanho errado). Testada contra os mesmos
valores do legado.
"""
from app.services.order_real import fmt_qty, fmt_quote, auto_precision


def test_fmt_qty_default_decimals_por_ativo():
    # Sem config: BTC=5, ETH=4, SOL=2, outros=0 (igual ao legado).
    assert fmt_qty("BTCUSDT", 0.123456789, {}) == "0.12345"
    assert fmt_qty("ETHUSDT", 1.23456789, {}) == "1.2345"
    assert fmt_qty("SOLUSDT", 12.3456, {}) == "12.34"
    assert fmt_qty("XRPUSDT", 123.9, {}) == "123"  # default 0 decimais


def test_fmt_qty_respeita_config_qty_decimals():
    assert fmt_qty("XRPUSDT", 123.456, {"qty_decimals": 1}) == "123.4"
    assert fmt_qty("PEPEUSDT", 1000.999, {"qty_decimals": 0}) == "1000"


def test_fmt_qty_trunca_nao_arredonda():
    # Floor, nunca arredonda pra cima (evita vender mais do que tem).
    assert fmt_qty("ETHUSDT", 0.99999, {}) == "0.9999"


def test_fmt_quote_default_2_decimais():
    assert fmt_quote(100.999, {}) == "100.99"
    assert fmt_quote(50.5, {"quote_decimals": 3}) == "50.500"


def test_auto_precision():
    # Ativos caros precisam de menos casas; baratos de mais (4 dígitos significativos).
    assert auto_precision(60000) == 4   # min 4
    assert auto_precision(0.5) >= 4
    assert auto_precision(0.000009) <= 8  # cap em 8
    assert auto_precision(0) == 4         # guarda contra <= 0
