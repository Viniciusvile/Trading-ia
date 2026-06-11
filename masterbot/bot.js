/**
 * Claude + TradingView MCP — Automated Trading Bot
 *
 * Cloud mode: runs on Railway on a schedule. Pulls candle data direct from
 * Binance (free, no auth), calculates all indicators, runs safety check,
 * executes via BitGet if everything lines up.
 *
 * Local mode: run manually — node bot.js
 * Cloud mode: deploy to Railway, set env vars, Railway triggers on cron schedule
 */

import { config as dotenvConfig } from "dotenv";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";
import nodeFetch from "node-fetch";
import * as db from "./db.js";

// Carrega .env do parent dir (raiz do projeto), independente do cwd.
// O dashboard faz spawn com cwd=masterbot/, mas as credenciais Binance ficam em ../.env.
const __envPath = join(dirname(fileURLToPath(import.meta.url)), "..", ".env");
dotenvConfig({ path: __envPath });

const fetch = (url, opts = {}) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeout || 15000);
  return nodeFetch(url, { ...opts, signal: controller.signal }).finally(() => clearTimeout(timeout));
};

import { validateRules } from "./lib/rules-validator.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ─── Onboarding ───────────────────────────────────────────────────────────────

function checkOnboarding() {
  const required = ["BINANCE_API_KEY", "BINANCE_SECRET_KEY"];
  const missing = required.filter((k) => !process.env[k] && !process.env[k.replace('BINANCE_','BITGET_')]);

  if (missing.length > 0) {
    // Em ambiente cloud (Railway), as credenciais vêm de variáveis de ambiente, não do .env
    if (process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID) {
      console.error(`\n❌ Credenciais ausentes nas variáveis do Railway: ${missing.join(", ")}`);
      console.error("Configure as variáveis no painel Railway → Variables e faça redeploy.\n");
      process.exit(1);
    }
    // Local: tenta criar/abrir .env para o usuário preencher
    if (!existsSync(".env")) {
      writeFileSync(".env", [
        "# Binance credentials",
        "BINANCE_API_KEY=",
        "BINANCE_SECRET_KEY=",
        "",
        "# Trading config",
        "PORTFOLIO_VALUE_USD=1000",
        "MAX_TRADE_SIZE_USD=100",
        "MAX_TRADES_PER_DAY=3",
        "PAPER_TRADING=true",
        "SYMBOL=BTCUSDT",
        "TIMEFRAME=4H",
      ].join("\n") + "\n");
    }
    console.log(`\n⚠️  Credenciais ausentes no .env: ${missing.join(", ")}`);
    console.log("Preencha o arquivo .env e rode novamente: node bot.js\n");
    process.exit(0);
  }

  if (!process.env.DATABASE_URL) {
    console.error('\n❌ DATABASE_URL não definida.');
    console.error('   Adicione DATABASE_URL=postgres://... no arquivo .env ou nas variáveis do Railway.\n');
    process.exit(1);
  }
}

// ─── Config ────────────────────────────────────────────────────────────────

const CONFIG = {
  symbol: process.env.SYMBOL || "BTCUSDT",
  timeframe: process.env.TIMEFRAME || "4H",
  portfolioValue: parseFloat(process.env.PORTFOLIO_VALUE_USD || "1000"),
  maxTradeSizeUSD: parseFloat(process.env.MAX_TRADE_SIZE_USD || "100"),
  maxTradesPerDay: parseInt(process.env.MAX_TRADES_PER_DAY || "3"),
  paperTrading: process.env.PAPER_TRADING !== "false",
  tradeMode: process.env.TRADE_MODE || "spot",
  tradePercent: 0.5, // 50% for small accounts to meet $5 min
  binance: {
    apiKey: (process.env.BINANCE_API_KEY || process.env.BITGET_API_KEY || "").trim(),
    secretKey: (process.env.BINANCE_SECRET_KEY || process.env.BITGET_SECRET_KEY || "").trim(),
    baseUrl: "https://api.binance.com",
  },
};

const RULES_FILE = join(__dirname, "..", "rules.json");

// ─── Position Tracking (delegado ao db.js) ───────────────────────────────────

// loadPositions, savePositions, addPosition → db.loadPositions / db.savePositions / db.addPosition

// ─── Telegram Notifications ─────────────────────────────────────────────────
// Configure TELEGRAM_BOT_TOKEN e TELEGRAM_CHAT_ID no .env.
// Sem token/chat_id, vira no-op silencioso — não quebra o bot.
async function sendWhatsApp(message) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  try {
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: message, disable_web_page_preview: true }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.log(`  ⚠ Telegram falhou: HTTP ${res.status} ${body.slice(0, 200)}`);
    }
  } catch (e) {
    console.log(`  ⚠ Telegram erro: ${e.message}`);
  }
}

// ─── Logging (delegado ao db.js) ────────────────────────────────────────────

// loadLog, saveLog, countTodaysTrades → db.loadRecentLog / db.appendToLog / db.countTodaysTrades

// ─── Market Data (Binance public API — free, no auth) ───────────────────────

export async function fetchCandles(symbol, interval, limit = 100, isFutures = false) {
  // Map our timeframe format to Binance interval format
  const intervalMap = {
    "1m": "1m",
    "3m": "3m",
    "5m": "5m",
    "15m": "15m",
    "30m": "30m",
    "1H": "1h",
    "4H": "4h",
    "1D": "1d",
    "1W": "1w",
  };
  const binanceInterval = intervalMap[interval] || "1m";

  const baseUrl = isFutures ? "https://fapi.binance.com" : "https://api.binance.com";
  const endpoint = isFutures ? "/fapi/v1/klines" : "/api/v3/klines";
  
  const url = `${baseUrl}${endpoint}?symbol=${symbol}&interval=${binanceInterval}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Binance API error: ${res.status}`);
  const data = await res.json();

  return data.map((k) => ({
    time: k[0],
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5]),
  }));
}

// ─── Indicator Calculations ──────────────────────────────────────────────────

function calcEMA(closes, period) {
  const multiplier = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * multiplier + ema * (1 - multiplier);
  }
  return ema;
}

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0,
    losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export function calcATR(candles, period = 14) {
  if (candles.length <= period) return null;
  let sumTR = 0;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const high = candles[i].high;
    const low = candles[i].low;
    const prevClose = candles[i - 1].close;
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    trs.push(tr);
  }
  for(let i=trs.length-period; i<trs.length; i++){
    sumTR += trs[i];
  }
  return sumTR / period;
}


// VWAP — session-based, resets at midnight UTC
function calcVWAP(candles, nowMs = Date.now()) {
  const midnightUTC = new Date(nowMs);
  midnightUTC.setUTCHours(0, 0, 0, 0);
  const sessionCandles = candles.filter((c) => c.time >= midnightUTC.getTime());
  if (sessionCandles.length === 0) return null;
  const cumTPV = sessionCandles.reduce(
    (sum, c) => sum + ((c.high + c.low + c.close) / 3) * c.volume,
    0,
  );
  const cumVol = sessionCandles.reduce((sum, c) => sum + c.volume, 0);
  return cumVol === 0 ? null : cumTPV / cumVol;
}

// ─── Group Plans ─────────────────────────────────────────────────────────────

function getPlanForSymbol(symbol, rules, runMode = 'master') {
  const plans = rules.group_plans || [];

  // Se o usuário fixou um plano ativo (active_plan), respeitamos essa escolha
  // e retornamos APENAS esse plano caso o símbolo esteja contemplado por ele.
  // Isso evita que planos de Futuros vencem por estarem primeiro no array.
  if (rules.active_plan) {
    const fixed = plans.find(p => p.name === rules.active_plan);
    if (fixed && fixed.symbols && fixed.symbols.includes(symbol)) {
      // Em runMode 'master' rejeita planos de Futuros mesmo quando fixados
      if (runMode !== 'futures' && fixed.mode === 'futures') return null;
      if (runMode === 'futures' && fixed.mode !== 'futures') return null;
      return fixed;
    }
    // Se o active_plan não cobre o símbolo, o símbolo é ignorado nesse run
    return null;
  }

  if (runMode === 'futures') {
    return plans.find(p => p.mode === 'futures' && p.symbols.includes(symbol)) || null;
  } else {
    // No modo Master (Spot), busca preferencialmente um plano não-futures.
    // NUNCA cai em plano de Futuros como fallback — isso causaria gravação incorreta.
    return plans.find(p => p.mode !== 'futures' && p.symbols.includes(symbol)) || null;
  }
}

const _missingPlanWarned = new Set();

export function calcPlanStopTP(price, atr, plan, side = 'LONG') {
  const dir = side === 'LONG' ? 1 : -1;
  let stop, tp;

  // Piso mínimo para evitar SL/TP colados ao preço em ativos de micro-preço (BONK, PEPE, etc)
  // ATR do 1h de meme coins pode ser tão pequeno que SL/TP ficam dentro de 1-2 ticks
  const MIN_SL_PCT = 0.005; // mínimo 0.5% de distância para SL
  const MIN_TP_PCT = 0.008; // mínimo 0.8% de distância para TP

  // Formato simplificado novo: sl_atr_mult / tp_atr_mult (números)
  if (plan.sl_atr_mult != null) {
    stop = price - dir * atr * plan.sl_atr_mult;
  } else if (plan.sl?.type === 'pct') {
    stop = price * (1 - dir * plan.sl.value / 100);
  } else if (plan.sl?.multiplier != null) {
    stop = price - dir * atr * plan.sl.multiplier;
  } else {
    stop = price - dir * atr * 1.5; // fallback seguro
  }

  if (plan.tp_atr_mult != null) {
    tp = price + dir * atr * plan.tp_atr_mult;
  } else if (plan.tp?.type === 'trail') {
    tp = price * (1 + dir * 10 / 100);
  } else if (plan.tp?.type === 'pct') {
    tp = price * (1 + dir * plan.tp.value / 100);
  } else if (plan.tp?.multiplier != null) {
    tp = price + dir * atr * plan.tp.multiplier;
  } else {
    tp = price + dir * atr * 2.0; // fallback: RR 2:1 vs SL default
  }

  // Garante distância mínima para LONG (evita rejeição na Binance OCO por preços muito próximos)
  if (side === 'LONG') {
    const minStop = price * (1 - MIN_SL_PCT);
    const minTp   = price * (1 + MIN_TP_PCT);
    if (stop > minStop) {
      console.log(`  ⚠️  [calcPlanStopTP] SL muito próximo (${((price-stop)/price*100).toFixed(3)}% < ${MIN_SL_PCT*100}%) — aplicando piso mínimo`);
      stop = minStop;
    }
    if (tp < minTp) {
      console.log(`  ⚠️  [calcPlanStopTP] TP muito próximo (${((tp-price)/price*100).toFixed(3)}% < ${MIN_TP_PCT*100}%) — aplicando piso mínimo`);
      tp = minTp;
    }
  }

  return { stop, tp };
}

function calcEMAArray(closes, period) {
  if (closes.length < period) return [];
  const mult = 2 / (period + 1);
  const result = new Array(closes.length).fill(null);
  result[period - 1] = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) {
    result[i] = closes[i] * mult + result[i - 1] * (1 - mult);
  }
  return result;
}

function calcMACDHist(closes, fast = 12, slow = 26, signal = 9) {
  if (closes.length < slow + signal) return null;
  const emaFast = calcEMAArray(closes, fast);
  const emaSlow = calcEMAArray(closes, slow);
  const macdLine = [];
  for (let i = slow - 1; i < closes.length; i++) {
    if (emaFast[i] != null && emaSlow[i] != null) macdLine.push(emaFast[i] - emaSlow[i]);
  }
  if (macdLine.length < signal) return null;
  const mult = 2 / (signal + 1);
  let sigLine = macdLine.slice(0, signal).reduce((a, b) => a + b, 0) / signal;
  for (let i = signal; i < macdLine.length; i++) sigLine = macdLine[i] * mult + sigLine * (1 - mult);
  return macdLine[macdLine.length - 1] - sigLine;
}

function calcADX(candles, period = 14) {
  if (candles.length < period * 2) return null;
  const smooth = (arr, p) => {
    let val = arr.slice(0, p).reduce((a, b) => a + b, 0);
    for (let i = p; i < arr.length; i++) val = val - val / p + arr[i];
    return val;
  };
  const plusDM = [], minusDM = [], trs = [];
  for (let i = 1; i < candles.length; i++) {
    const upMove = candles[i].high - candles[i - 1].high;
    const downMove = candles[i - 1].low - candles[i].low;
    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
    const tr = Math.max(candles[i].high - candles[i].low, Math.abs(candles[i].high - candles[i - 1].close), Math.abs(candles[i].low - candles[i - 1].close));
    trs.push(tr);
  }
  const sTR = smooth(trs, period);
  const sPDM = smooth(plusDM, period);
  const sMDM = smooth(minusDM, period);
  if (sTR === 0) return { adx: 0, pdi: 0, mdi: 0 };
  const pdi = 100 * sPDM / sTR;
  const mdi = 100 * sMDM / sTR;
  const dx = pdi + mdi === 0 ? 0 : 100 * Math.abs(pdi - mdi) / (pdi + mdi);
  return { adx: dx, pdi, mdi };
}

// Bollinger Bands — retorna { upper, middle, lower, width, pct_b }
function calcBollingerBands(closes, period = 20, mult = 2.0) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  const sma = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((a, b) => a + Math.pow(b - sma, 2), 0) / period;
  const stdDev = Math.sqrt(variance);
  const upper = sma + mult * stdDev;
  const lower = sma - mult * stdDev;
  const width = (upper - lower) / sma;     // BB Width normalizada
  const price = closes[closes.length - 1];
  const pct_b = stdDev > 0 ? (price - lower) / (upper - lower) : 0.5; // 0=lower,1=upper
  return { upper, middle: sma, lower, width, pct_b, stdDev };
}

