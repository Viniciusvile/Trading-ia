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

function getPlanForSymbol(symbol, rules) {
  const plans = rules.group_plans || [];
  const found = plans.find(p => p.symbols.includes(symbol)) || null;
  if (found) {
    console.log(`  [PLAN MATCH] Symbol: ${symbol} -> Plan: ${found.name} | Mode: ${found.mode} | Leverage: ${found.leverage}x`);
  } else {
    console.log(`  [PLAN MATCH] Symbol: ${symbol} -> NO PLAN FOUND`);
  }
  return found;
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

async function getAvailableUSDT() {
  try {
    const timeRes = await fetch("https://api.binance.com/api/v3/time");
    const timestamp = (await timeRes.json()).serverTime;
    const queryString = `timestamp=${timestamp}`;
    const signature = crypto.createHmac("sha256", CONFIG.binance.secretKey).update(queryString).digest("hex");
    const res = await fetch(`${CONFIG.binance.baseUrl}/api/v3/account?${queryString}&signature=${signature}`, {
      headers: { "X-MBX-APIKEY": CONFIG.binance.apiKey }
    });
    const data = await res.json();
    if (data.code && data.code < 0) throw new Error(`[${data.code}] ${data.msg}`);
    const usdt = data.balances?.find(b => b.asset === "USDT");
    return usdt ? parseFloat(usdt.free) : 0;
  } catch (e) {
    console.log(`⚠ Não foi possível verificar saldo: ${e.message}`);
    return null; // null = inconclusivo, não bloqueia
  }
}

async function checkBinancePermissions() {
  console.log("\n── Binance API Diagnostic ───────────────────────────────");
  try {
    const timeRes = await fetch("https://api.binance.com/api/v3/time");
    const time = await timeRes.json();
    const timestamp = time.serverTime;
    const queryString = `timestamp=${timestamp}`;
    const signature = crypto.createHmac("sha256", CONFIG.binance.secretKey).update(queryString).digest("hex");
    
    const res = await fetch(`${CONFIG.binance.baseUrl}/api/v3/account?${queryString}&signature=${signature}`, {
      headers: { "X-MBX-APIKEY": CONFIG.binance.apiKey }
    });
    const data = await res.json();
    
    if (data.canTrade) {
      console.log("✅ API Key: Conectada e com permissão de Trading!");
    } else if (data.code === -2015) {
      console.log("❌ Erro [-2015]: Chave Inválida ou sem permissão de IP/Trading.");
    } else {
      console.log("⚠ API Key conectada, mas verifique 'Spot Trading' na Binance.");
      if (data.msg) console.log(`   Motivo: ${data.msg}`);
    }
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
    await setFuturesLeverage(symbol, leverage);
    
    // No futuros, precisamos da quantidade no ativo base (ex: 0.001 BTC)
    // Cálculo: (USD * leverage) / preço_atual
    const rawQty = (sizeUSD * leverage) / price;
    const qty = await roundQty(symbol, rawQty, true); // true = isFutures

    const timestamp = Date.now();
    const queryString = `symbol=${symbol}&side=${side.toUpperCase()}&type=MARKET&quantity=${qty}&timestamp=${timestamp}`;
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
  const timestamp = Date.now();
  
  // 1. Stop Loss (MARKET)
  const slQuery = `symbol=${symbol}&side=${closeSide}&type=STOP_MARKET&stopPrice=${await roundPrice(symbol, stopPrice, true)}&closePosition=true&timestamp=${timestamp}`;
  const slSig = crypto.createHmac("sha256", CONFIG.binance.secretKey).update(slQuery).digest("hex");
  await fetch(`https://fapi.binance.com/fapi/v1/order?${slQuery}&signature=${slSig}`, { method: "POST", headers: { "X-MBX-APIKEY": CONFIG.binance.apiKey } });

  // 2. Take Profit (MARKET)
  const tpQuery = `symbol=${symbol}&side=${closeSide}&type=TAKE_PROFIT_MARKET&stopPrice=${await roundPrice(symbol, tpPrice, true)}&closePosition=true&timestamp=${timestamp}`;
  const tpSig = crypto.createHmac("sha256", CONFIG.binance.secretKey).update(tpQuery).digest("hex");
  await fetch(`https://fapi.binance.com/fapi/v1/order?${tpQuery}&signature=${tpSig}`, { method: "POST", headers: { "X-MBX-APIKEY": CONFIG.binance.apiKey } });
  
  console.log(`  🛡️ [${symbol}] Stop Loss e Take Profit (Futures) ativados.`);
}

let _symbolPrecisionCache = {};

async function getPrecision(symbol, isFutures = false) {
  const cacheKey = `${symbol}_${isFutures}`;
  if (_symbolPrecisionCache[cacheKey]) return _symbolPrecisionCache[cacheKey];
  try {
    const baseUrl = isFutures ? 'https://fapi.binance.com' : 'https://api.binance.com';
    const endpoint = isFutures ? '/fapi/v1/exchangeInfo' : '/api/v3/exchangeInfo';
    const res = await fetch(`${baseUrl}${endpoint}?symbol=${symbol}`);
    const data = await res.json();
    const info = data.symbols?.[0];
    if (!info) return { price: 8, qty: 8 };
    const pf = info.filters.find(f => f.filterType === 'PRICE_FILTER');
    const lf = info.filters.find(f => f.filterType === 'LOT_SIZE');
    const tick = pf ? parseFloat(pf.tickSize) : 0.00000001;
    const step = lf ? parseFloat(lf.stepSize) : 0.00000001;
    const countDecimals = (n) => {
      if (Math.floor(n) === n) return 0;
      const s = n.toString();
      if (s.includes('e-')) {
        const parts = s.split('e-');
        return parseInt(parts[1]);
      }
      return s.split(".")[1].length || 0;
    };
    _symbolPrecisionCache[cacheKey] = { price: countDecimals(tick), qty: countDecimals(step) };
    return _symbolPrecisionCache[cacheKey];
  } catch (e) { return { price: 8, qty: 8 }; }
}

async function roundPrice(symbol, price, isFutures = false) {
  const p = await getPrecision(symbol, isFutures);
  return parseFloat(price.toFixed(p.price));
}

async function roundQty(symbol, qty, isFutures = false) {
  const p = await getPrecision(symbol, isFutures);
  return parseFloat(qty.toFixed(p.qty));
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

async function placeBinanceSellOrder(symbol, quantity) {
  let timestamp = Date.now();
  try {
    const timeRes = await fetch("https://api.binance.com/api/v3/time");
    const timeData = await timeRes.json();
    timestamp = timeData.serverTime;
  } catch (e) {
    timestamp = Date.now() - 100000;
  }

  // 1. LIMPEZA: Cancela QUALQUER ordem aberta para liberar o saldo total
  try {
    const cancelRes = await fetch(`https://api.binance.com/api/v3/openOrders?symbol=${symbol}&timestamp=${timestamp}&signature=${crypto.createHmac('sha256', CONFIG.binance.secretKey).update(`symbol=${symbol}&timestamp=${timestamp}`).digest('hex')}`, {
      method: 'DELETE',
      headers: { 'X-MBX-APIKEY': CONFIG.binance.apiKey }
    });
    console.log(`  🧹 [${symbol}] Ordens abertas canceladas antes da venda final.`);
  } catch (e) {}

  // 2. PRECISÃO: Arredonda a quantidade conforme as regras da Binance (LOT_SIZE)
  const qtyRounded = await roundQty(symbol, parseFloat(quantity));
  const queryString = `symbol=${symbol}&side=SELL&type=MARKET&quantity=${qtyRounded}&recvWindow=10000&timestamp=${timestamp}`;
  const signature = crypto.createHmac("sha256", CONFIG.binance.secretKey).update(queryString).digest("hex");
  const url = `${CONFIG.binance.baseUrl}/api/v3/order?${queryString}&signature=${signature}`;
  
  const res = await fetch(url, { method: "POST", headers: { "X-MBX-APIKEY": CONFIG.binance.apiKey } });
  const data = await res.json();
  if (data.code && data.code < 0) throw new Error(`Binance SELL failed: [${data.code}] ${data.msg}`);
  return { orderId: String(data.orderId), executedQty: data.executedQty, cummulativeQuoteQty: data.cummulativeQuoteQty };
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

      // ── OCO manual (colocado pelo usuário na Binance): só monitora visualmente ──
      if (pos.ocoManual && pos.ocoPlaced && !CONFIG.paperTrading) {
        const candles = await fetchCandles(pos.symbol, pos.timeframe, 5);
        const price = candles[candles.length - 1].close;
        const pnlUnrealized = ((price - pos.entryPrice) * pos.quantity).toFixed(8);
        const pct = (((price - pos.entryPrice) / pos.entryPrice) * 100).toFixed(2);
        console.log(`  🔗 [${pos.symbol}] OCO manual ativa | Preço: $${price} | PnL: $${pnlUnrealized} (${pct}%) | Stop: $${pos.stopPrice} | TP: $${pos.takeProfitPrice}`);
        continue;
      }

      // ── TENTATIVA DE SINCRONIZAÇÃO OCO (Caso tenha falhado na compra ou bot reiniciado) ──
      if (!pos.ocoPlaced && !CONFIG.paperTrading && pos.stopPrice && pos.takeProfitPrice) {
        try {
          console.log(`  🎯 [${pos.symbol}] Tentando sincronizar OCO para posição aberta #${pos.id}...`);
          const ocoResult = await placeOCOOrder(pos.symbol, String(pos.quantity), pos.takeProfitPrice, pos.stopPrice);
          pos.ocoPlaced = true;
          pos.ocoOrderListId = ocoResult.orderListId;
          console.log(`  ✅ [${pos.symbol}] OCO sincronizada com sucesso: ID #${pos.ocoOrderListId}`);
          await db.savePositions(positions);
          continue;
        } catch (syncErr) {
          console.log(`  ❌ [${pos.symbol}] Falha na sincronização OCO automática: ${syncErr.message}`);
        }
      }

      // ── Posição sem OCO (paper trading ou OCO falhou): monitoramento manual ──
      const candles = await fetchCandles(pos.symbol, pos.timeframe, 100);
      const price = candles[candles.length - 1].close;
      const closes = candles.map(c => c.close);
      const ema9 = calcEMA(closes, 9);
      const ema20 = calcEMA(closes, 20);

      let exitReason = null;
      if (price <= pos.stopPrice) {
        exitReason = `STOP LOSS @ $${price} (limite: $${pos.stopPrice})`;
      } else if (price >= pos.takeProfitPrice) {
        exitReason = `TAKE PROFIT @ $${price} (alvo: $${pos.takeProfitPrice})`;
      } else if (ema9 < ema20) {
        exitReason = `REVERSÃO EMA — EMA9 cruzou abaixo da EMA20`;
      }

      if (exitReason) {
        console.log(`\n🔔 [${pos.symbol}] Saída: ${exitReason}`);
        if (!CONFIG.paperTrading) {
          try {
            const sellOrder = await placeBinanceSellOrder(pos.symbol, pos.quantity);
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


async function runSymbolCycle(symbol, timeframe, rules) {
  // Plano aplicado quando: active_plan definido OU Modo Auto ativo
  const isAutoMode = rules?.strategy?.key === 'auto';
  const plan = (rules?.active_plan || isAutoMode) ? getPlanForSymbol(symbol, rules) : null;

  if (isAutoMode && !plan && !_missingPlanWarned.has(symbol)) {
    console.log(`⚠️  [${symbol}] Modo Auto sem plano — símbolo será ignorado. Adicione-o a um group_plan ou remova da watchlist.`);
    _missingPlanWarned.add(symbol);
  }
  if (isAutoMode && !plan) {
    return null; // sem plano em Modo Auto → não opera
  }
  if (plan && plan.timeframes && !plan.timeframes.some(t => t.toLowerCase() === timeframe.toLowerCase())) {
    return null; // silencioso — apenas pula TFs fora do plano
  }

  console.log(`\n🔍 Scanning: ${symbol} (${timeframe})${plan ? ` [${plan.name}]` : ''}`);
  
  // Sincroniza o TradingView visualmente APENAS se houver sinal ou no Dashboard manual
  // Removido da varredura constante para evitar popups de "Premium" no TradingView
  /* 
  try {
    await fetch("http://localhost:3333/api/symbol", {
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

  const isFutures = plan?.mode === 'futures';
  const leverage = isFutures ? (plan.leverage || 1) : 1;
  
  console.log(`[SCAN DEBUG] Symbol: ${symbol} | Plan: ${plan?.name || 'NONE'} | Mode: ${plan?.mode || 'spot'} | Leverage: ${leverage}x`);
  const candles = await fetchCandles(localConfig.symbol, localConfig.timeframe, 500, isFutures);
  const closes = candles.map((c) => c.close);
  const price = closes[closes.length - 1];

  // Strategy dispatch — no Modo Auto usa a estratégia do plano do símbolo, ou warrior como fallback
  const rawStratKey = rules?.strategy?.key || process.env.BOT_STRATEGY || "warrior";
  const stratKey = rawStratKey === "auto" ? (plan?.strategy || "warrior") : rawStratKey;
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
      const sltp = calcPlanStopTP(price, atr, plan, isForced ? forceSide : side);
      stopPrice = sltp.stop;
      takeProfitPrice = sltp.tp;
      console.log(`  📐 [${plan.name}] SL: $${stopPrice.toFixed(6)} | TP: $${takeProfitPrice.toFixed(6)} (break-even alvo: ${plan.breakeven_pct}%)`);
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
          const execQtyStr = String(execQtyNum);

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
      await fetch("http://localhost:3333/api/alerts", {
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

async function run(isMaster = false) {
  checkOnboarding();
  await db.initDb();
  if (isMaster) await writeMasterStatus("running", []);

  if (!CONFIG.paperTrading) {
    await checkBinancePermissions();
  }
  if (isMaster && typeof syncBrain === 'function') await syncBrain();

  console.log("\n" + "═".repeat(60));
  console.log(`  🤖 ${isMaster ? "MASTERBOT" : "MANUAL"} CYCLE START: ${new Date().toLocaleString()}`);
  console.log(`  Trade Mode: ${CONFIG.paperTrading ? "📋 PAPER" : "🔴 LIVE"}`);
  console.log("═".repeat(60));

  // ── Monitorar posições abertas ANTES de escanear novos sinais ──
  await monitorPositions();

  // ── Verificar saldo disponível para novas entradas ───────────────
  const minRequired = Math.min(CONFIG.portfolioValue * CONFIG.tradePercent, CONFIG.maxTradeSizeUSD);
  let balanceOk = true;
  if (!CONFIG.paperTrading) {
    const usdtBalance = await getAvailableUSDT();
    if (usdtBalance !== null && usdtBalance < minRequired) {
      console.log(`\n💰 Saldo insuficiente para novas entradas: $${usdtBalance.toFixed(2)} disponível (mínimo: $${minRequired.toFixed(2)})`);
      console.log(`   Bot aguardando posições fecharem para recuperar saldo...`);
      balanceOk = false;
    } else if (usdtBalance !== null) {
      console.log(`\n💰 Saldo disponível: $${usdtBalance.toFixed(2)} USDT ✅`);
    }
  }

  const summary = [];

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

  // If master, keep re-reading watchlist before each group
  const entries = isMaster ? ["DYNAMIC"] : (currentRules.watchlist || [CONFIG.symbol]);
  
  if (!balanceOk) {
    if (isMaster) await writeMasterStatus("waiting", summary);
    return;
  }

  for (const symbolEntry of entries) {
    // If master, we re-load rules to respect UI changes INSTANTLY
    let watchlistToUse = [];
    if (isMaster) {
      const refreshedRules = JSON.parse(readFileSync(RULES_FILE, "utf8"));
      const activePlanName = refreshedRules.active_plan || null;
      const activePlan = activePlanName
        ? (refreshedRules.group_plans || []).find(p => p.name === activePlanName)
        : null;
      watchlistToUse = (activePlan?.symbols?.length) ? activePlan.symbols : (refreshedRules.watchlist || []);
      timeframes = (activePlan?.timeframes?.length) ? activePlan.timeframes : (refreshedRules.timeframes || ["15m"]);
      currentRules = refreshedRules;
    } else {
      watchlistToUse = [CONFIG.symbol];
    }

    // Since we are inside a loop that might have been dynamic, we handle the nesting
    const targetSymbols = isMaster ? watchlistToUse : [symbolEntry];
    if (isMaster && symbolEntry === "DYNAMIC") {
       // Em Modo Auto, cada símbolo roda nos TFs DO PLANO dele.
       // Em modo com plano fixo (active_plan) ou estratégia única, usa os TFs globais.
       const isAutoMode = currentRules?.strategy?.key === 'auto' && !currentRules?.active_plan;
       for (const symbol of targetSymbols) {
         let tfsForSymbol = timeframes;
         if (isAutoMode) {
           const symPlan = getPlanForSymbol(symbol, currentRules);
           if (!symPlan) {
             // Aviso já é emitido em runSymbolCycle (uma vez por símbolo)
             await runSymbolCycle(symbol, timeframes[0] || "1h", currentRules);
             continue;
           }
           tfsForSymbol = (symPlan.timeframes && symPlan.timeframes.length) ? symPlan.timeframes : timeframes;
         }
         for (const tf of tfsForSymbol) {
           try {
             const result = await runSymbolCycle(symbol, tf, currentRules);
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
       break; // Exit the "DYNAMIC" wrapper
    } else {
       // Manual mode logic
       const symbol = isMaster ? symbolEntry : symbolEntry;
       for (const tf of timeframes) {
          const result = await runSymbolCycle(symbol, tf, currentRules);
          if (result) {
            summary.push(result);
            await db.appendToLog(result);
          }
       }
    }
  }

  if (isMaster) {
    // ... logic for obsidian ...
    await writeMasterStatus("waiting", summary);
    
    console.log("\n" + "═".repeat(60));
    console.log(`  🏁 CYCLE COMPLETE. Status: WAITING for next interval.`);
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
  return n * 60 * 60 * 1000; // h = horas
}

function startScheduler() {
  const intervalStr = process.env.MASTERBOT_LOOP_INTERVAL || "4h";
  const ms = parseIntervalMs(intervalStr);

  console.log(`\n⏰ MasterBot Scheduler Active: Runs every ${intervalStr} (${ms/1000}s)`);

  run(true).catch(console.error);
  setInterval(() => { run(true).catch(console.error); }, ms);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--tax-summary")) {
    generateTaxSummary();
  } else if (process.argv.includes("--master")) {
    const pidFile = join(__dirname, "master.pid");
    writeFileSync(pidFile, process.pid.toString());
    console.log(`📌 Master PID saved to: ${pidFile}`);
    startScheduler();
  } else if (process.env.FORCE_ONCE === '1') {
    // Force trade: executa apenas o símbolo/TF forçado e sai
    const forceSym = process.env.FORCE_SYMBOL;
    const forceTf  = process.env.FORCE_TF;
    const forceRules = JSON.parse(readFileSync(RULES_FILE, "utf8"));
    console.log(`\n⚡ FORCE TRADE MODE: ${forceSym} ${forceTf} ${process.env.FORCE_SIDE}`);
    db.initDb().then(() => runSymbolCycle(forceSym, forceTf, forceRules)).then(async result => {
      if (result) await db.appendToLog(result);
      process.exit(0);
    }).catch(err => { console.error("Force trade error:", err); process.exit(1); });
  } else {
    run(false).catch((err) => {
      console.error("Bot error:", err);
      process.exit(1);
    });
  }
}


async function writeMasterStatus(status = "running", results = []) {
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
  await db.writeMasterStatus(state);
}
