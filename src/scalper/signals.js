// True Range médio em % do preço — mede volatilidade da última vela
export function calcATRPct(candles, period = 14) {
  if (candles.length < period + 1) return 0;
  const trs = [];
  for (let i = candles.length - period; i < candles.length; i++) {
    const c = candles[i], prev = candles[i - 1];
    const tr = Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close));
    trs.push(tr);
  }
  const atr = trs.reduce((a, b) => a + b, 0) / trs.length;
  const lastClose = candles[candles.length - 1].close;
  return lastClose ? (atr / lastClose) * 100 : 0;
}

export function calcStandardDeviation(values) {
  const avg = values.reduce((a, b) => a + b, 0) / values.length;
  const squareDiffs = values.map((v) => Math.pow(v - avg, 2));
  const avgSquareDiff = squareDiffs.reduce((a, b) => a + b, 0) / values.length;
  return Math.sqrt(avgSquareDiff);
}

export function calcBB(closes, length = 20, mult = 1.8) {
  if (closes.length < length) return { basis: closes[closes.length-1], upper: closes[closes.length-1], lower: closes[closes.length-1] };
  const slice = closes.slice(closes.length - length);
  const basis = slice.reduce((a, b) => a + b, 0) / length;
  const dev = calcStandardDeviation(slice);
  return { basis, upper: basis + dev * mult, lower: basis - dev * mult };
}

export function turboReversionSignal(candles, opts = {}) {
  const { bbLen = 20, bbMult = 1.8, rsiLen = 14, rsiLimit = 35, volMult = 1.3,
          trendEmaPeriod = 0, trendSlopeBars = 5, trendMaxDownPct = 0,
          minAtrPct = 0 } = opts;
  if (candles.length < Math.max(bbLen, rsiLen, trendEmaPeriod) + 2) return { signal: "flat", reason: "not enough bars" };
  const closes = candles.map((c) => c.close);
  const vols = candles.map((c) => c.vol || c.volume || 0);
  const last = closes[closes.length - 1];
  const lastVol = vols[vols.length - 1];
  const bb = calcBB(closes, bbLen, bbMult);
  const rsi = calcRSI(closes, rsiLen);
  const volSlice = vols.slice(Math.max(0, vols.length - 20));
  const avgVol = (volSlice.reduce((a, b) => a + b, 0) / volSlice.length) || 1;
  const isOversold = last < bb.lower && rsi < rsiLimit;
  const isVolSpike = lastVol > avgVol * volMult;

  let trendOk = true;
  let trendInfo = null;
  if (trendEmaPeriod > 0) {
    const emaNow = calcEMA(closes, trendEmaPeriod);
    const emaPrev = calcEMA(closes.slice(0, closes.length - trendSlopeBars), trendEmaPeriod);
    const slopePct = (emaNow - emaPrev) / emaPrev;
    const slopeOk = slopePct >= -trendMaxDownPct;
    const aboveEma = last >= emaNow;
    trendOk = slopeOk;
    trendInfo = { ema: emaNow.toFixed(4), slopePct: (slopePct*100).toFixed(3)+"%", aboveEma, pass: trendOk };
  }

  // Filtro de volatilidade: ATR mínimo (% do preço) — evita operar em mercado morto
  let atrOk = true;
  let atrInfo = null;
  if (minAtrPct > 0) {
    const atrPct = calcATRPct(candles, 14);
    atrOk = atrPct >= minAtrPct;
    atrInfo = { atrPct: atrPct.toFixed(3), pass: atrOk };
  }

  const conditions = [
    { label: "RSI < " + rsiLimit, value: rsi.toFixed(1), pass: rsi < rsiLimit },
    { label: "Preço < Banda Inf.", value: last.toFixed(4) + " / " + bb.lower.toFixed(4), pass: last < bb.lower },
    { label: "Volume Spike", value: (lastVol/avgVol).toFixed(2) + "x", pass: isVolSpike },
    ...(trendInfo ? [{ label: `Slope EMA${trendEmaPeriod} ≥ -${(trendMaxDownPct*100).toFixed(2)}%`, value: `${trendInfo.aboveEma?'✓':'✗'} ${trendInfo.slopePct}`, pass: trendInfo.pass }] : []),
    ...(atrInfo ? [{ label: `ATR ≥ ${minAtrPct.toFixed(2)}%`, value: atrInfo.atrPct + "%", pass: atrInfo.pass }] : [])
  ];

  if (isOversold && isVolSpike && trendOk && atrOk) return { signal: "buy", reason: "turbo-reversion-bottom", last, lower: bb.lower, rsi, volFactor: (lastVol/avgVol).toFixed(2), conditions };
  if (last > bb.upper) return { signal: "sell", reason: "turbo-reversion-top", last, upper: bb.upper, rsi, conditions };
  const blockedBy = !trendOk ? "downtrend filter" : !atrOk ? "low volatility" : "no turbo setup";
  return { signal: "flat", reason: blockedBy, last, lower: bb.lower, rsi, volFactor: (lastVol/avgVol).toFixed(2), conditions };
}

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

export function calcMACD(closes, fast = 12, slow = 26, signal = 9) {
  if (closes.length < slow + signal) return { macd: 0, signal: 0, hist: 0 };
  const kFast = 2 / (fast + 1);
  const kSlow = 2 / (slow + 1);
  const kSig  = 2 / (signal + 1);
  let curFast = closes[0];
  let curSlow = closes[0];
  const macdLine = [];
  for (let i = 0; i < closes.length; i++) {
    curFast = closes[i] * kFast + curFast * (1 - kFast);
    curSlow = closes[i] * kSlow + curSlow * (1 - kSlow);
    macdLine.push(curFast - curSlow);
  }
  let curSig = macdLine[0];
  for (let i = 0; i < macdLine.length; i++) curSig = macdLine[i] * kSig + curSig * (1 - kSig);
  const lastMacd = macdLine[macdLine.length - 1];
  return { macd: lastMacd, signal: curSig, hist: lastMacd - curSig };
}

