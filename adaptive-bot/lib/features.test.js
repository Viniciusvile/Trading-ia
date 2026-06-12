import { test } from "node:test";
import assert from "node:assert/strict";
import { computeFeatures } from "./features.js";

function trendCandles(n, start = 100, step = 0.5) {
  return Array.from({ length: n }, (_, i) => {
    const c = start + i * step;
    return { time: 1700000000000 + i * 300000, open: c - step, high: c + 1, low: c - 1, close: c, volume: 1000 + i };
  });
}

test("computeFeatures retorna todas as chaves numéricas", () => {
  const f = computeFeatures(trendCandles(120));
  for (const k of ["rsi14", "atr_pct", "ema20_dist_pct", "ema50_slope_pct", "vol_ratio", "range_pct_24h", "hour_utc", "weekday"]) {
    assert.ok(Number.isFinite(f[k]), `${k} deve ser numérico, veio ${f[k]}`);
  }
});

test("tendência de alta → ema50_slope_pct positivo e rsi14 alto", () => {
  const f = computeFeatures(trendCandles(120));
  assert.ok(f.ema50_slope_pct > 0);
  assert.ok(f.rsi14 > 60);
});

test("janela curta demais → null", () => {
  assert.equal(computeFeatures(trendCandles(30)), null);
});
