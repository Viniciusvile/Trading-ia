import * as drawingCore from "../core/drawing.js";

const realDrawer = {
  drawShape: drawingCore.drawShape,
  removeOne: drawingCore.removeOne,
};

export function createTvBridge({ drawer = realDrawer, log = console } = {}) {
  let entityIds = [];

  async function safe(call, label) {
    try {
      return await call();
    } catch (e) {
      log.warn?.(`tv-bridge: ${label} failed: ${e.message}`);
      return null;
    }
  }

  async function clearEntry() {
    if (!entityIds.length) return;
    const ids = entityIds;
    entityIds = [];
    for (const id of ids) {
      await safe(() => drawer.removeOne({ entity_id: id }), `removeOne(${id})`);
    }
  }

  async function drawEntry({ entryPrice, tpPrice, slPrice, qty, ts, label }) {
    await clearEntry();
    const tsSec = Math.floor(ts / 1000);

    const entries = [
      { shape: "horizontal_line", point: { time: tsSec, price: entryPrice }, overrides: { linecolor: "#3b82f6", linewidth: 2 }, text: `ENTRY ${entryPrice}` },
      { shape: "horizontal_line", point: { time: tsSec, price: tpPrice }, overrides: { linecolor: "#10b981", linewidth: 2, linestyle: 2 }, text: `TP ${tpPrice}` },
      { shape: "horizontal_line", point: { time: tsSec, price: slPrice }, overrides: { linecolor: "#ef4444", linewidth: 2, linestyle: 2 }, text: `SL ${slPrice}` },
      { shape: "text", point: { time: tsSec, price: entryPrice }, text: label || `MICRO qty=${qty}` },
    ];

    for (const args of entries) {
      const res = await safe(() => drawer.drawShape(args), `drawShape(${args.shape})`);
      if (res?.entity_id) entityIds.push(res.entity_id);
    }
  }

  return { drawEntry, clearEntry, _entityIds: () => [...entityIds] };
}
