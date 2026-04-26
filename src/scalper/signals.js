export function calcEMA(closes, period) {
  if (!closes.length) return 0;
  const k = 2 / (period + 1);
  let ema = closes[0];
  for (let i = 1; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k);
  return ema;
}

export function calcRSI(closes, period = 3) {
  if (closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  if (losses === 0) return 100;
  if (gains === 0) return 0;
  const rs = gains / losses;
  return 100 - 100 / (1 + rs);
}

export function calcVWAP(candles) {
  let cumTPV = 0, cumVol = 0;
  for (const c of candles) {
    const tp = (c.high + c.low + c.close) / 3;
    cumTPV += tp * c.vol;
    cumVol += c.vol;
  }
  return cumVol === 0 ? candles[candles.length - 1]?.close ?? 0 : cumTPV / cumVol;
}

export function microScalpSignal(candles, opts = {}) {
  const { emaPeriod = 8, rsiPeriod = 3, minDip = 0.0005, maxRsi = 75, minRsi = 25 } = opts;

  if (candles.length < Math.max(emaPeriod, rsiPeriod) + 2) {
    return { signal: "flat", reason: "not enough bars" };
  }

  const closes = candles.map((c) => c.close);
  const last = closes[closes.length - 1];
  const prev = closes[closes.length - 2];
  const ema = calcEMA(closes, emaPeriod);
  const rsi = calcRSI(closes, rsiPeriod);

  const dipPct = (prev - last) / prev;
  const bumpPct = (last - prev) / prev;

  if (last > ema && dipPct >= minDip && rsi >= minRsi && rsi <= maxRsi) {
    return { signal: "buy", reason: "bull-trend micro-dip", last, ema, rsi, dipPct };
  }
  if (last < ema && bumpPct >= minDip && rsi >= minRsi && rsi <= maxRsi) {
    return { signal: "sell", reason: "bear-trend micro-bounce", last, ema, rsi, bumpPct };
  }
  return { signal: "flat", reason: "no micro setup", last, ema, rsi };
}
