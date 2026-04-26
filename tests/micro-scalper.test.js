import { test } from "node:test";
import assert from "node:assert/strict";
import { microScalpSignal } from "../src/scalper/signals.js";
import { createPosition, evaluateExit, pnlPct } from "../src/scalper/position.js";
import { createTvBridge } from "../src/scalper/tv-bridge.js";

function makeMockDrawer() {
  const calls = [];
  return {
    calls,
    drawShape: async (args) => { calls.push({ kind: "draw", args }); return { entity_id: `id-${calls.length}` }; },
    removeOne: async ({ entity_id }) => { calls.push({ kind: "remove", entity_id }); return { ok: true }; },
  };
}

test("full cycle: signal -> entry -> TV draw -> TP exit -> TV clear", async () => {
  const closes = [100, 100.5, 101, 101.5, 102, 101.95];
  const candles = closes.map((c) => ({ high: c, low: c, close: c, vol: 1 }));
  const sig = microScalpSignal(candles, { emaPeriod: 3, rsiPeriod: 3, minDip: 0.0001, maxRsi: 99 });
  assert.equal(sig.signal, "buy");

  const pos = createPosition({
    side: "buy", entryPrice: 101.95, qty: 10,
    tpPct: 0.0015, slPct: 0.001, openedAt: 0, maxHoldMs: 1_800_000,
  });

  const drawer = makeMockDrawer();
  const tv = createTvBridge({ drawer });
  await tv.drawEntry({ entryPrice: pos.entryPrice, tpPrice: pos.tpPrice, slPrice: pos.slPrice, qty: pos.qty, ts: 1700000000000 });
  assert.equal(drawer.calls.filter((c) => c.kind === "draw").length, 4);

  const exit = evaluateExit(pos, { price: 102.20, now: 60_000 });
  assert.equal(exit.reason, "take_profit");

  drawer.calls.length = 0;
  await tv.clearEntry();
  assert.equal(drawer.calls.filter((c) => c.kind === "remove").length, 4);

  assert.ok(pnlPct(pos, exit.price) > 0);
});

test("position holds full 30min window then exits via timeout", () => {
  const pos = createPosition({
    side: "buy", entryPrice: 100, qty: 1,
    tpPct: 0.0015, slPct: 0.001, openedAt: 0, maxHoldMs: 1_800_000,
  });
  assert.equal(evaluateExit(pos, { price: 100.05, now: 29 * 60_000 }).shouldExit, false);
  assert.equal(evaluateExit(pos, { price: 100.05, now: 30 * 60_000 }).reason, "timeout");
});
