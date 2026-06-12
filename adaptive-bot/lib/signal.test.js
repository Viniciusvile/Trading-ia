import { test } from "node:test";
import assert from "node:assert/strict";
import { createSignalFn } from "./signal.js";
import { DEFAULT_PARAMS } from "./params.js";

// Tendência de alta (+0.3%/candle) com dip de 0.8% no último candle:
// preço continua acima da EMA20 (que fica ~2-3% abaixo numa alta), o dip
// supera min_dip_pct e o RSI fica na faixa — condições do micro-dip real.
function uptrendWithDip(n = 120) {
  const candles = [];
  let price = 100;
  for (let i = 0; i < n - 1; i++) {
    const close = price * 1.003;
    candles.push({ time: 1700000000000 + i * 300000, open: price, high: close + 0.2, low: price - 0.2, close, volume: 1000 });
    price = close;
  }
  const dipClose = price * 0.992; // dip de 0.8%
  candles.push({ time: 1700000000000 + (n - 1) * 300000, open: price, high: price + 0.2, low: dipClose - 0.2, close: dipClose, volume: 3000 });
  return candles;
}

test("micro-dip: dip em tendência de alta gera sinal LONG com stop e tp coerentes", () => {
  const params = { ...DEFAULT_PARAMS, strategy: "micro-dip", min_rsi: 0, max_rsi: 100, min_dip_pct: 0.005, trend_ema_period: 0 };
  const fn = createSignalFn(params);
  const candles = uptrendWithDip();
  const sig = fn(candles);
  assert.ok(sig, "esperava sinal");
  assert.equal(sig.side, "LONG");
  const price = candles[candles.length - 1].close;
  assert.ok(Math.abs(sig.stop - price * (1 - params.sl_pct)) < 1e-9);
  assert.ok(Math.abs(sig.tp - price * (1 + params.tp_pct)) < 1e-9);
});

test("mercado flat sem dip → null", () => {
  const fn = createSignalFn(DEFAULT_PARAMS);
  const flat = Array.from({ length: 120 }, (_, i) => ({
    time: 1700000000000 + i * 300000, open: 100, high: 100.2, low: 99.8, close: 100, volume: 1000,
  }));
  assert.equal(fn(flat), null);
});
