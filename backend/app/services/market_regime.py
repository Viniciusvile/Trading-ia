"""Detector automático de regime de mercado (bull / bear / neutral).

Motivação (auditoria do diário 11-30/jun): TODAS as entradas dos bots eram LONG
enquanto o BTC caía de ~64k para ~58k — 111 longs de 5m e 13 longs de 4H, quase
todos stopados. Nenhum bot olhava o "momento do mercado" antes de comprar.

Este módulo é a fonte ÚNICA de verdade sobre o regime:
  - detect_regime(candles) é PURO (testável): EMA200 como linha divisória
    estrutural + inclinação da EMA50 nas últimas barras como direção.
  - get_regime(client, symbol) busca candles 4H na Binance com cache em memória
    (TTL) — o regime de 4H muda devagar, não precisa recalcular a cada ciclo.
  - entry_allowed(client, symbol, side) é o gate usado pelos runners: combina o
    regime do PRÓPRIO símbolo com o regime macro do BTC (altcoins seguem o BTC).

Regras do gate (long-only spot):
  - LONG bloqueado se o símbolo está em regime bear;
  - LONG bloqueado se o BTC (macro) está em regime bear, mesmo p/ altcoins;
  - SHORT (paper) bloqueado em regime bull — espelho da regra acima.
"""
from __future__ import annotations

import time

REGIME_TF = "4h"          # timeframe estrutural usado para classificar o regime
REGIME_CANDLES = 250      # warmup suficiente p/ EMA200
CACHE_TTL_S = 900         # 15 min: regime de 4H não muda mais rápido que isso
MACRO_SYMBOL = "BTCUSDT"  # referência macro do mercado cripto

# limiar de inclinação da EMA50 (em % por ~10 barras de 4H) p/ considerar direção
SLOPE_THRESHOLD_PCT = 0.10
SLOPE_BARS = 10

_cache: dict[str, tuple[float, dict]] = {}


def _ema_series_last(closes: list[float], period: int) -> float:
    if not closes:
        return 0.0
    k = 2 / (period + 1)
    ema = closes[0]
    for c in closes[1:]:
        ema = c * k + ema * (1 - k)
    return ema


def detect_regime(candles: list[dict]) -> dict:
    """PURA: classifica o regime a partir de candles (4H recomendado).

    Retorna {regime: 'bull'|'bear'|'neutral', close, ema200, ema50, slope_pct}.
      - bull:    preço acima da EMA200 E EMA50 subindo
      - bear:    preço abaixo da EMA200 E EMA50 caindo
      - neutral: qualquer outro caso (transição/lateral)
    """
    closes = [c["close"] for c in candles]
    if len(closes) < 60:
        return {"regime": "neutral", "reason": "not enough bars"}

    close = closes[-1]
    ema200 = _ema_series_last(closes, 200)
    ema50 = _ema_series_last(closes, 50)
    ema50_prev = _ema_series_last(closes[:-SLOPE_BARS], 50)
    slope_pct = ((ema50 - ema50_prev) / ema50_prev * 100) if ema50_prev else 0.0

    above = close > ema200
    rising = slope_pct >= SLOPE_THRESHOLD_PCT
    falling = slope_pct <= -SLOPE_THRESHOLD_PCT

    if above and rising:
        regime = "bull"
    elif (not above) and falling:
        regime = "bear"
    else:
        regime = "neutral"

    return {"regime": regime, "close": close, "ema200": ema200,
            "ema50": ema50, "slope_pct": slope_pct}


def _fetch_regime_candles(client, symbol: str) -> list[dict]:
    raw = client.get_klines(symbol=symbol, interval=REGIME_TF, limit=REGIME_CANDLES)
    return [{"close": float(k[4])} for k in raw]


def get_regime(client, symbol: str) -> dict:
    """Regime do símbolo no 4H, com cache em memória (TTL 15 min)."""
    now = time.time()
    hit = _cache.get(symbol)
    if hit and (now - hit[0]) < CACHE_TTL_S:
        return hit[1]
    try:
        candles = _fetch_regime_candles(client, symbol)
        result = detect_regime(candles)
    except Exception as e:
        # Falha na API não pode travar o ciclo: usa cache velho se houver,
        # senão neutral (o risk_guard segue protegendo por outros caminhos).
        if hit:
            return hit[1]
        return {"regime": "neutral", "reason": f"fetch failed: {e}"}
    _cache[symbol] = (now, result)
    return result


def entry_allowed(client, symbol: str, side: str = "LONG") -> dict:
    """Gate de entrada: combina regime do símbolo + regime macro (BTC).

    Retorna {allowed: bool, reason: str, symbol_regime, macro_regime}.
    """
    sym = get_regime(client, symbol)
    macro = sym if symbol == MACRO_SYMBOL else get_regime(client, MACRO_SYMBOL)

    side = (side or "LONG").upper()
    if side == "LONG":
        if macro["regime"] == "bear":
            return {"allowed": False, "reason": "macro_bear (BTC 4H em baixa)",
                    "symbol_regime": sym["regime"], "macro_regime": macro["regime"]}
        if sym["regime"] == "bear":
            return {"allowed": False, "reason": f"{symbol} em regime bear no 4H",
                    "symbol_regime": sym["regime"], "macro_regime": macro["regime"]}
    else:  # SHORT
        if macro["regime"] == "bull" or sym["regime"] == "bull":
            return {"allowed": False, "reason": "regime bull bloqueia short",
                    "symbol_regime": sym["regime"], "macro_regime": macro["regime"]}

    return {"allowed": True, "reason": f"regime ok ({sym['regime']}/{macro['regime']})",
            "symbol_regime": sym["regime"], "macro_regime": macro["regime"]}
