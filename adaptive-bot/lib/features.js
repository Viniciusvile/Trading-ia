// Snapshot compacto do regime de mercado no momento da entrada.
// Mantido pequeno e legível de propósito: vai serializado no prompt do Gemini.

function ema(values, period) {
  const k = 2 / (period + 1);
  let e = values[0];
  for (let i = 1; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

function rsi(closes, period = 14) {
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gains += d; else losses -= d;
  }
  if (losses === 0) return 100;
  const rs = gains / losses;
  return 100 - 100 / (1 + rs);
}

function atr(candles, period = 14) {
  const trs = [];
  for (let i = candles.length - period; i < candles.length; i++) {
    const c = candles[i], prev = candles[i - 1];
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close)));
  }
  return trs.reduce((a, b) => a + b, 0) / trs.length;
}

/** candles: [{time, open, high, low, close, volume}] em 5m, mais recente por último. */
export function computeFeatures(candles) {
  if (!candles || candles.length < 100) return null;
  const closes = candles.map((c) => c.close);
  const last = candles[candles.length - 1];
  const price = last.close;

  const ema20 = ema(closes.slice(-60), 20);
  const ema50Now = ema(closes.slice(-100), 50);
  const ema50Prev = ema(closes.slice(-110, -10), 50);

  const vols = candles.slice(-50).map((c) => c.volume);
  const avgVol = vols.slice(0, -1).reduce((a, b) => a + b, 0) / (vols.length - 1);

  const last24h = candles.slice(-Math.min(candles.length, 288)); // 288 candles 5m = 24h
  const hi = Math.max(...last24h.map((c) => c.high));
  const lo = Math.min(...last24h.map((c) => c.low));
  const d = new Date(last.time);

  return {
    rsi14: round2(rsi(closes, 14)),
    atr_pct: round4(atr(candles, 14) / price),
    ema20_dist_pct: round4((price - ema20) / ema20),
    ema50_slope_pct: round4((ema50Now - ema50Prev) / ema50Prev),
    vol_ratio: round2(last.volume / (avgVol || 1)),
    range_pct_24h: round4((hi - lo) / lo),
    hour_utc: d.getUTCHours(),
    weekday: d.getUTCDay(),
  };
}

const round2 = (x) => Math.round(x * 100) / 100;
const round4 = (x) => Math.round(x * 10000) / 10000;