// Detecta mercado lateral: BB Width abaixo do percentil histórico
function isRangeMarket(closes, bbPeriod = 20, bbMult = 2.0, widthThreshold = null) {
  const bb = calcBollingerBands(closes, bbPeriod, bbMult);
  if (!bb) return { isRange: false, width: null, adxWeak: false };
  // Calcula histórico de widths para percentil dinâmico
  const widths = [];
  for (let i = bbPeriod; i <= closes.length; i++) {
    const s = closes.slice(i - bbPeriod, i);
    const m = s.reduce((a, b) => a + b, 0) / bbPeriod;
    const sd = Math.sqrt(s.reduce((a, b) => a + Math.pow(b - m, 2), 0) / bbPeriod);
    widths.push(m > 0 ? (2 * 2 * sd) / m : 0);
  }
  const sorted = [...widths].sort((a, b) => a - b);
  const threshold = widthThreshold ?? sorted[Math.floor(sorted.length * 0.35)]; // 35% mais estreito = range
  const isRange = bb.width <= threshold;
  return { isRange, width: bb.width, threshold, bb };
}

function calcSupertrend(candles, period = 7, multiplier = 3.0) {
  if (candles.length < period + 1) return { direction: null };
  const atr = calcATR(candles.slice(-period * 3), period);
  if (!atr) return { direction: null };
  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  const hl2 = (last.high + last.low) / 2;
  const lowerBand = hl2 - multiplier * atr;
  const upperBand = hl2 + multiplier * atr;
  const direction = last.close > lowerBand ? 'up' : 'down';
  return { direction, lowerBand, upperBand };
}

// Choppiness Index — formula: 100 * LOG10( SUM(ATR(1), n) / (MaxHigh(n) - MinLow(n)) ) / LOG10(n)
function calcChoppiness(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const slice = candles.slice(-period);
  const high = Math.max(...slice.map(c => c.high));
  const low = Math.min(...slice.map(c => c.low));
  
  let sumTR = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const c = candles[i];
    const prev = candles[i-1];
    const tr = Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close));
    sumTR += tr;
  }
  
  if (high === low) return 100;
  return 100 * (Math.log10(sumTR / (high - low)) / Math.log10(period));
}

// Stochastic Oscillator — retorna { k, d, prevK, prevD }
function calcStochastic(candles, kPeriod = 14, dPeriod = 3) {
  if (candles.length < kPeriod + dPeriod) return null;
  
  const getK = (subset) => {
    const close = subset[subset.length - 1].close;
    const high = Math.max(...subset.map(c => c.high));
    const low = Math.min(...subset.map(c => c.low));
    return high === low ? 50 : ((close - low) / (high - low)) * 100;
  };

  const ks = [];
  for (let i = candles.length - dPeriod - 1; i < candles.length; i++) {
    ks.push(getK(candles.slice(i - kPeriod + 1, i + 1)));
  }

  const k = ks[ks.length - 1];
  const d = ks.slice(-dPeriod).reduce((a, b) => a + b, 0) / dPeriod;
  const prevK = ks[ks.length - 2];
  const prevD = ks.slice(-dPeriod - 1, -1).reduce((a, b) => a + b, 0) / dPeriod;

  return { k, d, prevK, prevD };
}

export function applyPlanFilters(candles, plan) {
  const extra = [];
  const f = plan.filters || {};
  const closes = candles.map(c => c.close);

  if (f.ema_triple) {
    const e9 = calcEMA(closes, 9), e21 = calcEMA(closes, 21);
    const e55 = calcEMA(closes, 55), e200 = calcEMA(closes, 200);
    const pass = e9 > e21 && e21 > e55 && e55 > e200;
    extra.push({ label: `EMA9>EMA21>EMA55>EMA200 (tendência tripla)`, pass, required: 'crescente', actual: pass ? 'ok' : 'falhou' });
  }
  if (f.adx_min != null || f.di_direction) {
    const di = calcADX(candles, 14);
    if (f.adx_min != null) {
      extra.push({ label: `ADX ≥ ${f.adx_min} (tendência forte)`, pass: di != null && di.adx >= f.adx_min, required: `≥ ${f.adx_min}`, actual: di != null ? di.adx.toFixed(1) : '—' });
    }
    if (f.di_direction) {
      extra.push({ label: `DI+ > DI- (direção comprada)`, pass: di != null && di.pdi > di.mdi, required: 'DI+>DI-', actual: di != null ? `${di.pdi.toFixed(1)}/${di.mdi.toFixed(1)}` : '—' });
    }
  }
  if (f.rsi_min != null || f.rsi_max != null) {
    const rsi = calcRSI(closes, 14);
    const min = f.rsi_min ?? 0, max = f.rsi_max ?? 100;
    extra.push({ label: `RSI ${min}–${max} (zona válida)`, pass: rsi != null && rsi >= min && rsi <= max, required: `${min}–${max}`, actual: rsi != null ? rsi.toFixed(1) : '—' });
  }
  if (f.volume_mult != null) {
    const vols = candles.map(c => c.volume);
    const avgVol = vols.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;
    const curVol = vols[vols.length - 1];
    extra.push({ label: `Volume ≥ ${f.volume_mult}× média`, pass: avgVol > 0 && curVol >= avgVol * f.volume_mult, required: `≥ ${(avgVol * f.volume_mult).toFixed(0)}`, actual: curVol.toFixed(0) });
  }
  if (f.volume_max_mult != null) {
    const vols = candles.map(c => c.volume);
    const avgVol = vols.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;
    const curVol = vols[vols.length - 1];
    extra.push({ label: `Volume ≤ ${f.volume_max_mult}× média (sem breakout)`, pass: avgVol > 0 && curVol <= avgVol * f.volume_max_mult, required: `≤ ${(avgVol * f.volume_max_mult).toFixed(0)}`, actual: curVol.toFixed(0) });
  }
  if (f.choppiness_min != null) {
    const chop = calcChoppiness(candles, 14);
    extra.push({ label: `Choppiness ≥ ${f.choppiness_min} (mercado lateral)`, pass: chop != null && chop >= f.choppiness_min, required: `≥ ${f.choppiness_min}`, actual: chop != null ? chop.toFixed(1) : '—' });
  }
  if (f.macd_positive) {
    const hist = calcMACDHist(closes);
    extra.push({ label: `MACD histogram > 0 (momentum positivo)`, pass: hist != null && hist > 0, required: '> 0', actual: hist != null ? hist.toFixed(6) : '—' });
  }
  if (f.macd_growing) {
    const hist = calcMACDHist(closes);
    const histPrev = calcMACDHist(closes.slice(0, -1));
    const growing = hist != null && histPrev != null && hist > histPrev;
    extra.push({ label: 'MACD histogram crescente (momentum acelerando)', pass: growing, required: 'crescente', actual: hist != null ? `${histPrev?.toFixed(5)} → ${hist.toFixed(5)}` : '—' });
  }
  if (f.supertrend_period != null) {
    const st = calcSupertrend(candles, f.supertrend_period, f.supertrend_mult || 3.0);
    extra.push({ label: `Supertrend(${f.supertrend_period}) bullish`, pass: st.direction === 'up', required: 'bullish', actual: st.direction || '—' });
  }

  // ── Filtros de mercado lateral (Range) ──────────────────────────────────────
  // bb_range: true → exige BB Width abaixo do percentil 35% (mercado comprimido)
  if (f.bb_range) {
    const { isRange, width, threshold } = isRangeMarket(closes, f.bb_period || 20, f.bb_mult || 2.0);
    extra.push({
      label: `BB Width em range (< ${threshold != null ? threshold.toFixed(4) : '—'})`,
      pass: isRange,
      required: `< ${threshold != null ? threshold.toFixed(4) : '—'}`,
      actual: width != null ? width.toFixed(4) : '—',
    });
  }
  // adx_max: ADX abaixo de um máximo (confirma ausência de tendência forte)
  if (f.adx_max != null) {
    const di = calcADX(candles, 14);
    extra.push({
      label: `ADX ≤ ${f.adx_max} (sem tendência forte)`,
      pass: di != null && di.adx <= f.adx_max,
      required: `≤ ${f.adx_max}`,
      actual: di != null ? di.adx.toFixed(1) : '—',
    });
  }
  // bb_pct_b_min / bb_pct_b_max: posição do preço dentro das bandas (0=lower, 1=upper)
  if (f.bb_pct_b_min != null || f.bb_pct_b_max != null) {
    const bb = calcBollingerBands(closes, f.bb_period || 20, f.bb_mult || 2.0);
    const min = f.bb_pct_b_min ?? 0, max = f.bb_pct_b_max ?? 1;
    extra.push({
      label: `%B ${min.toFixed(2)}–${max.toFixed(2)} (posição nas bandas)`,
      pass: bb != null && bb.pct_b >= min && bb.pct_b <= max,
      required: `${min.toFixed(2)}–${max.toFixed(2)}`,
      actual: bb != null ? bb.pct_b.toFixed(3) : '—',
    });
  }
  // rsi_range_mid: RSI próximo de 50 (sem momentum direcional forte)
  if (f.rsi_range_mid) {
    const rsi = calcRSI(closes, 14);
    const lo = f.rsi_range_lo ?? 40, hi = f.rsi_range_hi ?? 60;
    extra.push({
      label: `RSI ${lo}–${hi} (neutro/range)`,
      pass: rsi != null && rsi >= lo && rsi <= hi,
      required: `${lo}–${hi}`,
      actual: rsi != null ? rsi.toFixed(1) : '—',
    });
  }

  return extra;
}

// ─── Safety Check ───────────────────────────────────────────────────────────

function runSafetyCheck(price, ema8, vwap, rsi3, rules) {
  const results = [];

  const check = (label, required, actual, pass) => {
    results.push({ label, required, actual, pass });
    const icon = pass ? "✅" : "🚫";
    console.log(`  ${icon} ${label}`);
  };

  console.log("\n── Safety Check (Agressivo) ─────────────────────────────\n");

  // Removido o filtro de bias global para permitir trades rápidos em qualquer timeframe
  const isLong = rsi3 < 30;
  const isShort = rsi3 > 70;

  if (isLong) {
    check("RSI(3) em zona de compra (< 30)", "< 30", rsi3.toFixed(2), rsi3 < 30);
    check("Preço acima do VWAP", `> ${vwap.toFixed(2)}`, price.toFixed(2), price > vwap);
    const atr = calcATR(candles, 14);
    const stopPrice = atr ? price - atr * 1.5 : price * 0.985;
    return { results, allPass: results.every(r => r.pass), side: 'LONG', stopPrice };
  } else if (isShort) {
    check("RSI(3) em zona de venda (> 70)", "> 70", rsi3.toFixed(2), rsi3 > 70);
    check("Preço abaixo do VWAP", `< ${vwap.toFixed(2)}`, price.toFixed(2), price < vwap);
    const atr = calcATR(candles, 14);
    const stopPrice = atr ? price + atr * 1.5 : price * 1.015;
    return { results, allPass: results.every(r => r.pass), side: 'SHORT', stopPrice };
  }

  return { results, allPass: false, side: null, stopPrice: null };
}

export function runSafetyCheckWarrior(candles, nowMs = candles[candles.length - 1].time) {
  const price = candles[candles.length - 1].close;
  const closes = candles.map(c => c.close);
  const ema9 = calcEMA(closes, 9);
  const ema20 = calcEMA(closes, 20);
  const vwap = calcVWAP(candles, nowMs);
  const rsi14 = calcRSI(closes, 14);

  const results = [];
  
  results.push({
    label: 'Preço acima do VWAP',
    pass: vwap ? price > vwap : false,
    required: vwap ? vwap.toFixed(2) : 0,
    actual: price.toFixed(2),
  });
  
  results.push({
    label: 'EMA(9) > EMA(20)',
    pass: (ema9 && ema20) ? ema9 > ema20 : false,
    required: ema20 ? ema20.toFixed(2) : 0,
    actual: ema9 ? ema9.toFixed(2) : 0,
  });
  
  results.push({
    label: 'RSI > 45 (Momentum)',
    pass: rsi14 ? (rsi14 >= 45) : false,
    required: '> 45',
    actual: rsi14 ? rsi14.toFixed(1) : 0,
  });
  
  const allPass = results.every(r => r.pass);
  const atr = calcATR(candles, 14);
  const stopPrice = atr ? price - atr * 1.5 : price * 0.985;
  const side = allPass ? 'LONG' : null;
  return { results, allPass, side, stopPrice, indicators: { ema9, ema20, vwap, rsi14 } };
}

// Safety check para mercado lateral: preço tocando banda inferior das BB com RSI em zona neutra-baixa
export function runSafetyCheckRange(candles, nowMs = candles[candles.length - 1].time) {
  const price  = candles[candles.length - 1].close;
  const closes = candles.map(c => c.close);
  const bb     = calcBollingerBands(closes, 20, 2.0);
  const rsi14  = calcRSI(closes, 14);
  const vwap   = calcVWAP(candles, nowMs);
  const atr    = calcATR(candles, 14);

  const results = [];

  results.push({
    label: 'Preço próximo da banda inferior (BB %B ≤ 0.35)',
    pass: bb != null && bb.pct_b <= 0.35,
    required: '≤ 0.35',
    actual: bb != null ? bb.pct_b.toFixed(3) : '—',
  });
  results.push({
    label: 'RSI(14) zona neutra-baixa (38–58)',
    pass: rsi14 != null && rsi14 >= 38 && rsi14 <= 58,
    required: '38–58',
    actual: rsi14 != null ? rsi14.toFixed(1) : '—',
  });
  results.push({
    label: 'Preço acima da banda inferior (suporte BB)',
    pass: bb != null && price >= bb.lower,
    required: bb != null ? `≥ ${bb.lower.toFixed(4)}` : '—',
    actual: price.toFixed(4),
  });

  const allPass  = results.every(r => r.pass);
  const stopPrice = atr ? price - atr * 1.2 : price * 0.988;
  const side      = allPass ? 'LONG' : null;
  return { results, allPass, side, stopPrice, indicators: { bb, rsi14, vwap } };
}

