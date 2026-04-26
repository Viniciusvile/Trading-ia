export function createPosition({ side, entryPrice, qty, tpPct, slPct, openedAt, maxHoldMs = 1_800_000 }) {
  const tpPrice = side === "buy" ? entryPrice * (1 + tpPct) : entryPrice * (1 - tpPct);
  const slPrice = side === "buy" ? entryPrice * (1 - slPct) : entryPrice * (1 + slPct);
  return { side, entryPrice, qty, tpPct, slPct, tpPrice, slPrice, openedAt, maxHoldMs };
}

export function evaluateExit(pos, { price, now }) {
  if (pos.side === "buy") {
    if (price >= pos.tpPrice) return { shouldExit: true, reason: "take_profit", price };
    if (price <= pos.slPrice) return { shouldExit: true, reason: "stop_loss", price };
  } else {
    if (price <= pos.tpPrice) return { shouldExit: true, reason: "take_profit", price };
    if (price >= pos.slPrice) return { shouldExit: true, reason: "stop_loss", price };
  }
  if (now - pos.openedAt >= pos.maxHoldMs) {
    return { shouldExit: true, reason: "timeout", price };
  }
  return { shouldExit: false, price };
}

export function pnlPct(pos, exitPrice) {
  return pos.side === "buy"
    ? (exitPrice - pos.entryPrice) / pos.entryPrice
    : (pos.entryPrice - exitPrice) / pos.entryPrice;
}
