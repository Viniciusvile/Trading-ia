import { useState } from "react";

const PALETTE = ["#F7931A", "#627EEA", "#9945FF", "#23B5E8", "#345D9D", "#E84142", "#FF060A", "#2EBD8A"];

function colorFor(symbol: string) {
  const known: Record<string, string> = {
    BTC: "#F7931A", ETH: "#627EEA", SOL: "#9945FF", XRP: "#23B5E8",
    LTC: "#345D9D", AVAX: "#E84142", TRX: "#FF060A",
  };
  const base = symbol.replace(/USDT$/i, "").toUpperCase();
  if (known[base]) return known[base];
  let h = 0;
  for (const c of base) h = (h * 31 + c.charCodeAt(0)) % PALETTE.length;
  return PALETTE[h];
}

export function SymbolIcon({ symbol, size = 28 }: { symbol: string; size?: number }) {
  const base = symbol.replace(/USDT$/i, "").toUpperCase();
  const [hasError, setHasError] = useState(false);
  const [lastSymbol, setLastSymbol] = useState(symbol);

  if (symbol !== lastSymbol) {
    setLastSymbol(symbol);
    setHasError(false);
  }

  if (!hasError) {
    return (
      <img
        src={`https://assets.coincap.io/assets/icons/${base.toLowerCase()}@2x.png`}
        alt={base}
        onError={() => setHasError(true)}
        className="inline-block shrink-0 rounded-full object-cover ring-2 ring-[var(--color-bg)] bg-[var(--color-surface-2)]"
        style={{ width: size, height: size }}
      />
    );
  }

  return (
    <span
      aria-hidden
      className="inline-flex items-center justify-center rounded-full font-bold text-white shrink-0 ring-2 ring-[var(--color-bg)]"
      style={{ width: size, height: size, background: colorFor(symbol), fontSize: size * 0.38 }}
    >
      {base.slice(0, 1)}
    </span>
  );
}