// Alpha_RangeMaster v2 — Mean Reversion com zonas de suporte/resistência e osciladores
export function runSafetyCheckRangeV2(candles, planFilters = {}) {
  const last = candles[candles.length - 1];
  const price = last.close;
  const closes = candles.map(c => c.close);
  const atr = calcATR(candles, 14);
  const rsi = calcRSI(closes, 14);
  const stoch = calcStochastic(candles, 14, 3);
  
  const srBars = planFilters.sr_bars || 24;
  const srAtrMult = planFilters.sr_atr_mult || 1.5;
  const srWindow = candles.slice(-srBars);
  const resistance = Math.max(...srWindow.map(c => c.high));
  const support = Math.min(...srWindow.map(c => c.low));
  
  const results = [];
  let side = null;
  let stopPrice = null;
  let takeProfitPrice = null;

  // Filtros de Gatilho (RSI e Estocástico)
  const isRsiLong = rsi != null && rsi < (planFilters.rsi_long_max || 42);
  const isRsiShort = rsi != null && rsi > (planFilters.rsi_short_min || 58);
  const isStochLong = stoch != null && stoch.k < (planFilters.stoch_k_long_max || 30) && stoch.k > stoch.d && stoch.prevK <= stoch.prevD;
  const isStochShort = stoch != null && stoch.k > (planFilters.stoch_k_short_min || 70) && stoch.k < stoch.d && stoch.prevK >= stoch.prevD;

  // Proximidade das bordas (Zona de Entrada)
  const entryAtrBuffer = atr * srAtrMult;
  const inLongZone = price <= support + entryAtrBuffer;
  const inShortZone = price >= resistance - entryAtrBuffer;

  if (inLongZone && isRsiLong && isStochLong) {
    side = 'LONG';
    stopPrice = support - (atr * 0.3);
    takeProfitPrice = resistance - (atr * 0.3);
  } else if (inShortZone && isRsiShort && isStochShort) {
    side = 'SHORT';
    stopPrice = resistance + (atr * 0.3);
    takeProfitPrice = support + (atr * 0.3);
  }

  results.push({
    label: `RSI(14) ${side === 'LONG' ? 'comprado' : side === 'SHORT' ? 'vendido' : 'em zona'}`,
    pass: (side === 'LONG' && isRsiLong) || (side === 'SHORT' && isRsiShort) || (side === null && (isRsiLong || isRsiShort)),
    required: side === 'SHORT' ? `> ${planFilters.rsi_short_min || 58}` : `< ${planFilters.rsi_long_max || 42}`,
    actual: rsi != null ? rsi.toFixed(1) : '—'
  });

  results.push({
    label: `Stoch %K/${side === 'LONG' ? 'Up' : side === 'SHORT' ? 'Down' : 'Cross'}`,
    pass: (side === 'LONG' && isStochLong) || (side === 'SHORT' && isStochShort) || (side === null && (isStochLong || isStochShort)),
    required: side === 'SHORT' ? 'K > 70 & cross down' : 'K < 30 & cross up',
    actual: stoch != null ? `${stoch.k.toFixed(1)}/${stoch.d.toFixed(1)}` : '—'
  });

  results.push({
    label: `Preço na zona de ${side === 'LONG' ? 'Suporte' : 'Resistência'}`,
    pass: (side === 'LONG' && inLongZone) || (side === 'SHORT' && inShortZone) || (side === null && (inLongZone || inShortZone)),
    required: side === 'SHORT' ? `≥ ${ (resistance - entryAtrBuffer).toFixed(2) }` : `≤ ${ (support + entryAtrBuffer).toFixed(2) }`,
    actual: price.toFixed(2)
  });

  // Validação de Risco/Retorno
  if (side && stopPrice && takeProfitPrice) {
    const risk = Math.abs(price - stopPrice);
    const reward = Math.abs(takeProfitPrice - price);
    const rr = risk > 0 ? reward / risk : 0;
    const minRR = planFilters.min_rr || 1.5;
    const rrPass = rr >= minRR;
    results.push({
      label: `Risco:Retorno ≥ ${minRR}`,
      pass: rrPass,
      required: `≥ ${minRR}`,
      actual: rr.toFixed(2)
    });
    if (!rrPass) side = null; // Rejeita entrada se R:R for baixo
  }

  return { results, allPass: results.every(r => r.pass) && !!side, side, stopPrice, takeProfitPrice, indicators: { rsi, stoch, support, resistance } };
}

// ─── Trade Limits ────────────────────────────────────────────────────────────

function checkTradeLimits(log) {
  const todayCount = countTodaysTrades(log);

  console.log("\n── Trade Limits ─────────────────────────────────────────\n");

  if (todayCount >= CONFIG.maxTradesPerDay) {
    console.log(
      `🚫 Max trades per day reached: ${todayCount}/${CONFIG.maxTradesPerDay}`,
    );
    return false;
  }

  console.log(
    `✅ Trades today: ${todayCount}/${CONFIG.maxTradesPerDay} — within limit`,
  );

  const tradeSize = Math.min(
    CONFIG.portfolioValue * CONFIG.tradePercent,
    CONFIG.maxTradeSizeUSD,
  );

  if (tradeSize < 5) {
    console.log(
      `🚫 Trade size $${tradeSize.toFixed(2)} is below Binance minimum ($5.00).`,
    );
    return false;
  }

  console.log(
    `✅ Trade size: $${tradeSize.toFixed(2)} — within max $${CONFIG.maxTradeSizeUSD}`,
  );

  return true;
}

async function getAvailableUSDT(isFutures = false) {
  try {
    const baseUrl = isFutures ? "https://fapi.binance.com" : "https://api.binance.com";
    const endpoint = isFutures ? "/fapi/v2/account" : "/api/v3/account";
    
    const timeRes = await fetch(`${baseUrl}${isFutures ? '/fapi/v1/time' : '/api/v3/time'}`);
    const timestamp = (await timeRes.json()).serverTime;
    const queryString = `timestamp=${timestamp}`;
    const signature = crypto.createHmac("sha256", CONFIG.binance.secretKey).update(queryString).digest("hex");
    
    const res = await fetch(`${baseUrl}${endpoint}?${queryString}&signature=${signature}`, {
      headers: { "X-MBX-APIKEY": CONFIG.binance.apiKey }
    });
    const data = await res.json();
    
    if (data.code && data.code < 0) throw new Error(`[${data.code}] ${data.msg}`);
    
    if (isFutures) {
      // No futuros (V2), o saldo está em assets
      const usdt = data.assets?.find(a => a.asset === "USDT");
      return usdt ? parseFloat(usdt.availableBalance) : 0;
    } else {
      const usdt = data.balances?.find(b => b.asset === "USDT");
      return usdt ? parseFloat(usdt.free) : 0;
    }
  } catch (e) {
    console.log(`⚠ Não foi possível verificar saldo (${isFutures ? 'FUTUROS' : 'SPOT'}): ${e.message}`);
    return null; // null = inconclusivo, não bloqueia
  }
}

async function checkBinancePermissions() {
  console.log("\n── Binance API Diagnostic ───────────────────────────────");
  try {
    // 1. Check SPOT
    const tsS = (await (await fetch("https://api.binance.com/api/v3/time")).json()).serverTime;
    const qsS = `timestamp=${tsS}`;
    const sigS = crypto.createHmac("sha256", CONFIG.binance.secretKey).update(qsS).digest("hex");
    const resS = await fetch(`https://api.binance.com/api/v3/account?${qsS}&signature=${sigS}`, {
      headers: { "X-MBX-APIKEY": CONFIG.binance.apiKey }
    });
    const dataS = await resS.json();
    
    if (dataS.canTrade) console.log("✅ SPOT Trading: ATIVADO");
    else console.log("❌ SPOT Trading: DESATIVADO");

    // 2. Check FUTURES
    const tsF = (await (await fetch("https://fapi.binance.com/fapi/v1/time")).json()).serverTime;
    const qsF = `timestamp=${tsF}`;
    const sigF = crypto.createHmac("sha256", CONFIG.binance.secretKey).update(qsF).digest("hex");
    const resF = await fetch(`https://fapi.binance.com/fapi/v2/account?${qsF}&signature=${sigF}`, {
      headers: { "X-MBX-APIKEY": CONFIG.binance.apiKey }
    });
    const dataF = await resF.json();
    
    if (dataF.canTrade) console.log("✅ FUTURES Trading: ATIVADO");
    else console.log("❌ FUTURES Trading: DESATIVADO (Habilite 'Futures' na sua API Key)");
  } catch (e) {
    console.log("❌ Erro no diagnóstico Binance:", e.message);
  }
}

// ─── Binance Execution ────────────────────────────────────────────────────────

function signBinance(queryString) {
  return crypto
    .createHmac("sha256", CONFIG.binance.secretKey)
    .update(queryString)
    .digest("hex");
}

async function placeBinanceOrder(symbol, side, sizeUSD, price) {
  // Fail-Safe Barrier: impede terminantemente que ativos ou chamadas com contexto de Futuros abram ordens na carteira Spot
  try {
    const rulesJson = JSON.parse(readFileSync(RULES_FILE, 'utf8'));
    const isOnlyFutures = (rulesJson.group_plans || []).some(p => p.mode === 'futures' && p.symbols?.includes(symbol));
    if (process.env.FORCE_MODE === 'futures' || (isOnlyFutures && !rulesJson.group_plans.some(p => p.mode !== 'futures' && p.symbols?.includes(symbol)))) {
      console.error(`🚨 [FAIL-SAFE DE ROTEAMENTO CRÍTICO] Bloqueada tentativa de enviar ordem do par ${symbol} (Futuros) para o endpoint Spot Trading.`);
      throw new Error(`[FAIL-SAFE DE ROTEAMENTO] Ativo ${symbol} é estritamente do ambiente de Futuros e não pode consumir saldo da carteira Spot.`);
    }
  } catch(err) { if(err.message.includes('FAIL-SAFE')) throw err; }

  const MAX_ATTEMPTS = 3;
  const RETRY_DELAYS = [2000, 4000]; // ms entre tentativas
  let lastError;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    // Timestamp fresco a cada tentativa — evita -1021 (recvWindow) nas retentativas
    let timestamp = Date.now();
    try {
      const timeRes = await fetch("https://api.binance.com/api/v3/time");
      timestamp = (await timeRes.json()).serverTime;
    } catch (_) {
      timestamp = Date.now() - 100000;
    }

    const queryString = `symbol=${symbol}&side=${side.toUpperCase()}&type=MARKET&quoteOrderQty=${sizeUSD.toFixed(2)}&recvWindow=10000&timestamp=${timestamp}`;
    const signature = crypto.createHmac("sha256", CONFIG.binance.secretKey).update(queryString).digest("hex");
    const url = `${CONFIG.binance.baseUrl}/api/v3/order?${queryString}&signature=${signature}`;

    let data;
    try {
      const res = await fetch(url, { method: "POST", headers: { "X-MBX-APIKEY": CONFIG.binance.apiKey } });
      data = await res.json();
    } catch (netErr) {
      lastError = netErr;
      if (attempt < MAX_ATTEMPTS) {
        console.log(`  ⚠ [${symbol}] Tentativa ${attempt}/${MAX_ATTEMPTS} falhou (rede): ${netErr.message.slice(0, 80)} — retry em ${RETRY_DELAYS[attempt-1]/1000}s`);
        await sleep(RETRY_DELAYS[attempt - 1]);
        continue;
      }
      throw netErr;
    }

    if (data.code && data.code < 0) {
      lastError = new Error(`Binance order failed: [${data.code}] ${data.msg}`);
      // -2015 = API key/IP/permissions (transitório), -1021 = timestamp fora da janela (transitório)
      const isTransient = data.code === -2015 || data.code === -1021;
      if (isTransient && attempt < MAX_ATTEMPTS) {
        console.log(`  ⚠ [${symbol}] Tentativa ${attempt}/${MAX_ATTEMPTS} — [${data.code}] ${data.msg} — retry em ${RETRY_DELAYS[attempt-1]/1000}s`);
        await sleep(RETRY_DELAYS[attempt - 1]);
        continue;
      }
      throw lastError;
    }

    if (attempt > 1) console.log(`  ✅ [${symbol}] Ordem executada na tentativa ${attempt}/${MAX_ATTEMPTS}`);
    return { orderId: String(data.orderId), executedQty: data.executedQty, status: data.status };
  }
  throw lastError;
}

// ─── Binance Futures Execution ───────────────────────────────────────────────

async function setFuturesLeverage(symbol, leverage) {
  const timestamp = Date.now();
  const queryString = `symbol=${symbol}&leverage=${leverage}&timestamp=${timestamp}`;
  const signature = crypto.createHmac("sha256", CONFIG.binance.secretKey).update(queryString).digest("hex");
  const url = `https://fapi.binance.com/fapi/v1/leverage?${queryString}&signature=${signature}`;
  try {
    const res = await fetch(url, { method: "POST", headers: { "X-MBX-APIKEY": CONFIG.binance.apiKey } });
    const data = await res.json();
    if (data.code && data.code < 0) console.log(`  ⚠ [${symbol}] Falha ao ajustar alavancagem: ${data.msg}`);
    else console.log(`  ⚙️ [${symbol}] Alavancagem ajustada para ${leverage}x`);
  } catch (e) {
    console.log(`  ⚠ [${symbol}] Erro ao ajustar alavancagem: ${e.message}`);
  }
}

