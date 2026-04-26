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

import "dotenv/config";
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";
import { execSync } from "child_process";
import fetch from "node-fetch";
import { validateRules } from "./lib/rules-validator.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ─── Onboarding ───────────────────────────────────────────────────────────────

function checkOnboarding() {
  const required = ["BINANCE_API_KEY", "BINANCE_SECRET_KEY"];
  const missing = required.filter((k) => !process.env[k] && !process.env[k.replace('BINANCE_','BITGET_')]);

  if (!existsSync(".env")) {
    console.log(
      "\n⚠️  No .env file found — opening it for you to fill in...\n",
    );
    writeFileSync(
      ".env",
      [
        "# BitGet credentials",
        "BITGET_API_KEY=",
        "BITGET_SECRET_KEY=",
        "BITGET_PASSPHRASE=",
        "",
        "# Trading config",
        "PORTFOLIO_VALUE_USD=1000",
        "MAX_TRADE_SIZE_USD=100",
        "MAX_TRADES_PER_DAY=3",
        "PAPER_TRADING=true",
        "SYMBOL=BTCUSDT",
        "TIMEFRAME=4H",
      ].join("\n") + "\n",
    );
    try {
      execSync("open .env");
    } catch {}
    console.log(
      "Fill in your BitGet credentials in .env then re-run: node bot.js\n",
    );
    process.exit(0);
  }

  if (missing.length > 0) {
    console.log(`\n⚠️  Missing credentials in .env: ${missing.join(", ")}`);
    console.log("Opening .env for you now...\n");
    try {
      execSync("open .env");
    } catch {}
    console.log("Add the missing values then re-run: node bot.js\n");
    process.exit(0);
  }

  // Always print the CSV location so users know where to find their trade log
  const csvPath = new URL("trades.csv", import.meta.url).pathname;
  console.log(`\n📄 Trade log: ${csvPath}`);
  console.log(
    `   Open in Google Sheets or Excel any time — or tell Claude to move it:\n` +
      `   "Move my trades.csv to ~/Desktop" or "Move it to my Documents folder"\n`,
  );
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
    apiKey: process.env.BINANCE_API_KEY || process.env.BITGET_API_KEY,
    secretKey: process.env.BINANCE_SECRET_KEY || process.env.BITGET_SECRET_KEY,
    baseUrl: "https://api.binance.com",
  },
};

const LOG_FILE = "safety-check-log.json";
const POSITIONS_FILE = join(__dirname, "positions.json");

// ─── Position Tracking ───────────────────────────────────────────────────────

function loadPositions() {
  if (!existsSync(POSITIONS_FILE)) return [];
  return JSON.parse(readFileSync(POSITIONS_FILE, "utf8"));
}

function savePositions(positions) {
  writeFileSync(POSITIONS_FILE, JSON.stringify(positions, null, 2));
}

