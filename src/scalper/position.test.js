import { test } from "node:test";
import assert from "node:assert/strict";
import { createPosition, evaluateExit, pnlPct } from "./position.js";

test("createPosition computes TP/SL prices", () => {
  const p = createPosition({ side: "buy", entryPrice: 100, qty: 10, tpPct: 0.0015, slPct: 0.001, openedAt: 1000, maxHoldMs: 1_800_000 });
  assert.equal(p.tpPrice, 100.15);
  assert.equal(p.slPrice, 99.9);
  assert.equal(p.maxHoldMs, 1_800_000);
});

test("evaluateExit fires take_profit when price >= tpPrice", () => {
  const p = createPosition({ side: "buy", entryPrice: 100, qty: 1, tpPct: 0.0015, slPct: 0.001, openedAt: 0, maxHoldMs: 1_800_000 });
  assert.equal(evaluateExit(p, { price: 100.16, now: 1000 }).reason, "take_profit");
});

test("evaluateExit fires stop_loss when price <= slPrice", () => {
  const p = createPosition({ side: "buy", entryPrice: 100, qty: 1, tpPct: 0.0015, slPct: 0.001, openedAt: 0, maxHoldMs: 1_800_000 });
  assert.equal(evaluateExit(p, { price: 99.85, now: 1000 }).reason, "stop_loss");
});

test("evaluateExit fires timeout exactly at maxHoldMs (30min)", () => {
  const p = createPosition({ side: "buy", entryPrice: 100, qty: 1, tpPct: 0.0015, slPct: 0.001, openedAt: 0, maxHoldMs: 1_800_000 });
  assert.equal(evaluateExit(p, { price: 100.05, now: 1_800_000 }).reason, "timeout");
});

test("evaluateExit holds inside the 30min window when neither TP nor SL hit", () => {
  const p = createPosition({ side: "buy", entryPrice: 100, qty: 1, tpPct: 0.0015, slPct: 0.001, openedAt: 0, maxHoldMs: 1_800_000 });
  assert.equal(evaluateExit(p, { price: 100.05, now: 1_500_000 }).shouldExit, false);
});

test("pnlPct positive on profitable buy exit", () => {
  const p = createPosition({ side: "buy", entryPrice: 100, qty: 1, tpPct: 0.0015, slPct: 0.001, openedAt: 0, maxHoldMs: 1_800_000 });
  assert.ok(pnlPct(p, 100.15) > 0);
});