async function placeBinanceFuturesOrder(symbol, side, sizeUSD, leverage, price) {
  try {
    // Pre-Trade Balance Check: garante que temos margem suficiente antes de enviar a ordem
    const availUSDT = await getAvailableUSDT(true);
    if (availUSDT !== null) {
      // Deixamos uma margem de segurança de 2% para variações de preço a mercado e taxas
      const requiredMargin = sizeUSD * 1.02;
      if (availUSDT < requiredMargin) {
        console.log(`  🚫 [Margin Check] Saldo insuficiente no Futuros para a margem exigida de ~$${requiredMargin.toFixed(2)} (Disponível: $${availUSDT.toFixed(2)} USDT)`);
        throw new Error(`[-2010] Saldo insuficiente de margem para o trade (Disponível: $${availUSDT.toFixed(2)} USDT)`);
      }
    }

    await setFuturesLeverage(symbol, leverage);
    
    // No futuros, precisamos da quantidade no ativo base (ex: 0.001 BTC)
    // Cálculo: (USD * leverage) / preço_atual
    const rawQty = (sizeUSD * leverage) / price;
    const qty = await roundQty(symbol, rawQty, true); // true = isFutures

    const timestamp = Date.now();
    const queryString = `symbol=${symbol}&side=${side.toUpperCase()}&type=MARKET&quantity=${qty}&recvWindow=10000&timestamp=${timestamp}`;
    const signature = crypto.createHmac("sha256", CONFIG.binance.secretKey).update(queryString).digest("hex");
    const url = `https://fapi.binance.com/fapi/v1/order?${queryString}&signature=${signature}`;

    console.log(`  🚀 [${symbol}] Enviando ordem de Futuros: ${side} ${qty} @ market (Aprox. $${price})`);
    const res = await fetch(url, { method: "POST", headers: { "X-MBX-APIKEY": CONFIG.binance.apiKey } });
    const data = await res.json();
    
    if (data.code && data.code < 0) {
      console.error(`  ❌ [${symbol}] Erro na ordem de Futuros: [${data.code}] ${data.msg}`);
      throw new Error(`Futures order failed: [${data.code}] ${data.msg}`);
    }
    
    console.log(`  ✅ [${symbol}] Ordem de Futuros EXECUTADA: #${data.orderId}`);
    return { orderId: String(data.orderId), executedQty: data.executedQty, avgPrice: data.avgPrice };
  } catch (e) {
    console.error(`  ❌ [${symbol}] Falha crítica em placeBinanceFuturesOrder: ${e.message}`);
    throw e;
  }
}

async function placeFuturesStopOrders(symbol, side, quantity, stopPrice, tpPrice) {
  const closeSide = side === 'LONG' ? 'SELL' : 'BUY';
  const delays = [1000, 3000, 6000]; // Retentativas para dar tempo de a posição assentar no motor da Binance

  let slSuccess = false;
  let tpSuccess = false;

  for (let attempt = 0; attempt < delays.length; attempt++) {
    await sleep(delays[attempt]);
    const timestamp = Date.now();
    const slpRounded = await roundPrice(symbol, stopPrice, true);
    const tppRounded = await roundPrice(symbol, tpPrice, true);
    const qtyRounded = quantity ? await roundQty(symbol, Math.abs(quantity), true) : 0;

    // 1. Tenta Stop Loss (Usando STOP com workingType=MARK_PRICE e timeInForce=GTC)
    if (!slSuccess) {
      const slPriceLimit = side === 'LONG' 
        ? await roundPrice(symbol, parseFloat(slpRounded) * 0.998, true)
        : await roundPrice(symbol, parseFloat(slpRounded) * 1.002, true);

      let slQuery = `symbol=${symbol}&side=${closeSide}&type=STOP&stopPrice=${slpRounded}&price=${slPriceLimit}&quantity=${qtyRounded}&timeInForce=GTC&reduceOnly=true&workingType=MARK_PRICE&recvWindow=10000&timestamp=${timestamp}`;
      let slSig = crypto.createHmac("sha256", CONFIG.binance.secretKey).update(slQuery).digest("hex");
      try {
        let res = await fetch(`https://fapi.binance.com/fapi/v1/order?${slQuery}&signature=${slSig}`, {
          method: "POST", headers: { "X-MBX-APIKEY": CONFIG.binance.apiKey }
        });
        let data = await res.json();
        if (data.code && data.code < 0) {
          console.log(`  ⚠ [${symbol}] SL Futures (STOP) falhou: [${data.code}] ${data.msg}`);
        } else {
          console.log(`  ✅ [${symbol}] SL Futures (Stop-Limit) ativado @ Stop: $${slpRounded} | MarkPrice Trigger`);
          slSuccess = true;
        }
      } catch(e) { console.log(`  ⚠ [${symbol}] Erro de rede no SL Futures: ${e.message}`); }
    }

    // 2. Tenta Take Profit (Usando LIMIT padrão - Sem reduceOnly para evitar erro -2022)
    if (!tpSuccess) {
      let tpQuery = `symbol=${symbol}&side=${closeSide}&type=LIMIT&price=${tppRounded}&quantity=${qtyRounded}&timeInForce=GTC&recvWindow=10000&timestamp=${timestamp}`;
      let tpSig = crypto.createHmac("sha256", CONFIG.binance.secretKey).update(tpQuery).digest("hex");
      try {
        let res = await fetch(`https://fapi.binance.com/fapi/v1/order?${tpQuery}&signature=${tpSig}`, {
          method: "POST", headers: { "X-MBX-APIKEY": CONFIG.binance.apiKey }
        });
        let data = await res.json();
        if (data.code && data.code < 0) {
          console.log(`  ⚠ [${symbol}] TP Futures (LIMIT) falhou: [${data.code}] ${data.msg}`);
        } else {
          console.log(`  ✅ [${symbol}] TP Futures (Limit Order) ativado @ $${tppRounded}`);
          tpSuccess = true;
        }
      } catch(e) { console.log(`  ⚠ [${symbol}] Erro de rede no TP Futures: ${e.message}`); }
    }

    if (slSuccess && tpSuccess) break;
  }

  if (!slSuccess || !tpSuccess) {
    console.error(`  ❌ [${symbol}] Falha final ao atrelar SL/TP de Futuros na exchange após ${delays.length} tentativas.`);
  } else {
    console.log(`  🛡️ [${symbol}] Proteção total de Futuros (SL + TP) consolidada na exchange com sucesso.`);
  }
}

let _symbolPrecisionCache = {};

async function getPrecision(symbol, isFutures = false) {
  const cacheKey = `${symbol}_${isFutures}`;
  if (_symbolPrecisionCache[cacheKey]) return _symbolPrecisionCache[cacheKey];
  
  // Fallback garantido e curado por contrato para impedir rejeições de precisão caso a API falhe
  const fallbacksFutures = {
    BTCUSDT: { price: 1, qty: 3 },
    ETHUSDT: { price: 2, qty: 2 },
    SOLUSDT: { price: 3, qty: 0 },
    XRPUSDT: { price: 4, qty: 0 },
    ADAUSDT: { price: 4, qty: 0 },
    AVAXUSDT: { price: 3, qty: 0 },
    LINKUSDT: { price: 3, qty: 2 },
    DOGEUSDT: { price: 5, qty: 0 },
    BNBUSDT: { price: 2, qty: 2 },
    LTCUSDT: { price: 2, qty: 3 }
  };
  const fb = isFutures ? (fallbacksFutures[symbol] || { price: 4, qty: 0 }) : { price: 4, qty: 4 };

  try {
    const baseUrl = isFutures ? 'https://fapi.binance.com' : 'https://api.binance.com';
    const endpoint = isFutures ? '/fapi/v1/exchangeInfo' : '/api/v3/exchangeInfo';
    const res = await fetch(`${baseUrl}${endpoint}?symbol=${symbol}`);
    const data = await res.json();
    const info = (data.symbols || []).find(s => s.symbol === symbol);
    if (!info) {
      _symbolPrecisionCache[cacheKey] = fb;
      return fb;
    }
    const pf = info.filters.find(f => f.filterType === 'PRICE_FILTER');
    const lf = info.filters.find(f => f.filterType === 'LOT_SIZE');
    
    const countDecimalsStr = (s) => {
      if (!s) return null;
      const str = s.toString().trim().replace(/0+$/, '');
      if (str.endsWith('.')) return 0;
      if (str.includes('e-')) return parseInt(str.split('e-')[1]);
      if (str.includes('.')) return str.split('.')[1].length;
      return 0;
    };

    const pPrice = pf ? countDecimalsStr(pf.tickSize) : null;
    const pQty = lf ? countDecimalsStr(lf.stepSize) : null;
    
    _symbolPrecisionCache[cacheKey] = {
      price: pPrice !== null ? pPrice : fb.price,
      qty: pQty !== null ? pQty : fb.qty
    };
    return _symbolPrecisionCache[cacheKey];
  } catch (e) {
    _symbolPrecisionCache[cacheKey] = fb;
    return fb;
  }
}

async function roundPrice(symbol, price, isFutures = false) {
  const p = await getPrecision(symbol, isFutures);
  return price.toFixed(p.price);
}

async function roundQty(symbol, qty, isFutures = false) {
  const p = await getPrecision(symbol, isFutures);
  let rounded = parseFloat(qty.toFixed(p.qty));
  // Prevenção de LOT_SIZE zero no fapi: garante no mínimo 1 stepSize se o arredondamento zerar
  if (rounded <= 0) {
    rounded = p.qty === 0 ? 1 : parseFloat((1 / Math.pow(10, p.qty)).toFixed(p.qty));
  }
  return rounded.toFixed(p.qty);
}

// ─── OCO Order (Take Profit + Stop Loss via Binance) ─────────────────────────