function addPosition(symbol, timeframe, entryPrice, quantity, stopPrice, takeProfitPrice, orderId, ocoOrderListId = null, strategy = null, conditions = [], indicators = {}, planName = null) {
  const positions = loadPositions();
  if (positions.find(p => p.symbol === symbol && p.status === "open")) return;
  positions.push({
    id: `POS-${Date.now()}`,
    symbol,
    timeframe,
    side: "LONG",
    entryPrice,
    quantity,
    stopPrice,
    takeProfitPrice,
    orderId,
    ocoOrderListId,
    ocoPlaced: !!ocoOrderListId,
    openedAt: new Date().toISOString(),
    status: "open",
    strategy,
    plan: planName,
    conditions,
    indicators,
  });
  savePositions(positions);
  console.log(`📌 [${symbol}] Posição registrada: entrada $${entryPrice}, stop $${stopPrice?.toFixed(6)}, TP $${takeProfitPrice?.toFixed(6)}${ocoOrderListId ? ` | OCO #${ocoOrderListId}` : ''}`);
}

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

// ─── Logging ────────────────────────────────────────────────────────────────

function loadLog() {
  if (!existsSync(LOG_FILE)) return { trades: [] };
  return JSON.parse(readFileSync(LOG_FILE, "utf8"));
}

function saveLog(log) {
  writeFileSync(LOG_FILE, JSON.stringify(log, null, 2));
}

function countTodaysTrades(log) {
  const today = new Date().toISOString().slice(0, 10);
  return log.trades.filter(
    (t) => t.timestamp.startsWith(today) && t.orderPlaced,
  ).length;
}

// ─── Market Data (Binance public API — free, no auth) ───────────────────────

export async function fetchCandles(symbol, interval, limit = 100) {
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

  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${binanceInterval}&limit=${limit}`;
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
  return plans.find(p => p.symbols.includes(symbol)) || null;
}

const _missingPlanWarned = new Set();

export function calcPlanStopTP(price, atr, plan, side = 'LONG') {
  const dir = side === 'LONG' ? 1 : -1;
  let stop, tp;
  if (plan.sl.type === 'pct') {
    stop = price * (1 - dir * plan.sl.value / 100);
  } else {
    stop = price - dir * atr * plan.sl.multiplier;
  }
  if (plan.tp.type === 'trail') {
    // Trailing stop: TP inicial largo (10%) — o trail gerencia a saída
    tp = price * (1 + dir * 10 / 100);
  } else if (plan.tp.type === 'pct') {
    tp = price * (1 + dir * plan.tp.value / 100);
  } else {
    tp = price + dir * atr * plan.tp.multiplier;
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
    const e9 = calcEMA(closes, 9), e20 = calcEMA(closes, 20);
    const e50 = calcEMA(closes, 50), e200 = calcEMA(closes, 200);
    const pass = e9 > e20 && e20 > e50 && e50 > e200;
    extra.push({ label: `EMA9>EMA20>EMA50>EMA200 (tendência tripla)`, pass, required: 'crescente', actual: pass ? 'ok' : 'falhou' });
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
  let timestamp = Date.now();
  try {
    const timeRes = await fetch("https://api.binance.com/api/v3/time");
    const timeData = await timeRes.json();
    timestamp = timeData.serverTime;
  } catch (e) {
    timestamp = Date.now() - 100000; // approximation if fetch fails
  }

  // Construction of the signed request
  const queryString = `symbol=${symbol}&side=${side.toUpperCase()}&type=MARKET&quoteOrderQty=${sizeUSD.toFixed(2)}&recvWindow=10000&timestamp=${timestamp}`;
  const signature = crypto.createHmac("sha256", CONFIG.binance.secretKey).update(queryString).digest("hex");
  const url = `${CONFIG.binance.baseUrl}/api/v3/order?${queryString}&signature=${signature}`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "X-MBX-APIKEY": CONFIG.binance.apiKey,
    },
  });

  const data = await res.json();
  if (data.code && data.code < 0) {
    throw new Error(`Binance order failed: [${data.code}] ${data.msg}`);
  }

  return { orderId: String(data.orderId), executedQty: data.executedQty, status: data.status };
}

// ─── Price Precision Helper ───────────────────────────────────────────────────

function roundToTickSize(price) {
  if (price >= 10000) return parseFloat(price.toFixed(1));
  if (price >= 1000)  return parseFloat(price.toFixed(2));
  if (price >= 1)     return parseFloat(price.toFixed(4));
  if (price >= 0.1)   return parseFloat(price.toFixed(5));
  if (price >= 0.01)  return parseFloat(price.toFixed(6));
  return parseFloat(price.toFixed(7));
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

  const tpPrice  = roundToTickSize(takeProfitPrice);
  const spPrice  = roundToTickSize(stopPrice);
  // stopLimitPrice 0.5% below stop to guarantee fill even in fast markets
  const slpPrice = roundToTickSize(stopPrice * 0.995);

  const queryString = [
    `symbol=${symbol}`,
    `side=SELL`,
    `quantity=${quantity}`,
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
  // Find which order was filled to determine TP vs SL
  const filledOrder = filled && data.orders?.find(o => o.status === "FILLED");
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
  // Use exact quantity string to respect LOT_SIZE precision
  const qtyStr = String(quantity);
  const queryString = `symbol=${symbol}&side=SELL&type=MARKET&quantity=${qtyStr}&recvWindow=10000&timestamp=${timestamp}`;
  const signature = crypto.createHmac("sha256", CONFIG.binance.secretKey).update(queryString).digest("hex");
  const url = `${CONFIG.binance.baseUrl}/api/v3/order?${queryString}&signature=${signature}`;
  const res = await fetch(url, { method: "POST", headers: { "X-MBX-APIKEY": CONFIG.binance.apiKey } });
  const data = await res.json();
  if (data.code && data.code < 0) throw new Error(`Binance SELL failed: [${data.code}] ${data.msg}`);
  return { orderId: String(data.orderId), executedQty: data.executedQty, cummulativeQuoteQty: data.cummulativeQuoteQty };
}

// ─── Position Monitor ─────────────────────────────────────────────────────────

async function monitorPositions() {
  const positions = loadPositions();
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
            // Determina qual ordem foi executada (TP ou SL) pelo preço
            const candles = await fetchCandles(pos.symbol, pos.timeframe, 5);
            const price = candles[candles.length - 1].close;
            const wasTP = price >= pos.takeProfitPrice * 0.99;
            const exitReason = wasTP ? `TAKE PROFIT via OCO @ $${price}` : `STOP LOSS via OCO @ $${price}`;
            const pnl = parseFloat(((price - pos.entryPrice) * pos.quantity).toFixed(4));
            Object.assign(pos, { status: "closed", closedAt: new Date().toISOString(), exitPrice: price, exitReason, pnl });
            console.log(`✅ [${pos.symbol}] OCO EXECUTADA: ${exitReason} | PnL: $${pnl}`);
            sendWhatsApp(`🔴 VENDA ${pos.symbol} ${pos.timeframe}\nMotivo: ${exitReason}\nEntrada: $${pos.entryPrice} → Saída: $${price}\nPnL: $${pnl}`);
          } else {
            const candles = await fetchCandles(pos.symbol, pos.timeframe, 5);
            const price = candles[candles.length - 1].close;
            const pnlUnrealized = ((price - pos.entryPrice) * pos.quantity).toFixed(4);
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
        const pnlUnrealized = ((price - pos.entryPrice) * pos.quantity).toFixed(4);
        const pct = (((price - pos.entryPrice) / pos.entryPrice) * 100).toFixed(2);
        console.log(`  🔗 [${pos.symbol}] OCO manual ativa | Preço: $${price} | PnL: $${pnlUnrealized} (${pct}%) | Stop: $${pos.stopPrice} | TP: $${pos.takeProfitPrice}`);
        continue;
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
            Object.assign(pos, { status: "closed", closedAt: new Date().toISOString(), exitPrice: price, exitReason, exitOrderId: sellOrder.orderId, pnl: parseFloat(pnl) });
            console.log(`✅ [${pos.symbol}] VENDIDO @ $${price} | PnL: $${pnl}`);
            sendWhatsApp(`🔴 [LIVE] VENDA ${pos.symbol} ${pos.timeframe}\nMotivo: ${exitReason}\nEntrada: $${pos.entryPrice} → Saída: $${price}\nPnL: $${pnl}\nOrderId: ${sellOrder.orderId}`);
          } catch (err) {
            console.log(`❌ [${pos.symbol}] VENDA FALHOU: ${err.message}`);
          }
        } else {
          const pnl = ((price - pos.entryPrice) * pos.quantity).toFixed(4);
          Object.assign(pos, { status: "closed", closedAt: new Date().toISOString(), exitPrice: price, exitReason, exitOrderId: `PAPER-SELL-${Date.now()}`, pnl: parseFloat(pnl) });
          console.log(`📋 [${pos.symbol}] PAPER SELL @ $${price} | PnL: $${pnl}`);
          sendWhatsApp(`🔴 [PAPER] VENDA ${pos.symbol} ${pos.timeframe}\nMotivo: ${exitReason}\nEntrada: $${pos.entryPrice} → Saída: $${price}\nPnL: $${pnl}`);
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

  savePositions(positions);
}

// ─── Tax CSV Logging ─────────────────────────────────────────────────────────

const CSV_FILE = "trades.csv";

// Always ensure trades.csv exists with headers — open it in Excel/Sheets any time
function initCsv() {
  if (!existsSync(CSV_FILE)) {
    const funnyNote = `,,,,,,,,,,,"NOTE","Hey, if you're at this stage of the video, you must be enjoying it... perhaps you could hit subscribe now? :)"`;
    writeFileSync(CSV_FILE, CSV_HEADERS + "\n" + funnyNote + "\n");
    console.log(
      `📄 Created ${CSV_FILE} — open in Google Sheets or Excel to track trades.`,
    );
  }
}
const CSV_HEADERS = [
  "Date",
  "Time (UTC)",
  "Exchange",
  "Symbol",
  "Side",
  "Quantity",
  "Price",
  "Total USD",
  "Fee (est.)",
  "Net Amount",
  "Order ID",
  "Mode",
  "Notes",
].join(",");

function writeTradeCsv(logEntry) {
  const now = new Date(logEntry.timestamp);
  const date = now.toISOString().slice(0, 10);
  const time = now.toISOString().slice(11, 19);

  let side = "";
  let quantity = "";
  let totalUSD = "";
  let fee = "";
  let netAmount = "";
  let orderId = "";
  let mode = "";
  let notes = "";

  if (!logEntry.allPass) {
    const failed = logEntry.conditions
      .filter((c) => !c.pass)
      .map((c) => c.label)
      .join("; ");
    mode = "BLOCKED";
    orderId = "BLOCKED";
    notes = `Failed: ${failed}`;
  } else if (logEntry.paperTrading) {
    side = "BUY";
    quantity = (logEntry.tradeSize / logEntry.price).toFixed(6);
    totalUSD = logEntry.tradeSize.toFixed(2);
    fee = (logEntry.tradeSize * 0.001).toFixed(4);
    netAmount = (logEntry.tradeSize - parseFloat(fee)).toFixed(2);
    orderId = logEntry.orderId || "";
    mode = "PAPER";
    notes = "All conditions met";
  } else {
    side = "BUY";
    quantity = (logEntry.tradeSize / logEntry.price).toFixed(6);
    totalUSD = logEntry.tradeSize.toFixed(2);
    fee = (logEntry.tradeSize * 0.001).toFixed(4);
    netAmount = (logEntry.tradeSize - parseFloat(fee)).toFixed(2);
    orderId = logEntry.orderId || "";
    mode = "LIVE";
    notes = logEntry.error ? `Error: ${logEntry.error}` : "All conditions met";
  }

  const row = [
    date,
    time,
    "BitGet",
    logEntry.symbol,
    side,
    quantity,
    logEntry.price.toFixed(2),
    totalUSD,
    fee,
    netAmount,
    orderId,
    mode,
    `"${notes}"`,
  ].join(",");

  if (!existsSync(CSV_FILE)) {
    writeFileSync(CSV_FILE, CSV_HEADERS + "\n");
  }

  appendFileSync(CSV_FILE, row + "\n");
  console.log(`Tax record saved → ${CSV_FILE}`);
}

// Tax summary command: node bot.js --tax-summary
function generateTaxSummary() {
  if (!existsSync(CSV_FILE)) {
    console.log("No trades.csv found — no trades have been recorded yet.");
    return;
  }

  const lines = readFileSync(CSV_FILE, "utf8").trim().split("\n");
  const rows = lines.slice(1).map((l) => l.split(","));

  const live = rows.filter((r) => r[11] === "LIVE");
  const paper = rows.filter((r) => r[11] === "PAPER");
  const blocked = rows.filter((r) => r[11] === "BLOCKED");

  const totalVolume = live.reduce((sum, r) => sum + parseFloat(r[7] || 0), 0);
  const totalFees = live.reduce((sum, r) => sum + parseFloat(r[8] || 0), 0);

  console.log("\n── Tax Summary ──────────────────────────────────────────\n");
  console.log(`  Total decisions logged : ${rows.length}`);
  console.log(`  Live trades executed   : ${live.length}`);
  console.log(`  Paper trades           : ${paper.length}`);
  console.log(`  Blocked by safety check: ${blocked.length}`);
  console.log(`  Total volume (USD)     : $${totalVolume.toFixed(2)}`);
  console.log(`  Total fees paid (est.) : $${totalFees.toFixed(4)}`);
  console.log(`\n  Full record: ${CSV_FILE}`);
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
  if (plan && plan.timeframes && !plan.timeframes.includes(timeframe)) {
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

  const candles = await fetchCandles(localConfig.symbol, localConfig.timeframe, 500);
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
  if (allPass) {
    const openSame = loadPositions().find(p => p.symbol === symbol && p.status === "open");
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

  // Trailing Stop
  let trailingRate = null;
  if (allPass && rules.exit_rules_config?.trailing_stop?.enabled) {
    if (atr) {
      const multiplier = rules.exit_rules_config.trailing_stop.multiplier || 2.0;
      trailingRate = ((atr * multiplier) / price).toFixed(4);
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
    conditions: originalResults, // sempre usa resultados reais (sem override de force)
    allPass,
    forced: forcedOverride,
    tradeSize,
    orderPlaced: false,
    orderId: null,
    paperTrading: localConfig.paperTrading,
    strategy: usedStrategy,
    plan: plan?.name || null,
  };

  if (allPass) {
    const orderSide = side === "LONG" ? "buy" : "sell";
    if (localConfig.paperTrading) {
      logEntry.orderPlaced = true;
      logEntry.orderId = `PAPER-${Date.now()}`;
      console.log(`✅ [${symbol}] PASS — Paper Order: ${logEntry.orderId}`);
      const execQty = tradeSize / price;
      addPosition(symbol, timeframe, price, execQty, stopPrice, takeProfitPrice, logEntry.orderId, null, usedStrategy, results, activeIndicators, plan?.name);
      sendWhatsApp(`🟢 [PAPER] COMPRA ${symbol} ${timeframe}\nPreço: $${price}\nQtd: ${execQty.toFixed(6)}\nSL: $${stopPrice?.toFixed(6) || '-'} | TP: $${takeProfitPrice?.toFixed(6) || '-'}\nEstratégia: ${usedStrategy}${plan?.name ? ' / ' + plan.name : ''}`);
    } else {
      try {
        const order = await placeBinanceOrder(symbol, orderSide, tradeSize, price);
        logEntry.orderPlaced = true;
        logEntry.orderId = order.orderId;
        console.log(`🚀 [${symbol}] LIVE ORDER EXECUTED on Binance: ${order.orderId}`);
        const execQtyNum = parseFloat(order.executedQty) || (tradeSize / price);
        // Preserva a precisão LOT_SIZE retornada pela Binance (ex: "90.49000000") — não re-parsear.
        const execQtyStr = (order.executedQty && parseFloat(order.executedQty) > 0) ? String(order.executedQty) : String(execQtyNum);

        // ── OCO: coloca Take Profit + Stop Loss na Binance automaticamente (com 3 retries) ──
        let ocoOrderListId = null;
        if (stopPrice && takeProfitPrice && execQtyNum > 0) {
          const delays = [500, 2000, 5000];
          for (let attempt = 0; attempt < delays.length; attempt++) {
            try {
              await sleep(delays[attempt]);
              const ocoResult = await placeOCOOrder(symbol, execQtyStr, takeProfitPrice, stopPrice);
              ocoOrderListId = ocoResult.orderListId;
              logEntry.ocoOrderListId = ocoOrderListId;
              console.log(`🎯 [${symbol}] OCO COLOCADA (tentativa ${attempt+1}): TP $${roundToTickSize(takeProfitPrice)} | Stop $${roundToTickSize(stopPrice)} | ListId: ${ocoOrderListId}`);
              break;
            } catch (ocoErr) {
              const last = attempt === delays.length - 1;
              console.log(`${last ? '❌' : '⚠'} [${symbol}] OCO tentativa ${attempt+1}/${delays.length} falhou: ${ocoErr.message}${last ? ' — POSIÇÃO SEM PROTEÇÃO AUTOMÁTICA' : ' — retry em ' + (delays[attempt+1]/1000) + 's'}`);
              if (last) logEntry.ocoError = ocoErr.message;
            }
          }
        }

        addPosition(symbol, timeframe, price, execQtyNum, stopPrice, takeProfitPrice, order.orderId, ocoOrderListId, usedStrategy, results, activeIndicators, plan?.name);
        sendWhatsApp(`🟢 [LIVE] COMPRA ${symbol} ${timeframe}\nPreço: $${price}\nQtd: ${execQtyNum.toFixed(6)}\nSL: $${stopPrice?.toFixed(6) || '-'} | TP: $${takeProfitPrice?.toFixed(6) || '-'}\nOrderId: ${order.orderId}${ocoOrderListId ? ' | OCO #' + ocoOrderListId : ' | SEM OCO'}\nEstratégia: ${usedStrategy}${plan?.name ? ' / ' + plan.name : ''}`);
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
  
  if (!CONFIG.paperTrading) {
    await checkBinancePermissions();
  }
  initCsv();
  if (isMaster && typeof syncBrain === 'function') await syncBrain();

  console.log("\n" + "═".repeat(60));
  console.log(`  🤖 ${isMaster ? "MASTERBOT" : "MANUAL"} CYCLE START: ${new Date().toLocaleString()}`);
  console.log(`  Trade Mode: ${CONFIG.paperTrading ? "📋 PAPER" : "🔴 LIVE"}`);
  console.log("═".repeat(60));

  if (isMaster) writeMasterStatus("running", []);

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
  let currentRules = JSON.parse(readFileSync("rules.json", "utf8"));
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
    if (isMaster) writeMasterStatus("waiting", summary);
    return;
  }

  for (const symbolEntry of entries) {
    // If master, we re-load rules to respect UI changes INSTANTLY
    let watchlistToUse = [];
    if (isMaster) {
      const refreshedRules = JSON.parse(readFileSync("rules.json", "utf8"));
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
       // Loop through the actual current watchlist
       for (const symbol of targetSymbols) {
         for (const tf of timeframes) {
           const result = await runSymbolCycle(symbol, tf, currentRules);
           if (result) {
             summary.push(result);
             const log = loadLog(); log.trades.push(result); saveLog(log); writeTradeCsv(result);
           }
         }
         if (isMaster) {
           console.log(`⏳ Aguardando 5s antes do próximo ativo...`);
           await sleep(5000);
         }
       }
       break; // Exit the "DYNAMIC" wrapper
    } else {
       // Manual mode logic
       const symbol = isMaster ? symbolEntry : symbolEntry;
       for (const tf of timeframes) {
          const result = await runSymbolCycle(symbol, tf, currentRules);
          if (result) {
            summary.push(result);
            const log = loadLog(); log.trades.push(result); saveLog(log); writeTradeCsv(result);
          }
       }
    }
  }

  if (isMaster) {
    // ... logic for obsidian ...
    writeMasterStatus("waiting", summary);
    
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
    startScheduler();
  } else if (process.env.FORCE_ONCE === '1') {
    // Force trade: executa apenas o símbolo/TF forçado e sai
    const forceSym = process.env.FORCE_SYMBOL;
    const forceTf  = process.env.FORCE_TF;
    const forceRules = JSON.parse(readFileSync("rules.json", "utf8"));
    console.log(`\n⚡ FORCE TRADE MODE: ${forceSym} ${forceTf} ${process.env.FORCE_SIDE}`);
    runSymbolCycle(forceSym, forceTf, forceRules).then(result => {
      if (result) {
        const log = loadLog(); log.trades.push(result); saveLog(log); writeTradeCsv(result);
      }
      process.exit(0);
    }).catch(err => { console.error("Force trade error:", err); process.exit(1); });
  } else {
    run(false).catch((err) => {
      console.error("Bot error:", err);
      process.exit(1);
    });
  }
}


function writeMasterStatus(status = "running", results = []) {
  const statusFile = join(__dirname, "master-status.json");
  const now = Date.now();
  const rules = JSON.parse(readFileSync("rules.json", "utf8"));
  const intervalStr = process.env.MASTERBOT_LOOP_INTERVAL || "4h";
  const intervalMs = parseIntervalMs(intervalStr);

  const state = {
    status: status,
    lastRun: new Date().toISOString(),
    nextRun: status === "waiting" ? new Date(now + intervalMs).toISOString() : new Date().toISOString(),
    interval: intervalStr,
    watchlist: rules.watchlist || [],
    timeframes: rules.timeframes || [],
    obsidianOnline: !!process.env.OBSIDIAN_PATH && existsSync(process.env.OBSIDIAN_PATH),
    openPositions: existsSync(POSITIONS_FILE)
      ? JSON.parse(readFileSync(POSITIONS_FILE, "utf8")).filter(p => p.status === "open").length
      : 0,
    lastResults: results.map(r => ({
      symbol: r.symbol,
      timeframe: r.timeframe,
      allPass: r.allPass,
      side: r.side,
      signal: r.allPass ? (r.side || 'NEUTRO') : 'NEUTRO',
      price: r.price || null,
      change_pct: r.price && r.indicators?.vwap
        ? parseFloat((((r.price - r.indicators.vwap) / r.indicators.vwap) * 100).toFixed(2))
        : null,
      strategy: r.strategy || null,
    }))
  };
  writeFileSync(statusFile, JSON.stringify(state, null, 2));
}
