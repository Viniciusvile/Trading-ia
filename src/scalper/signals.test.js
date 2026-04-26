import { test } from "node:test";
import assert from "node:assert/strict";
import { calcEMA, calcRSI, calcVWAP, microScalpSignal } from "./signals.js";

test("calcEMA produces seed-then-smoothed value", () => {
  const ema = calcEMA([10, 11, 12, 13, 14], 3);
  assert.ok(ema > 12 && ema < 14);
});

test("calcRSI returns 100 when only gains", () => {
  assert.equal(calcRSI([1, 2, 3, 4, 5], 3), 100);
});

test("calcVWAP weights by volume", () => {
  const candles = [
    { high: 10, low: 10, close: 10, vol: 1 },
    { high: 20, low: 20, close: 20, vol: 9 },
  ];
  const vwap = calcVWAP(candles);
  assert.ok(vwap > 18 && vwap < 20);
});

test("microScalpSignal emits buy on bullish micro-pullback", () => {
  const closes = [100, 100.5, 101, 101.5, 102, 101.95];
  const candles = closes.map((c) => ({ high: c, low: c, close: c, vol: 1 }));
  const sig = microScalpSignal(candles, { emaPeriod: 3, rsiPeriod: 3, minDip: 0.0001, maxRsi: 90 });
  assert.equal(sig.signal, "buy");
});

test("microScalpSignal returns flat on chop", () => {
  const closes = [100, 100.001, 100, 100.001, 100, 100.001];
  const candles = closes.map((c) => ({ high: c, low: c, close: c, vol: 1 }));
  const sig = microScalpSignal(candles, { emaPeriod: 3, rsiPeriod: 3, minDip: 0.001, maxRsi: 70 });
  assert.equal(sig.signal, "flat");
});