async function placeOCOOrder(symbol, quantity, takeProfitPrice, stopPrice) {
  let timestamp = Date.now();
  try {
    const timeRes = await fetch("https://api.binance.com/api/v3/time");
    const timeData = await timeRes.json();
    timestamp = timeData.serverTime;
  } catch (e) {
    timestamp = Date.now() - 100000;
  }

  // Cancela ordens abertas antes para liberar saldo (evita erro de insufficient balance)
  try {
    const cancelRes = await fetch(`https://api.binance.com/api/v3/openOrders?symbol=${symbol}&timestamp=${timestamp}&signature=${crypto.createHmac('sha256', process.env.BINANCE_SECRET_KEY || '').update(`symbol=${symbol}&timestamp=${timestamp}`).digest('hex')}`, {
      method: 'DELETE',
      headers: { 'X-MBX-APIKEY': process.env.BINANCE_API_KEY || '' }
    });
    const cancelData = await cancelRes.json();
    if (Array.isArray(cancelData) && cancelData.length > 0) {
      console.log(`  🧹 [${symbol}] ${cancelData.length} ordens antigas canceladas para liberar saldo.`);
    }
  } catch (e) {
    // Silencioso se não houver ordens
  }

  // Busca preço atual para evitar erro de "Relationship of prices"
  let currentPrice = 0;
  try {
    const tickerRes = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`);
    const tickerData = await tickerRes.json();
    currentPrice = parseFloat(tickerData.price);
  } catch (e) {
    console.log(`⚠️  [${symbol}] Falha ao buscar preço atual para OCO, usando preço de entrada.`);
  }

  let tpPrice = await roundPrice(symbol, takeProfitPrice);
  let spPrice = await roundPrice(symbol, stopPrice);

  // Validação de segurança para SELL OCO (fechar compra):
  // Para meme coins (BONK, PEPE) com preços de micro-valor, garantimos distância mínima
  if (currentPrice > 0) {
    // 1. Take Profit deve ser no mínimo 0.15% ACIMA do preço atual
    const minTpDistance = currentPrice * 1.0015;
    if (tpPrice <= minTpDistance) {
      console.log(`  ⚠️  [OCO] TP $${tpPrice} muito próximo do preço $${currentPrice} — ajustando para +0.15%`);
      tpPrice = await roundPrice(symbol, minTpDistance);
    }
    // 2. Stop Price deve ser no mínimo 0.1% ABAIXO do preço atual
    const maxSpDistance = currentPrice * 0.999;
    if (spPrice >= maxSpDistance) {
      console.log(`  ⚠️  [OCO] SL $${spPrice} muito próximo do preço $${currentPrice} — ajustando para -0.1%`);
      spPrice = await roundPrice(symbol, maxSpDistance);
    }
  }

  // stopLimitPrice levemente abaixo do stop para garantir execução
  const slpPrice = await roundPrice(symbol, spPrice * 0.997);
  const qtyRounded = await roundQty(symbol, parseFloat(quantity));

  const queryString = [
    `symbol=${symbol}`,
    `side=SELL`,
    `quantity=${qtyRounded}`,
    `price=${tpPrice}`,
    `stopPrice=${spPrice}`,
    `stopLimitPrice=${slpPrice}`,
    `stopLimitTimeInForce=GTC`,
    `recvWindow=10000`,
    `timestamp=${timestamp}`,
  ].join('&');

  const signature = crypto.createHmac("sha256", CONFIG.binance.secretKey).update(queryString).digest("hex");
  const url = `${CONFIG.binance.baseUrl}/api/v3/order/oco?${queryString}&signature=${signature}`;

  const res = await fetch(url, { method: "POST", headers: { "X-MBX-APIKEY": CONFIG.binance.apiKey } });
  const data = await res.json();
  if (data.code && data.code < 0) throw new Error(`OCO failed: [${data.code}] ${data.msg}`);
  return { orderListId: data.orderListId, orders: data.orders };
}

async function checkOCOStatus(symbol, orderListId) {
  let timestamp = Date.now();
  try {
    const timeRes = await fetch("https://api.binance.com/api/v3/time");
    timestamp = (await timeRes.json()).serverTime;
  } catch(e) {}

  const queryString = `orderListId=${orderListId}&recvWindow=10000&timestamp=${timestamp}`;
  const signature = crypto.createHmac("sha256", CONFIG.binance.secretKey).update(queryString).digest("hex");
  const res = await fetch(`${CONFIG.binance.baseUrl}/api/v3/orderList?${queryString}&signature=${signature}`, {
    headers: { "X-MBX-APIKEY": CONFIG.binance.apiKey }
  });
  const data = await res.json();
  if (data.code && data.code < 0) throw new Error(`OCO status failed: [${data.code}] ${data.msg}`);

  // listOrderStatus: "EXECUTING" | "ALL_DONE" | "REJECT"
  // listStatusType:  "EXEC_STARTED" | "ALL_DONE"
  const filled = data.listOrderStatus === "ALL_DONE";
  let filledOrder = filled && (data.orderReports || [])?.find(o => o.status === "FILLED");

  // Se o report veio vazio no GET, precisamos buscar os detalhes das ordens individuais
  if (filled && !filledOrder && data.orders) {
    for (const ord of data.orders) {
      try {
        const oTs = Date.now();
        const oQs = `symbol=${symbol}&orderId=${ord.orderId}&timestamp=${oTs}&recvWindow=10000`;
        const oSig = crypto.createHmac("sha256", CONFIG.binance.secretKey).update(oQs).digest("hex");
        const oRes = await fetch(`${CONFIG.binance.baseUrl}/api/v3/order?${oQs}&signature=${oSig}`, {
          headers: { "X-MBX-APIKEY": CONFIG.binance.apiKey }
        });
        const oData = await oRes.json();
        if (oData.status === "FILLED") {
          filledOrder = oData;
          break;
        }
      } catch (e) {}
    }
  }

  return { filled, listOrderStatus: data.listOrderStatus, orders: data.orders, filledOrder };
}

// ─── Sell Order ──────────────────────────────────────────────────────────────

// Posições gravam mode: 'spot' | 'futures' na abertura (ver registro da posição)
function isFuturesPosition(pos) {
  return pos?.mode === 'futures';
}

async function closePositionMarket(pos) {
  const symbol = pos.symbol;
  const isFut = isFuturesPosition(pos);
  const side = pos.side === 'LONG' ? 'SELL' : 'BUY'; // Lado contrário para fechar
  const timestamp = Date.now();
  const qty = await roundQty(symbol, Math.abs(pos.quantity), isFut);

  console.log(`  🚨 [${symbol}] Executando FECHAMENTO DE MERCADO (${isFut ? 'FUTUROS' : 'SPOT'}) | Side: ${side} | Qty: ${qty}`);

  if (isFut) {
    // FECHAMENTO FUTUROS
    const queryString = `symbol=${symbol}&side=${side}&type=MARKET&quantity=${qty}&reduceOnly=true&recvWindow=10000&timestamp=${timestamp}`;
    const signature = crypto.createHmac("sha256", CONFIG.binance.secretKey).update(queryString).digest("hex");
    const url = `https://fapi.binance.com/fapi/v1/order?${queryString}&signature=${signature}`;
    const res = await fetch(url, { method: "POST", headers: { "X-MBX-APIKEY": CONFIG.binance.apiKey } });
    const data = await res.json();
    if (data.code && data.code < 0) throw new Error(`Futures Market Close failed: [${data.code}] ${data.msg}`);
    return { orderId: String(data.orderId) };
  } else {
    // FECHAMENTO SPOT
    const queryString = `symbol=${symbol}&side=${side}&type=MARKET&quantity=${qty}&recvWindow=10000&timestamp=${timestamp}`;
    const signature = crypto.createHmac("sha256", CONFIG.binance.secretKey).update(queryString).digest("hex");
    const url = `https://api.binance.com/api/v3/order?${queryString}&signature=${signature}`;
    const res = await fetch(url, { method: "POST", headers: { "X-MBX-APIKEY": CONFIG.binance.apiKey } });
    const data = await res.json();
    if (data.code && data.code < 0) throw new Error(`Spot Market Close failed: [${data.code}] ${data.msg}`);
    return { orderId: String(data.orderId) };
  }
}

async function placeBinanceSellOrder(symbol, quantity) {
  // Mantido por retrocompatibilidade, mas closePositionMarket é preferível
  return closePositionMarket({ symbol, quantity, side: 'LONG' });
}

// ─── Position Monitor ─────────────────────────────────────────────────────────

