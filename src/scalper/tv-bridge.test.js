import { test } from "node:test";
import assert from "node:assert/strict";
import { createTvBridge } from "./tv-bridge.js";

function makeMockDrawer() {
  const calls = [];
  return {
    calls,
    drawShape: async (args) => {
      calls.push({ kind: "draw", args });
      return { entity_id: `id-${calls.length}` };
    },
    removeOne: async ({ entity_id }) => {
      calls.push({ kind: "remove", entity_id });
      return { ok: true };
    },
  };
}

test("drawEntry creates 3 horizontal lines (entry/tp/sl) and 1 label", async () => {
  const drawer = makeMockDrawer();
  const bridge = createTvBridge({ drawer });
  await bridge.drawEntry({ entryPrice: 100, tpPrice: 100.15, slPrice: 99.9, qty: 5, ts: 1700000000000 });
  const drawCalls = drawer.calls.filter((c) => c.kind === "draw");
  assert.equal(drawCalls.length, 4);
  const shapes = drawCalls.map((c) => c.args.shape);
  assert.deepEqual(shapes.sort(), ["horizontal_line", "horizontal_line", "horizontal_line", "text"].sort());
});

test("clearEntry removes all stored shapes", async () => {
  const drawer = makeMockDrawer();
  const bridge = createTvBridge({ drawer });
  await bridge.drawEntry({ entryPrice: 100, tpPrice: 100.15, slPrice: 99.9, qty: 5, ts: 1700000000000 });
  drawer.calls.length = 0;
  await bridge.clearEntry();
  const removeCalls = drawer.calls.filter((c) => c.kind === "remove");
  assert.equal(removeCalls.length, 4);
});

test("clearEntry is no-op when nothing was drawn", async () => {
  const drawer = makeMockDrawer();
  const bridge = createTvBridge({ drawer });
  await bridge.clearEntry();
  assert.equal(drawer.calls.length, 0);
});

test("drawEntry replaces previous drawing (calls clearEntry internally)", async () => {
  const drawer = makeMockDrawer();
  const bridge = createTvBridge({ drawer });
  await bridge.drawEntry({ entryPrice: 100, tpPrice: 100.15, slPrice: 99.9, qty: 5, ts: 1700000000000 });
  drawer.calls.length = 0;
  await bridge.drawEntry({ entryPrice: 101, tpPrice: 101.15, slPrice: 100.9, qty: 5, ts: 1700000005000 });
  assert.equal(drawer.calls.filter((c) => c.kind === "remove").length, 4);
  assert.equal(drawer.calls.filter((c) => c.kind === "draw").length, 4);
});

test("bridge tolerates drawer errors without throwing", async () => {
  const drawer = {
    drawShape: async () => { throw new Error("CDP disconnected"); },
    removeOne: async () => ({ ok: true }),
  };
  const silentLog = { warn: () => {} };
  const bridge = createTvBridge({ drawer, log: silentLog });
  await bridge.drawEntry({ entryPrice: 100, tpPrice: 100.15, slPrice: 99.9, qty: 5, ts: 1700000000000 });
});