export function microScalpSignal(candles, opts = {}) {
  const { emaPeriod = 8, rsiPeriod = 3, minDip = 0.0005, maxRsi = 75, minRsi = 25,
          trendEmaPeriod = 0, trendSlopeBars = 5, trendMaxDownPct = 0,
          minAtrPct = 0 } = opts;
  if (candles.length < Math.max(emaPeriod, rsiPeriod, trendEmaPeriod) + 2) return { signal: "flat", reason: "not enough bars" };
  const closes = candles.map((c) => c.close);
  const last = closes[closes.length - 1];
  const prev = closes[closes.length - 2];
  const ema = calcEMA(closes, emaPeriod);
  const rsi = calcRSI(closes, rsiPeriod);
  const dipPct = (prev - last) / prev;
  const bumpPct = (last - prev) / prev;

  // Filtro macro de tendência (EMA longa)
  let trendOk = true;
  let trendInfo = null;
  if (trendEmaPeriod > 0) {
    const trendEma = calcEMA(closes, trendEmaPeriod);
    const trendEmaPrev = calcEMA(closes.slice(0, closes.length - trendSlopeBars), trendEmaPeriod);
    const slopePct = (trendEma - trendEmaPrev) / trendEmaPrev;
    trendOk = slopePct >= -trendMaxDownPct;
    trendInfo = { trendEma: trendEma.toFixed(4), slopePct: (slopePct*100).toFixed(3)+"%", pass: trendOk };
  }

  // Filtro de volatilidade
  let atrOk = true;
  let atrInfo = null;
  if (minAtrPct > 0) {
    const atrPct = calcATRPct(candles, 14);
    atrOk = atrPct >= minAtrPct;
    atrInfo = { atrPct: atrPct.toFixed(3), pass: atrOk };
  }

  const baseConditions = [
    { label: "Preço > EMA", value: last.toFixed(4) + " > " + ema.toFixed(4), pass: last > ema },
    { label: "Dip >= " + (minDip*100).toFixed(2) + "%", value: (dipPct*100).toFixed(2) + "%", pass: dipPct >= minDip },
    { label: "RSI " + minRsi + "-" + maxRsi, value: rsi.toFixed(1), pass: rsi >= minRsi && rsi <= maxRsi },
    ...(trendInfo ? [{ label: `Slope EMA${trendEmaPeriod} ≥ -${(trendMaxDownPct*100).toFixed(2)}%`, value: trendInfo.slopePct, pass: trendOk }] : []),
    ...(atrInfo ? [{ label: `ATR ≥ ${minAtrPct.toFixed(2)}%`, value: atrInfo.atrPct + "%", pass: atrOk }] : [])
  ];

  if (last > ema && dipPct >= minDip && rsi >= minRsi && rsi <= maxRsi && trendOk && atrOk) {
    return { signal: "buy", reason: "bull-trend micro-dip", last, ema, rsi, dipPct, conditions: baseConditions };
  }
  if (last < ema && bumpPct >= minDip && rsi >= minRsi && rsi <= maxRsi && trendOk && atrOk) {
    return { signal: "sell", reason: "bear-trend micro-bounce", last, ema, rsi, bumpPct, conditions: baseConditions };
  }
  const blockedBy = !trendOk ? "downtrend filter" : !atrOk ? "low volatility" : "no micro setup";
  return { signal: "flat", reason: blockedBy, last, ema, rsi, conditions: baseConditions };
}

export function wv5gSignal(candles, opts = {}) {
  const { rsiLow = 30, rsiHigh = 85, emaFast = 9, emaSlow = 20 } = opts;
  if (candles.length < Math.max(emaSlow, 14) + 2) return { signal: "flat", reason: "not enough bars" };
  const closes = candles.map((c) => c.close);
  const last = closes[closes.length - 1];
  const e9 = calcEMA(closes, emaFast);
  const e20 = calcEMA(closes, emaSlow);
  const rsi14 = calcRSI(closes, 14);
  const macd = calcMACD(closes);
  const c1_bull = last > e9 && e9 > e20;
  const c1_bear = last < e9 && e9 < e20;
  const c2 = rsi14 >= rsiLow && rsi14 <= rsiHigh;
  const c3_bull = macd.hist > 0;
  const c3_bear = macd.hist < 0;
  if (c1_bull && c2 && c3_bull) return { signal: "buy", reason: "wv5g-bull-trend", last, e9, e20, rsi14, macdHist: macd.hist };
  if (c1_bear && c2 && c3_bear) return { signal: "sell", reason: "wv5g-bear-trend", last, e9, e20, rsi14, macdHist: macd.hist };
  const conditions = [
    { label: "Trend (P > E9 > E20)", value: `${last.toFixed(4)} > ${e9.toFixed(4)} > ${e20.toFixed(4)}`, pass: c1_bull },
    { label: "RSI Range ("+rsiLow+"-"+rsiHigh+")", value: rsi14.toFixed(1), pass: c2 },
    { label: "MACD Hist > 0", value: macd.hist.toFixed(6), pass: c3_bull }
  ];
  return { signal: "flat", reason: "no wv5g setup", last, e9, e20, rsi14, macdHist: macd.hist, conditions };
}