async function monitorPositions() {
  const positions = await db.loadPositions();
  const open = positions.filter(p => p.status === "open");
  if (open.length === 0) return;

  console.log(`\n── Monitor de Posições ──────────────────────────────────`);
  console.log(`  ${open.length} posição(ões) aberta(s)`);

  for (const pos of open) {
    try {
      // ── Sincronização Ativa de Posições de Futuros via exchange ──
      const isPosFutures = pos.plan?.includes('Futures') || pos.plan === 'Alpha_Futures_Trend';
      if (isPosFutures && !CONFIG.paperTrading) {
        try {
          const timestamp = Date.now();
          const qs = `symbol=${pos.symbol}&timestamp=${timestamp}`;
          const sig = crypto.createHmac("sha256", CONFIG.binance.secretKey).update(qs).digest("hex");
          const res = await fetch(`https://fapi.binance.com/fapi/v2/positionRisk?${qs}&signature=${sig}`, {
            headers: { "X-MBX-APIKEY": CONFIG.binance.apiKey }
          });
          const riskData = await res.json();
          if (Array.isArray(riskData) && riskData.length > 0) {
            const currentRisk = riskData.find(r => r.symbol === pos.symbol);
            const amt = parseFloat(currentRisk?.positionAmt || 0);
            if (amt === 0) {
              console.log(`  🔄 [${pos.symbol}] Posição de Futuros encerrada na exchange. Atualizando sistema...`);
              pos.status = "closed";
              pos.closedAt = new Date().toISOString();
              pos.exitReason = "Fechado na Exchange (TP / SL / Manual)";
              pos.exitPrice = pos.takeProfitPrice || pos.entryPrice;
              pos.pnl = 0;
              await db.savePosition(pos);
              continue;
            } else {
              console.log(`  📈 [${pos.symbol}] Futuros ativo na exchange: ${amt} contratos abertos.`);
              // Sincronização e Auditoria de Ordens SL/TP para Futuros: garante que não fique "-- / --" na exchange
              if (pos.stopPrice && pos.takeProfitPrice) {
                try {
                  const oTs = Date.now();
                  const oQs = `symbol=${pos.symbol}&timestamp=${oTs}`;
                  const oSig = crypto.createHmac("sha256", CONFIG.binance.secretKey).update(oQs).digest("hex");
                  const oRes = await fetch(`https://fapi.binance.com/fapi/v1/openOrders?${oQs}&signature=${oSig}`, {
                    headers: { "X-MBX-APIKEY": CONFIG.binance.apiKey }
                  });
                  const openOrders = await oRes.json();
                  if (Array.isArray(openOrders)) {
                    const hasStop = openOrders.some(o => o.type.includes("STOP"));
                    const hasTP = openOrders.some(o => o.type.includes("TAKE_PROFIT"));
                    if (!hasStop || !hasTP) {
                      console.log(`  ⚠️ [${pos.symbol}] Repondo ordens SL/TP ausentes no Futuros para a posição ativa #${pos.id}...`);
                      const sideForOrder = amt > 0 ? "LONG" : "SHORT";
                      await placeFuturesStopOrders(pos.symbol, sideForOrder, Math.abs(amt), pos.stopPrice, pos.takeProfitPrice);
                    }
                  }
                } catch(ordAudErr) {
                  console.log(`  ⚠ Erro na auditoria de ordens abertas para ${pos.symbol}: ${ordAudErr.message}`);
                }
              }
              continue;
            }
          }
        } catch(riskErr) {
          console.log(`  ⚠ Erro ao checar positionRisk para ${pos.symbol}: ${riskErr.message}`);
        }
        continue; // Garante que a posição de futuros nunca sofra interferência das rotinas Spot abaixo
      }

      // ── Sincronização Spot: detecta posição encerrada fora do bot ──
      // Se o saldo do ativo na exchange não cobre a posição registrada, ela foi
      // fechada externamente (OCO executada, venda manual etc.) — marca como
      // encerrada em vez de tentar vender para sempre (posição fantasma).
      if (!CONFIG.paperTrading) {
        try {
          const baseAsset = pos.symbol.replace(/USDT$/, '');
          const sQs = `timestamp=${Date.now()}`;
          const sSig = crypto.createHmac("sha256", CONFIG.binance.secretKey).update(sQs).digest("hex");
          const accRes = await fetch(`https://api.binance.com/api/v3/account?${sQs}&signature=${sSig}`, {
            headers: { "X-MBX-APIKEY": CONFIG.binance.apiKey }
          });
          const acc = await accRes.json();
          if (Array.isArray(acc.balances)) {
            const bal = acc.balances.find(b => b.asset === baseAsset);
            const held = bal ? parseFloat(bal.free) + parseFloat(bal.locked) : 0;
            if (held < pos.quantity * 0.9) {
              console.log(`  🔄 [${pos.symbol}] Saldo na exchange (${held}) não cobre a posição (${pos.quantity}). Fechada externamente — sincronizando registro.`);
              pos.status = "closed";
              pos.closedAt = new Date().toISOString();
              pos.exitReason = "Fechada na exchange (saldo inexistente) — registro sincronizado";
              pos.exitPrice = pos.entryPrice;
              pos.pnl = 0;
              await db.savePosition(pos);
              continue;
            }
          }
        } catch (syncErr) {
          console.log(`  ⚠ [${pos.symbol}] Sync de saldo spot falhou: ${syncErr.message}`);
        }
      }

      // ── Auditoria OCO Spot: repõe TP/SL na exchange se a posição estiver sem OCO ──
      // O stop precisa viver na Binance: o watchdog local roda só a cada ciclo e
      // morre junto com o servidor. (placeOCOOrder cancela ordens presas antes.)
      if (!CONFIG.paperTrading && !pos.ocoOrderListId && !pos.ocoManual &&
          pos.side === 'LONG' && pos.stopPrice && pos.takeProfitPrice) {
        try {
          const ocoQty = await roundQty(pos.symbol, pos.quantity, false);
          console.log(`  🛠️ [${pos.symbol}] Posição sem OCO na exchange — repondo TP/SL (qty=${ocoQty})...`);
          const ocoResult = await placeOCOOrder(pos.symbol, ocoQty, pos.takeProfitPrice, pos.stopPrice);
          pos.ocoOrderListId = ocoResult.orderListId;
          pos.ocoPlaced = true;
          await db.savePosition(pos);
          console.log(`  ✅ [${pos.symbol}] OCO reposta: lista ${pos.ocoOrderListId}`);
        } catch (ocoFixErr) {
          console.log(`  ⚠ [${pos.symbol}] Falha ao repor OCO: ${ocoFixErr.message}`);
        }
      }

      // ── Posição com OCO ativa: verifica status na Binance ──
      if (pos.ocoPlaced && !CONFIG.paperTrading && !pos.ocoManual && pos.ocoOrderListId) {
        try {
          const ocoStatus = await checkOCOStatus(pos.symbol, pos.ocoOrderListId);
          if (ocoStatus.filled) {
            // Usa os dados da ordem preenchida (TP ou SL) para precisão no PnL
            let price = 0;
            if (ocoStatus.filledOrder) {
              const execQty = parseFloat(ocoStatus.filledOrder.executedQty || 0);
              const quoteQty = parseFloat(ocoStatus.filledOrder.cummulativeQuoteQty || 0);
              price = execQty > 0 ? quoteQty / execQty : parseFloat(ocoStatus.filledOrder.price || ocoStatus.filledOrder.stopPrice);
            } else {
              // Fallback para preço atual se por algum motivo não pegou os detalhes
              const candles = await fetchCandles(pos.symbol, pos.timeframe, 5);
              price = candles[candles.length - 1].close;
            }

            const isTP = price >= (pos.takeProfitPrice || price) * 0.999;
            const exitReason = isTP ? `TAKE PROFIT via OCO @ $${price.toFixed(8)}` : `STOP LOSS via OCO @ $${price.toFixed(8)}`;
            const pnl = parseFloat(((price - pos.entryPrice) * pos.quantity).toFixed(8));
            const pnlPct = (((price - pos.entryPrice) / pos.entryPrice) * 100).toFixed(2);
            const usdBrl = 5.7;
            const pnlBrl = (pnl * usdBrl).toFixed(2);
            const resultado = pnl >= 0 ? '✅ LUCRO' : '❌ PREJUÍZO';
            const duracao = pos.openedAt ? Math.round((Date.now() - new Date(pos.openedAt).getTime()) / 60000) : '?';
            
            Object.assign(pos, { status: "closed", closedAt: new Date().toISOString(), exitPrice: price, exitReason, pnl });
            console.log(`✅ [${pos.symbol}] OCO EXECUTADA: ${exitReason} | PnL: $${pnl}`);
            sendWhatsApp(`${resultado} — ${pos.symbol} (${pos.timeframe})\n\n📋 Resumo do Trade\n` +
              `Plano: ${pos.plan || 'Auto'}\n` +
              `Entrada: $${pos.entryPrice}\n` +
              `Saída:   $${price.toFixed(6)}\n` +
              `Motivo:  ${isTP ? 'Take Profit ✅' : 'Stop Loss 🛑'}\n\n` +
              `💰 PnL: $${pnl > 0 ? '+' : ''}${pnl} USD\n` +
              `💵 Em BRL: R$ ${pnl >= 0 ? '+' : ''}${pnlBrl}\n` +
              `📊 Variação: ${pnlPct > 0 ? '+' : ''}${pnlPct}%\n` +
              `⏱ Duração: ${duracao} minutos`);
          } else {
            const candles = await fetchCandles(pos.symbol, pos.timeframe, 5);
            const price = candles[candles.length - 1].close;
            const pnlUnrealized = ((price - pos.entryPrice) * pos.quantity).toFixed(8);
            const pct = (((price - pos.entryPrice) / pos.entryPrice) * 100).toFixed(2);
            console.log(`  🔗 [${pos.symbol}] OCO aguardando (listId: ${pos.ocoOrderListId}) | Preço: $${price} | PnL: $${pnlUnrealized} (${pct}%)`);
          }
        } catch (ocoErr) {
          console.log(`  ⚠ [${pos.symbol}] OCO check falhou: ${ocoErr.message} — verificando manualmente`);
          // Cai no monitoramento manual abaixo se o check falhar
          pos.ocoPlaced = false;
        }
        continue;
      }

      // ── OCO manual (colocado pelo usuário na Binance): monitora e ativa Watchdog se necessário ──
      if (pos.ocoManual && pos.ocoPlaced && !CONFIG.paperTrading && !pos.slManagedLocally) {
        const candles = await fetchCandles(pos.symbol, pos.timeframe, 5);
        const price = candles[candles.length - 1].close;
        const pnlUnrealized = ((price - pos.entryPrice) * pos.quantity).toFixed(8);
        const pct = (((price - pos.entryPrice) / pos.entryPrice) * 100).toFixed(2);
        console.log(`  🔗 [${pos.symbol}] OCO manual ativa | Preço: $${price} | PnL: $${pnlUnrealized} (${pct}%) | Stop: $${pos.stopPrice} | TP: $${pos.takeProfitPrice}`);
        continue;
      }

      // ── MONITORAMENTO LOCAL / WATCHDOG (Para contornar erro -4120 ou Paper Trading) ──
      const candles = await fetchCandles(pos.symbol, pos.timeframe, 100);
      const price = candles[candles.length - 1].close;
      
      // Breakeven logic para Alpha_RangeMaster v2: quando atinge 50% do alvo, move SL para BE + ATR*0.1
      if (pos.plan === 'Alpha_RangeMaster' && pos.status === 'open' && !pos.breakevenTriggered) {
        const tpDist = Math.abs(pos.takeProfitPrice - pos.entryPrice);
        const currentDist = Math.abs(price - pos.entryPrice);
        const isProfitable = (pos.side === 'SHORT') ? (price < pos.entryPrice) : (price > pos.entryPrice);
        
        if (isProfitable && currentDist >= tpDist * 0.5) {
          const atrValue = calcATR(candles, 14);
          const buffer = (atrValue || 0) * 0.1;
          const newSL = pos.side === 'SHORT' ? pos.entryPrice - buffer : pos.entryPrice + buffer;
          
          pos.stopPrice = newSL;
          pos.breakevenTriggered = true;
          console.log(`  🛡️ [${pos.symbol}] Breakeven v2 disparado (50% TP atingido). Novo SL: $${newSL.toFixed(8)}`);
          
          // Nota: Para ordens OCO em Live Spot, a atualização exigiria cancelar e repor a OCO.
          // Por ora, o Watchdog local assumirá o controle do novo SL se a OCO original for ignorada.
        }
      }

      let exitReason = null;
      if (pos.side === 'SHORT') {
        if (price >= pos.stopPrice) exitReason = `WATCHDOG: STOP LOSS (SHORT) @ $${price} (limite: $${pos.stopPrice})`;
        else if (price <= pos.takeProfitPrice) exitReason = `WATCHDOG: TAKE PROFIT (SHORT) @ $${price} (alvo: $${pos.takeProfitPrice})`;
      } else {
        if (price <= pos.stopPrice) exitReason = `WATCHDOG: STOP LOSS (LONG) @ $${price} (limite: $${pos.stopPrice})`;
        else if (price >= pos.takeProfitPrice) exitReason = `WATCHDOG: TAKE PROFIT (LONG) @ $${price} (alvo: $${pos.takeProfitPrice})`;
      }

      // Filtro extra: se a OCO estiver na exchange e for TP, ela fecha sozinha. 
      // Mas se slManagedLocally estiver ativo, nós forçamos a saída aqui se bater no SL.
      if (exitReason && pos.slManagedLocally && exitReason.includes('TAKE PROFIT')) {
        // Deixa a ordem LIMIT da Binance cuidar do TP para evitar duplicidade
        exitReason = null; 
      }

      if (exitReason) {
        console.log(`\n🔔 [${pos.symbol}] Saída: ${exitReason}`);
        if (!CONFIG.paperTrading) {
          try {
            const sellOrder = await closePositionMarket(pos);
            const pnl = ((price - pos.entryPrice) * pos.quantity).toFixed(4);
            const pnlPct = (((price - pos.entryPrice) / pos.entryPrice) * 100).toFixed(2);
            const usdBrl = 5.7;
            const pnlBrl = (parseFloat(pnl) * usdBrl).toFixed(2);
            const resultado = parseFloat(pnl) >= 0 ? '✅ LUCRO' : '❌ PREJUÍZO';
            const duracao = pos.openedAt ? Math.round((Date.now() - new Date(pos.openedAt).getTime()) / 60000) : '?';
            Object.assign(pos, { status: "closed", closedAt: new Date().toISOString(), exitPrice: price, exitReason, exitOrderId: sellOrder.orderId, pnl: parseFloat(pnl) });
            console.log(`✅ [${pos.symbol}] VENDIDO @ $${price} | PnL: $${pnl}`);
            sendWhatsApp(`${resultado} — ${pos.symbol} (${pos.timeframe})\n\n📋 Resumo do Trade\n` +
              `Plano: ${pos.plan || 'Auto'}\n` +
              `Entrada: $${pos.entryPrice}\n` +
              `Saída:   $${price}\n` +
              `Motivo:  ${exitReason.includes('TAKE') ? 'Take Profit ✅' : 'Stop Loss 🛑'}\n\n` +
              `💰 PnL: ${parseFloat(pnl) >= 0 ? '+' : ''}${pnl} USD\n` +
              `💵 Em BRL: R$ ${parseFloat(pnl) >= 0 ? '+' : ''}${pnlBrl}\n` +
              `📊 Variação: ${parseFloat(pnlPct) >= 0 ? '+' : ''}${pnlPct}%\n` +
              `⏱ Duração: ${duracao} minutos`);
          } catch (err) {
            console.log(`❌ [${pos.symbol}] VENDA FALHOU: ${err.message}`);
          }
        } else {
          const pnl = ((price - pos.entryPrice) * pos.quantity).toFixed(4);
          const pnlPct = (((price - pos.entryPrice) / pos.entryPrice) * 100).toFixed(2);
          const usdBrl = 5.7;
          const pnlBrl = (parseFloat(pnl) * usdBrl).toFixed(2);
          const resultado = parseFloat(pnl) >= 0 ? '✅ LUCRO' : '❌ PREJUÍZO';
          const duracao = pos.openedAt ? Math.round((Date.now() - new Date(pos.openedAt).getTime()) / 60000) : '?';
          Object.assign(pos, { status: "closed", closedAt: new Date().toISOString(), exitPrice: price, exitReason, exitOrderId: `PAPER-SELL-${Date.now()}`, pnl: parseFloat(pnl) });
          console.log(`📋 [${pos.symbol}] PAPER SELL @ $${price} | PnL: $${pnl}`);
          sendWhatsApp(`${resultado} [PAPER] — ${pos.symbol} (${pos.timeframe})\n\n📋 Resumo do Trade\n` +
            `Plano: ${pos.plan || 'Auto'}\n` +
            `Entrada: $${pos.entryPrice}\n` +
            `Saída:   $${price}\n` +
            `Motivo:  ${exitReason.includes('TAKE') ? 'Take Profit ✅' : 'Stop Loss 🛑'}\n\n` +
            `💰 PnL: ${parseFloat(pnl) >= 0 ? '+' : ''}${pnl} USD\n` +
            `💵 Em BRL: R$ ${parseFloat(pnl) >= 0 ? '+' : ''}${pnlBrl}\n` +
            `📊 Variação: ${parseFloat(pnlPct) >= 0 ? '+' : ''}${pnlPct}%\n` +
            `⏱ Duração: ${duracao} minutos`);
        }
      } else {
        const pnlUnrealized = ((price - pos.entryPrice) * pos.quantity).toFixed(4);
        const pct = (((price - pos.entryPrice) / pos.entryPrice) * 100).toFixed(2);
        console.log(`  📊 [${pos.symbol}] Holding @ $${price} | PnL: $${pnlUnrealized} (${pct}%) | Stop: $${pos.stopPrice} | TP: $${pos.takeProfitPrice}`);
      }
    } catch (err) {
      console.log(`  ❌ [${pos.symbol}] Monitor error: ${err.message}`);
    }
  }

  await db.savePositions(positions);
}

// ─── Tax Summary (delegado ao db.js) ─────────────────────────────────────────

async function generateTaxSummary() {
  await db.initDb();
  const s = await db.generateTaxSummary();
  console.log("\n── Tax Summary ──────────────────────────────────────────\n");
  console.log(`  Total decisions logged : ${s.total}`);
  console.log(`  Live trades executed   : ${s.live}`);
  console.log(`  Paper trades           : ${s.paper}`);
  console.log(`  Blocked by safety check: ${s.blocked}`);
  console.log(`  Total volume (USD)     : $${parseFloat(s.total_volume).toFixed(2)}`);
  console.log("─────────────────────────────────────────────────────────\n");
}

// ─── Main ────────────────────────────────────────────────────────────────────


async function runSymbolCycle(symbol, timeframe, rulesInput, runMode = 'master') {
  // Recarregamento forçado de rules.json no início do ciclo para assegurar frescor absoluto
  let rules = rulesInput;
  try { rules = JSON.parse(readFileSync(RULES_FILE, 'utf8')); } catch(e) {}

  // Plano aplicado quando: active_plan definido OU Modo Auto ativo
  const isAutoMode = rules?.strategy?.key === 'auto';
  const plan = (rules?.active_plan || isAutoMode) ? getPlanForSymbol(symbol, rules, runMode) : null;

  if (isAutoMode && !plan && !_missingPlanWarned.has(symbol)) {
    console.log(`⚠️  [${symbol}] Modo Auto sem plano — símbolo será ignorado. Adicione-o a um group_plan ou remova da watchlist.`);
    _missingPlanWarned.add(symbol);
  }
  if (isAutoMode && !plan) {
    // Retorna um objeto Neutro com aviso explícito de bloqueio para manter o ativo visível no painel
    const dummyResults = [{ label: "Plano associado ao ativo", pass: false, required: "Sim", actual: "Não" }];
    return {
      symbol, timeframe, price: null, indicators: {}, side: null, stopPrice: null,
      conditions: dummyResults, allPass: false, forced: false, tradeSize: 0,
      orderPlaced: false, orderId: null, mode: 'spot', paperTrading: true,
      strategy: rules?.strategy?.key || 'warrior', plan: 'Sem Plano'
    };
  }
  if (plan && plan.timeframes && !plan.timeframes.some(t => t.toLowerCase() === timeframe.toLowerCase())) {
    if (process.env.FORCE_ONCE === '1') {
      console.log(`⚠️  [${symbol}] Timeframe ${timeframe} não permitido no plano ${plan.name}. Timeframes válidos: ${plan.timeframes.join(', ')}`);
    }
    return null; 
  }

  console.log(`\n🔍 Scanning: ${symbol} (${timeframe})${plan ? ` [${plan.name}]` : ''}`);
  
  // Sincroniza o TradingView visualmente APENAS se houver sinal ou no Dashboard manual
  // Removido da varredura constante para evitar popups de "Premium" no TradingView
  /* 
  try {
    await fetch(`http://localhost:${process.env.PORT || 3334}/api/symbol`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symbol: symbol })
    });
    // ...
  } catch (e) {}
  */

  // Update CONFIG for this specific symbol
  const localConfig = { ...CONFIG, symbol, timeframe };
  if (plan) {
    if (plan.portfolioValue) localConfig.portfolioValue = plan.portfolioValue;
    if (plan.maxTradeUsd) localConfig.maxTradeSizeUSD = plan.maxTradeUsd;
  }

  // Força execução estritamente no ambiente ativo (Spot ou Futures) para evitar cruzamento e conflito de ordens
  // O runMode é a autoridade final: master => SEMPRE spot, futures => SEMPRE futures.
  // Isso evita que um símbolo só listado em plano de futuros (XRP, LTC, AVAX, TRX)
  // seja gravado como mode:'futures' quando rodando no MasterBot Spot.
  const isFutures = runMode === 'futures' || process.env.FORCE_MODE === 'futures';
  const leverage = isFutures ? (plan?.leverage || 1) : 1;
  const candles = await fetchCandles(localConfig.symbol, localConfig.timeframe, 500, isFutures);
  const closes = candles.map((c) => c.close);
  const price = closes[closes.length - 1];

  // Strategy dispatch — quando há um plano ATIVO cobrindo o símbolo, a estratégia
  // do plano manda sempre (o usuário validou essa lógica no backtest do wizard).
  // O seletor global (BOT_STRATEGY / rules.strategy.key) vale só no modo avulso
  // ou no Modo Auto, que usa a estratégia do plano do símbolo quando existir.
  const rawStratKey = rules?.strategy?.key || process.env.BOT_STRATEGY || "warrior";
  const isActivePlan = !!(plan && rules?.active_plan && rules.active_plan === plan.name);
  const stratKey = isActivePlan
    ? (plan.strategy || "warrior")
    : (rawStratKey === "auto" ? (plan?.strategy || "warrior") : rawStratKey);
  let safetyResult;
  let activeIndicators = {};
  let usedStrategy = stratKey;

  if (stratKey === "both") {
    // Run Warrior first; if it passes, use it. Otherwise try Stormer.
    const warriorResult = runSafetyCheckWarrior(candles);
    if (warriorResult.allPass) {
      safetyResult = warriorResult;
      activeIndicators = warriorResult.indicators;
      usedStrategy = "warrior";
      console.log(`  Strategy: BOTH → Warrior gave signal ✅`);
    } else {
      const ema8  = calcEMA(closes, 8);
      const vwap  = calcVWAP(candles);
      const rsi3  = calcRSI(closes, 3);
      const stormerResult = runSafetyCheck(price, ema8, vwap, rsi3, rules);
      safetyResult = stormerResult;
      activeIndicators = { ema8, vwap, rsi3 };
      usedStrategy = "stormer";
      console.log(`  Strategy: BOTH → Warrior ❌ | Stormer ${stormerResult.allPass ? "✅" : "❌"}`);
    }
  } else if (stratKey === "range") {
    // Bloqueia BTCUSDT no 4H (backtest mostrou 25% winrate nessa combinação)
    if (symbol === 'BTCUSDT' && timeframe.toLowerCase() === '4h') {
      safetyResult = { results: [{ label: 'BTC 4H bloqueado no plano Range (backtest negativo)', pass: false, required: 'N/A', actual: 'bloqueado' }], allPass: false, side: null, stopPrice: null };
    } else {
      safetyResult = runSafetyCheckRange(candles);
    }
    activeIndicators = safetyResult.indicators || {};
    usedStrategy = "range";
  } else if (stratKey === "range-v2") {
    safetyResult = runSafetyCheckRangeV2(candles, plan ? (plan.filters || {}) : {});
    activeIndicators = safetyResult.indicators || {};
    usedStrategy = "range-v2";
  } else if (stratKey === "warrior") {
    safetyResult = runSafetyCheckWarrior(candles);
    activeIndicators = safetyResult.indicators;
    usedStrategy = "warrior";
  } else {
    const ema8  = calcEMA(closes, 8);
    const ema80 = calcEMA(closes, 80);
    const vwap = calcVWAP(candles);
    const rsi3 = calcRSI(closes, 3);
    safetyResult = runSafetyCheck(price, ema8, vwap, rsi3, rules);
    activeIndicators = { ema8, ema80, vwap, rsi3 };
    usedStrategy = "stormer";
  }

  let { results, allPass, side, stopPrice } = safetyResult;

  const forceSymbol = process.env.FORCE_SYMBOL;
  const forceTf     = process.env.FORCE_TF;
  const forceSide   = process.env.FORCE_SIDE;
  const isForced    = process.env.FORCE_ONCE === '1' && forceSymbol === symbol && forceTf === timeframe && !!forceSide;

  // ── Aplicar filtros extras do plano e sobrescrever SL/TP ─────────
  const atr = calcATR(candles, 14);
  let takeProfitPrice = stopPrice ? price + (price - stopPrice) * 2 : null;

  if (plan) {
    // Filtros extras (ADX, RSI range, Volume, Supertrend)
    const extraFilters = applyPlanFilters(candles, plan);
    if (extraFilters.length > 0) {
      results = [...results, ...extraFilters];
      allPass = results.every(r => r.pass);
    }
    // Sobrescrever SL/TP conforme plano
    if (atr && (side || isForced)) {
      // Se a estratégia for range-v2, o SL/TP já vem calculado pela zona
      if (usedStrategy === 'range-v2' && safetyResult.stopPrice && safetyResult.takeProfitPrice) {
        stopPrice = safetyResult.stopPrice;
        takeProfitPrice = safetyResult.takeProfitPrice;
      } else {
        const sltp = calcPlanStopTP(price, atr, plan, isForced ? forceSide : side);
        stopPrice = sltp.stop;
        takeProfitPrice = sltp.tp;
      }
      console.log(`  📐 [${plan.name}] SL: $${stopPrice.toFixed(6)} | TP: $${takeProfitPrice.toFixed(6)} (break-even alvo: ${plan.breakeven_pct != null ? plan.breakeven_pct + '%' : 'desativado'})`);
    }

    // Filtro Dual Timeframe (ADX 4H) para Range v2
    if (plan.filters.adx_4h_max != null && timeframe !== '4H') {
      try {
        const candles4h = await fetchCandles(symbol, '4H', 100, isFutures);
        const adx4h = calcADX(candles4h, 14);
        const pass = adx4h != null && adx4h.adx <= plan.filters.adx_4h_max;
        const res4h = {
          label: `ADX 4H ≤ ${plan.filters.adx_4h_max} (filtro macro range)`,
          pass,
          required: `≤ ${plan.filters.adx_4h_max}`,
          actual: adx4h != null ? adx4h.adx.toFixed(1) : '—'
        };
        results.push(res4h);
        if (!pass) allPass = false;
      } catch (e) {
        console.log(`  ⚠ Erro ao buscar 4H candles para ${symbol} (filtro macro): ${e.message}`);
      }
    }
  }

  // ── Force Trade: bypass APÓS todos os filtros ─────────────────────
  let forcedOverride = false;
  let originalResults = results; // preserva resultados reais para o log
  if (isForced) {
    forcedOverride = true;
    allPass = true;
    side = forceSide;
    // NÃO modifica results — mantém pass/fail original para o histórico
    if (!stopPrice && atr) stopPrice = forceSide === 'LONG' ? price - atr * 1.5 : price + atr * 1.5;
    if (!takeProfitPrice && stopPrice) takeProfitPrice = forceSide === 'LONG' ? price + (price - stopPrice) * 2 : price - (stopPrice - price) * 2;
    console.log(`⚡ [${symbol}] FORCE TRADE — todos os filtros ignorados. side: ${forceSide} | SL: $${stopPrice?.toFixed(6)} | TP: $${takeProfitPrice?.toFixed(6)}`);
  }

  // ── Bloqueio de duplicata: se já existe posição aberta deste símbolo, não compra de novo ──
  let _currentPositions = null;
  if (allPass) {
    _currentPositions = await db.loadPositions();
    const openSame = _currentPositions.find(p => p.symbol === symbol && p.status === "open");
    if (openSame) {
      const dupLabel = `Sem posição aberta de ${symbol}`;
      const dupCond = {
        label: dupLabel,
        pass: false,
        required: "nenhuma posição aberta",
        actual: `posição aberta desde ${openSame.openedAt} (id ${openSame.id})`,
      };
      results = [...results, dupCond];
      originalResults = [...originalResults, dupCond];
      allPass = false;
      console.log(`🚫 [${symbol}] BLOQUEADO: já existe posição aberta (${openSame.id}) — ignorando sinal para evitar compra duplicada.`);
    }
  }

  // ── Limite de posições simultâneas: evita entrada correlacionada em correção de mercado ──
  if (allPass) {
    const maxConcurrent = rules.max_concurrent_positions || 999;
    const openCount = (_currentPositions ?? await db.loadPositions()).filter(p => p.status === "open").length;
    if (openCount >= maxConcurrent) {
      const concCond = {
        label: `Posições abertas < ${maxConcurrent}`,
        pass: false,
        required: `máx ${maxConcurrent}`,
        actual: `${openCount} abertas`,
      };
      results = [...results, concCond];
      originalResults = [...originalResults, concCond];
      allPass = false;
      console.log(`🚫 [${symbol}] BLOQUEADO: limite de ${maxConcurrent} posições simultâneas atingido (${openCount} abertas).`);
    }
  }

  // Trailing Stop
  let trailingRate = null;
  if (allPass) {
    if (plan && plan.tp?.type === 'trail') {
      // Trail do plano (ex: PlanTrend)
      trailingRate = (plan.tp.offset / 100).toFixed(4);
    } else if (rules.exit_rules_config?.trailing_stop?.enabled) {
      // Trail global via ATR
      if (atr) {
        const multiplier = rules.exit_rules_config.trailing_stop.multiplier || 2.0;
        trailingRate = ((atr * multiplier) / price).toFixed(4);
      }
    }
  }

  const tradeSize = Math.min(localConfig.portfolioValue * CONFIG.tradePercent, localConfig.maxTradeSizeUSD);

  const logEntry = {
    timestamp: new Date().toISOString(),
    symbol,
    timeframe: localConfig.timeframe,
    price,
    indicators: activeIndicators,
    side,
    stopPrice: stopPrice || null,
    trailingRate: trailingRate ? parseFloat(trailingRate) : null,
    conditions: originalResults,
    allPass,
    forced: forcedOverride,
    tradeSize,
    orderPlaced: false,
    orderId: null,
    leverage,
    mode: isFutures ? 'futures' : 'spot',
    paperTrading: localConfig.paperTrading,
    strategy: usedStrategy,
    plan: plan?.name || null,
    leverage: leverage
  };

  if (isFutures) {
    console.log(`  DEBUG: [${symbol}] Mode: Futures | Plan: ${plan?.name} | Leverage: ${leverage}x`);
  }

  if (allPass) {
    const orderSide = side === "LONG" ? "buy" : "sell";
    if (localConfig.paperTrading) {
      logEntry.orderPlaced = true;
      logEntry.orderId = `PAPER-${Date.now()}`;
      console.log(`✅ [${symbol}] PASS — Paper Order: ${logEntry.orderId}`);
      const execQty = tradeSize / price;
      await db.addPosition(symbol, timeframe, price, execQty, stopPrice, takeProfitPrice, logEntry.orderId, null, usedStrategy, results, activeIndicators, plan?.name);
      // Sem notificação de abertura — apenas resumo no fechamento
    } else {
      try {
        let order;
        let execQtyNum;
        let ocoOrderListId = null;

        if (isFutures) {
          // --- EXECUÇÃO FUTUROS ---
          order = await placeBinanceFuturesOrder(symbol, orderSide, tradeSize, leverage, price);
          logEntry.orderPlaced = true;
          logEntry.orderId = order.orderId;
          execQtyNum = (tradeSize * leverage) / price;
          
          if (stopPrice && takeProfitPrice) {
            await placeFuturesStopOrders(symbol, side, execQtyNum, stopPrice, takeProfitPrice);
          }
        } else {
          // --- EXECUÇÃO SPOT ---
          order = await placeBinanceOrder(symbol, orderSide, tradeSize, price);
          logEntry.orderPlaced = true;
          logEntry.orderId = order.orderId;
          const execQtyRaw = parseFloat(order.executedQty) || (tradeSize / price);
          execQtyNum = execQtyRaw * 0.999; // Deduz 0.1% para taxas
          // Arredonda ao stepSize do par — String(execQtyNum) mandava dízimas
          // (ex.: 0.47504847600000004) que a Binance rejeita por LOT_SIZE,
          // deixando a posição sem OCO na exchange.
          const execQtyStr = await roundQty(symbol, execQtyNum, false);

          if (stopPrice && takeProfitPrice && execQtyNum > 0) {
            const delays = [500, 2000, 5000];
            for (let attempt = 0; attempt < delays.length; attempt++) {
              try {
                await sleep(delays[attempt]);
                const ocoResult = await placeOCOOrder(symbol, execQtyStr, takeProfitPrice, stopPrice);
                ocoOrderListId = ocoResult.orderListId;
                logEntry.ocoOrderListId = ocoOrderListId;
                console.log(`🎯 [${symbol}] OCO COLOCADA (tentativa ${attempt+1}): TP $${takeProfitPrice.toFixed(8)} | Stop $${stopPrice.toFixed(8)}`);
                break;
              } catch (ocoErr) {
                const last = attempt === delays.length - 1;
                console.log(`${last ? '❌' : '⚠'} [${symbol}] OCO tentativa ${attempt+1}/${delays.length} falhou: ${ocoErr.message}`);
                if (last) logEntry.ocoError = ocoErr.message;
              }
            }
          }
        }

        console.log(`🚀 [${symbol}] LIVE ORDER EXECUTED on Binance: ${order.orderId}`);
        await db.addPosition(symbol, timeframe, price, execQtyNum, stopPrice, takeProfitPrice, order.orderId, ocoOrderListId, usedStrategy, results, activeIndicators, plan?.name);
      } catch (err) {
        console.log(`❌ [${symbol}] ORDER FAILED: ${err.message}`);
        logEntry.error = err.message;
      }
    }

    // ── Marca a entrada no TradingView via alerta do Dashboard ──
    try {
      /*
      // Sincroniza o gráfico visualmente para o par do sinal
      await fetch("http://localhost:3333/api/symbol", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol: symbol })
      });
      await fetch("http://localhost:3333/api/timeframe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ timeframe: timeframe })
      });
      */

      const stratKey = process.env.BOT_STRATEGY || "warrior";
      const emoji = side === "LONG" ? "🟢" : "🔴";
      const modeTag = localConfig.paperTrading ? "[PAPER]" : "[LIVE]";
      await fetch(`http://localhost:${process.env.PORT || 3334}/api/alerts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          condition: "price",
          price: price,
          message: `${emoji} ${modeTag} BOT ${usedStrategy.toUpperCase()} — ENTRADA ${side} em ${symbol} @ $${price.toFixed(2)} (${timeframe}) | ${new Date().toLocaleTimeString("pt-BR")}`
        })
      });
      console.log(`📍 [${symbol}] Entrada marcada no TradingView @ $${price.toFixed(2)}`);
    } catch (e) {
      // Silencioso se dashboard não estiver ativo
    }
  } else {
    console.log(`🚫 [${symbol}] BLOCKED by safety check.`);
  }

  return logEntry;
}

async function run(runMode = 'manual') {
  checkOnboarding();
  await db.initDb();
  
  const isLoop = runMode === 'master' || runMode === 'futures';
  if (isLoop) {
    await writeLoopStatus("running", [], runMode === 'futures');
  }

  if (!CONFIG.paperTrading) {
    await checkBinancePermissions();
  }
  if (runMode === 'master' && typeof syncBrain === 'function') await syncBrain();

  console.log("\n" + "═".repeat(60));
  console.log(`  🤖 ${runMode.toUpperCase()} CYCLE START: ${new Date().toLocaleString()}`);
  console.log(`  Trade Mode: ${CONFIG.paperTrading ? "📋 PAPER" : "🔴 LIVE"}`);
  console.log("═".repeat(60));

  // ── Monitorar posições abertas ANTES de escanear novos sinais ──
  await monitorPositions();

  // Read rules once at start to get the base structures
  let currentRules = JSON.parse(readFileSync(RULES_FILE, "utf8"));
  const { warnings: ruleWarnings, errors: ruleErrors } = validateRules(currentRules);
  for (const w of ruleWarnings) console.log(`⚠️  rules.json: ${w}`);
  for (const e of ruleErrors) console.error(`❌ rules.json: ${e}`);
  if (ruleErrors.length > 0) {
    console.error("❌ Abortando: corrija rules.json antes de subir o bot.");
    process.exit(1);
  }
  let timeframes = currentRules.timeframes || [CONFIG.timeframe];

  // Identificar quais ativos pertencem ao mercado de Futuros
  const futuresSymbols = new Set();
  (currentRules.group_plans || []).forEach(p => {
    if (p.mode === 'futures') (p.symbols || []).forEach(s => futuresSymbols.add(s));
  });

  // ── Verificar saldo disponível para novas entradas ───────────────
  const isFuturesMode = runMode === 'futures';
  const minRequired = Math.min(CONFIG.portfolioValue * CONFIG.tradePercent, CONFIG.maxTradeSizeUSD);
  let balanceOk = true;
  if (!CONFIG.paperTrading) {
    const usdtBalance = await getAvailableUSDT(isFuturesMode);
    if (usdtBalance !== null && usdtBalance < minRequired) {
      console.log(`\n💰 Saldo insuficiente para novas entradas: $${usdtBalance.toFixed(2)} disponível no ${isFuturesMode ? 'FUTUROS' : 'SPOT'} (mínimo necessário para margem: ~$${minRequired.toFixed(2)})`);
      console.log(`   Bot aguardando posições fecharem para recuperar saldo...`);
      balanceOk = false;
    } else if (usdtBalance !== null) {
      console.log(`\n💰 Saldo disponível (${isFuturesMode ? 'FUTUROS' : 'SPOT'}): $${usdtBalance.toFixed(2)} USDT ✅`);
    }
  }

  const summary = [];

  // ── Kill switch: perda máxima diária (rules.risk.daily_max_loss_usd) ──
  // Bloqueia NOVAS entradas quando a perda realizada do dia (UTC) atinge o
  // limite. O monitor de posições já rodou acima — saídas nunca são bloqueadas.
  const dailyMaxLoss = parseFloat(currentRules?.risk?.daily_max_loss_usd || 0);
  if (dailyMaxLoss > 0) {
    try {
      const todayPnl = await db.getTodayRealizedPnlUsd();
      if (todayPnl <= -dailyMaxLoss) {
        console.log(`🛑 [KILL SWITCH] Perda do dia: $${todayPnl.toFixed(2)} (limite: $${dailyMaxLoss.toFixed(2)}) — sem novas entradas até a virada do dia UTC. Posições abertas seguem monitoradas.`);
        const todayKey = new Date().toISOString().slice(0, 10);
        if (globalThis.__killSwitchNotifiedDay !== todayKey) {
          globalThis.__killSwitchNotifiedDay = todayKey;
          sendWhatsApp(`🛑 KILL SWITCH ATIVADO\n\nPerda realizada hoje: $${todayPnl.toFixed(2)}\nLimite configurado: $${dailyMaxLoss.toFixed(2)}\n\nO robô NÃO abrirá novas operações até amanhã (00:00 UTC). Posições abertas continuam monitoradas e protegidas.`);
        }
        if (isLoop) await writeLoopStatus("waiting", summary, isFuturesMode);
        return;
      }
    } catch (ksErr) {
      console.log(`  ⚠ Kill switch: falha ao apurar PnL diário: ${ksErr.message}`);
    }
  }

  const entries = isLoop ? ["DYNAMIC"] : (currentRules.watchlist || [CONFIG.symbol]);
  
  if (!balanceOk) {
    if (isLoop) await writeLoopStatus("waiting", summary, isFuturesMode);
    return;
  }

  for (const symbolEntry of entries) {
    let watchlistToUse = [];
    if (isLoop) {
      const refreshedRules = JSON.parse(readFileSync(RULES_FILE, "utf8"));
      const activePlanName = refreshedRules.active_plan || null;
      const activePlan = activePlanName
        ? (refreshedRules.group_plans || []).find(p => p.name === activePlanName)
        : null;
      watchlistToUse = (activePlan?.symbols?.length) ? activePlan.symbols : (refreshedRules.watchlist || []);
      timeframes = (activePlan?.timeframes?.length) ? activePlan.timeframes : (refreshedRules.timeframes || ["15m"]);
      currentRules = refreshedRules;
      
      // ISOLAR AMBIENTES: MasterBot (Spot) executa ativos com cobertura em plano não-futures;
      // FuturesBot executa exclusivamente os ativos configurados no plano de Futuros.
      const fPlan = (refreshedRules.group_plans || []).find(p => p.mode === 'futures' || p.name === 'Alpha_Futures_Trend');
      const spotSymbols = new Set();
      (refreshedRules.group_plans || []).forEach(p => {
        if (p.mode !== 'futures') (p.symbols || []).forEach(s => spotSymbols.add(s));
      });
      if (runMode === 'futures') {
        watchlistToUse = fPlan?.symbols?.length ? fPlan.symbols : watchlistToUse.filter(s => futuresSymbols.has(s));
      } else {
        // No modo Spot, removemos apenas símbolos EXCLUSIVAMENTE de futuros
        // (símbolos que estão em planos de futuros mas também em planos spot continuam permitidos)
        watchlistToUse = watchlistToUse.filter(s => spotSymbols.has(s) || !futuresSymbols.has(s));
      }
    } else {
      watchlistToUse = [CONFIG.symbol];
    }

    const targetSymbols = isLoop ? watchlistToUse : [symbolEntry];
    if (isLoop && symbolEntry === "DYNAMIC") {
       const isAutoMode = currentRules?.strategy?.key === 'auto' && !currentRules?.active_plan;
       for (const symbol of targetSymbols) {
         let tfsForSymbol = timeframes;
         if (isAutoMode) {
           const symPlan = getPlanForSymbol(symbol, currentRules, runMode);
           if (!symPlan) {
             try {
               await runSymbolCycle(symbol, timeframes[0] || "1h", currentRules, runMode);
             } catch (dummyErr) {
               console.error(`  ❌ Erro no ciclo sem plano para ${symbol}:`, dummyErr.message);
             }
             continue;
           }
           tfsForSymbol = (symPlan.timeframes && symPlan.timeframes.length) ? symPlan.timeframes : timeframes;
         }
         for (const tf of tfsForSymbol) {
           try {
             const result = await runSymbolCycle(symbol, tf, currentRules, runMode);
             if (result) {
               summary.push(result);
               await db.appendToLog(result);
             }
           } catch (cycleErr) {
             console.error(`  ❌ Erro no ciclo para ${symbol} ${tf}:`, cycleErr.message);
           }
         }
         console.log(`⏳ Aguardando 5s antes do próximo ativo...`);
         await sleep(5000);
       }
       break; 
    } else {
       const symbol = symbolEntry;
       for (const tf of timeframes) {
          try {
            const result = await runSymbolCycle(symbol, tf, currentRules, runMode);
            if (result) {
              summary.push(result);
              await db.appendToLog(result);
            }
          } catch (manualErr) {
            console.error(`  ❌ Erro no ciclo manual para ${symbol} ${tf}:`, manualErr.message);
          }
       }
    }
  }

  if (isLoop) {
    await writeLoopStatus("waiting", summary, isFuturesMode);
    console.log("\n" + "═".repeat(60));
    console.log(`  🏁 ${runMode.toUpperCase()} CYCLE COMPLETE. Status: WAITING for next interval.`);
    console.log("═".repeat(60));
  } else {
    console.log("\n" + "═".repeat(60));
    console.log(`  🏁 MANUAL CYCLE COMPLETE.`);
    console.log("═".repeat(60));
  }
}

function parseIntervalMs(str) {
  const n = parseInt(str);
  if (str.endsWith('m')) return n * 60 * 1000;
  return n * 60 * 60 * 1000; 
}

function startScheduler(runMode = 'master') {
  const intervalStr = process.env.MASTERBOT_LOOP_INTERVAL || "4h";
  const ms = parseIntervalMs(intervalStr);

  console.log(`\n⏰ ${runMode.toUpperCase()} Scheduler Active: Runs every ${intervalStr} (${ms/1000}s)`);

  let isExecuting = false;
  const heartbeat = async () => {
    if (isExecuting) {
      console.log(`⏳ [Scheduler] Execução anterior do ${runMode.toUpperCase()} ainda em processamento. Evitando sobreposição de ciclos.`);
      return;
    }
    isExecuting = true;
    try {
      await run(runMode);
    } catch (err) {
      console.error(`❌ [Scheduler] Falha não tratada capturada no loop principal do ${runMode.toUpperCase()}:`, err.message);
      // Garante que o status no banco retorne para 'waiting' permitindo rearmar na UI/Dashboard
      try { await writeLoopStatus("waiting", [], runMode === 'futures'); } catch (_) {}
    } finally {
      isExecuting = false;
    }
  };

  heartbeat();
  setInterval(heartbeat, ms);
}

// Detecta se este arquivo é o entry point — funciona com node direto E com wrappers (PM2 ProcessContainerFork)
const __isMainEntry = (() => {
  try {
    const selfPath = fileURLToPath(import.meta.url);
    if (process.argv[1] === selfPath) return true;
    // Sob PM2, process.argv[1] aponta para ProcessContainerFork.js;
    // nesse caso o entry real está em process.env.pm_exec_path
    if (process.env.pm_exec_path && process.env.pm_exec_path === selfPath) return true;
    return false;
  } catch (e) { return false; }
})();

if (__isMainEntry) {
  if (process.argv.includes("--tax-summary")) {
    generateTaxSummary();
  } else if (process.argv.includes("--futures")) {
    const pidFile = join(__dirname, "futures.pid");
    writeFileSync(pidFile, process.pid.toString());
    console.log(`📌 Futures PID saved to: ${pidFile}`);
    startScheduler('futures');
  } else if (process.argv.includes("--master")) {
    const pidFile = join(__dirname, "master.pid");
    writeFileSync(pidFile, process.pid.toString());
    console.log(`📌 Master PID saved to: ${pidFile}`);
    startScheduler('master');
  } else if (process.env.FORCE_ONCE === '1') {
    const forceSym = process.env.FORCE_SYMBOL;
    const forceTf  = process.env.FORCE_TF;
    const forceMode = process.env.FORCE_MODE || 'spot';
    const forceRules = JSON.parse(readFileSync(RULES_FILE, "utf8"));
    console.log(`\n⚡ FORCE TRADE MODE: ${forceSym} ${forceTf} ${process.env.FORCE_SIDE} [${forceMode.toUpperCase()}]`);
    db.initDb().then(() => runSymbolCycle(forceSym, forceTf, forceRules, forceMode)).then(async result => {
      if (result) await db.appendToLog(result);
      process.exit(0);
    }).catch(err => { console.error("Force trade error:", err); process.exit(1); });
  } else {
    run('manual').catch((err) => {
      console.error("Bot error:", err);
      process.exit(1);
    });
  }
}

async function writeLoopStatus(status = "running", results = [], isFutures = false) {
  const now = Date.now();
  const rules = JSON.parse(readFileSync(RULES_FILE, "utf8"));
  const intervalStr = process.env.MASTERBOT_LOOP_INTERVAL || "4h";
  const intervalMs = parseIntervalMs(intervalStr);

  const allPositions = await db.loadPositions();
  const state = {
    status,
    lastRun: new Date().toISOString(),
    nextRun: new Date(now + intervalMs).toISOString(),
    interval: intervalStr,
    watchlist: rules.watchlist || [],
    timeframes: rules.timeframes || [],
    obsidianOnline: !!process.env.OBSIDIAN_PATH && existsSync(process.env.OBSIDIAN_PATH),
    openPositions: allPositions.filter(p => p.status === "open").length,
    lastResults: results.map(r => ({
      symbol: r.symbol,
      timeframe: r.timeframe,
      allPass: r.allPass,
      side: r.side,
      signal: r.allPass ? (r.orderPlaced ? (r.side || 'LONG') : 'SEM SALDO') : 'NEUTRO',
      price: r.price || null,
      change_pct: r.price && r.indicators?.vwap
        ? parseFloat((((r.price - r.indicators.vwap) / r.indicators.vwap) * 100).toFixed(2))
        : null,
      strategy: r.strategy || null,
    }))
  };
  
  if (isFutures) await db.writeFuturesStatus(state);
  else await db.writeMasterStatus(state);
}
