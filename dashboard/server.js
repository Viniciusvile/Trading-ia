/**
 * TradingView Dashboard Server — localhost:3333
 */
import express from 'express';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { spawn, execSync } from 'node:child_process';
import crypto from 'node:crypto';
import * as health from '../src/core/health.js';
import * as chart from '../src/core/chart.js';
import * as data from '../src/core/data.js';
import * as capture from '../src/core/capture.js';
import * as alerts from '../src/core/alerts.js';
import * as replay from '../src/core/replay.js';
import * as watchlist from '../src/core/watchlist.js';
import { createBinanceClient } from '../src/exchange/binance.js';
import dotenv from 'dotenv';
import * as pine from '../src/core/pine.js';
import { evaluate } from '../src/connection.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const SCREENSHOTS_DIR = join(ROOT, 'screenshots');
const JOURNAL_FILE = join(__dirname, 'journal.json');

dotenv.config({ path: join(ROOT, '.env') });

const app = express();
app.use(express.json());
// No Vercel, o static pode ser resolvido pelo vercel.json, 
// mas mantemos aqui para compatibilidade local.
app.use(express.static(__dirname));

// ── helpers ──────────────────────────────────────────────────────
function getRules() {
  try { return JSON.parse(readFileSync(join(ROOT, 'rules.json'), 'utf8')); } catch { return {}; }
}
function loadJournal() {
  if (!existsSync(JOURNAL_FILE)) return [];
  try { return JSON.parse(readFileSync(JOURNAL_FILE, 'utf8')); } catch { return []; }
}
function saveJournal(entries) {
  writeFileSync(JOURNAL_FILE, JSON.stringify(entries, null, 2));
}

let lastScreenshotPath = null;
const MOCK_MODE = true; // Forçado para Vercel/Demo 

const MOCK_DATA = {
  quote: { success: true, symbol: 'BTCUSDT', last: 98450.25, open: 97100.00, high: 99200.50, low: 96800.20, close: 98450.25, volume: 12500, exchange: 'BINANCE' },
  indicators: { success: true, studies: [{ name: 'Trend Master', values: { 'VWAP': '97850.10', 'EMA 9': '98100.45', 'EMA 20': '97900.20', 'EMA 200': '95000.00', 'LONG': '1' } }] },
  strategy: { success: true, summary: { net_profit: 4520.15, win_rate: 68.5, total_trades: 142, max_drawdown: 4.2 } },
  trades: { success: true, trades: [
    { direction: 'long', entry_price: 97100, exit_price: 98450, profit: 1350, profit_pct: 1.39 },
    { direction: 'short', entry_price: 99100, exit_price: 98500, profit: 600, profit_pct: 0.61 }
  ]},
  alerts: { success: true, alerts: [{ condition: 'crossing', price: 100000, message: 'Psychological level' }] }
};

// ── HEALTH ───────────────────────────────────────────────────────
app.get('/api/health', async (req, res) => {
  try { res.json(await health.healthCheck()); }
  catch (e) { 
    if (MOCK_MODE || process.env.VERCEL) res.json({ success: true, cdp_connected: true, chart_symbol: 'BTCUSDT', chart_resolution: '240', is_mock: true });
    else res.status(500).json({ success: false, error: e.message }); 
  }
});

// ── MICRO-SCALPER LIVE SIGNAL ────────────────────────────────────
app.get('/api/micro-scalper/signal', async (req, res) => {
  try {
    const cfg = getRules().micro_scalper;
    if (!cfg) return res.status(404).json({ success: false, error: 'Config micro_scalper missing' });
    const strategyMode = cfg.strategy_mode || "micro-dip";

    const { createBinanceClient } = await import('../src/exchange/binance.js');
    const client = createBinanceClient({
      apiKey: process.env.BINANCE_API_KEY,
      secretKey: process.env.BINANCE_SECRET_KEY
    });
    
    let candles;
    try {
      // Pega os candles direto da Binance API (independente do que está na tela)
      candles = await client.getKlines(cfg.symbol || 'XRPUSDT', cfg.candles_interval || '5m', cfg.candles_limit || 50);
    } catch (e) {
      if (MOCK_MODE) {
        candles = Array.from({length:50}, (_,i)=>({ close: 1.40 + Math.random()*0.05, high: 1.45, low: 1.39, volume: 100000 }));
      } else throw e;
    }

    const { wv5gSignal, microScalpSignal, turboReversionSignal } = await import('../src/scalper/signals.js');
    let sig;
    const bars = Array.isArray(candles) ? candles : (candles.bars || []);

    if (strategyMode === "wv5g-aggr") {
      sig = wv5gSignal(bars, { rsiLow: cfg.min_rsi || 30, rsiHigh: cfg.max_rsi || 85, emaFast: cfg.ema_fast || 9, emaSlow: cfg.ema_slow || 20 });
    } else if (strategyMode === "turbo-reversion") {
      sig = turboReversionSignal(bars, { bbLen: cfg.bb_length, bbMult: cfg.bb_mult, rsiLen: cfg.rsi_period, rsiLimit: cfg.rsi_limit, volMult: cfg.vol_mult });
    } else {
      sig = microScalpSignal(bars, { emaPeriod: cfg.ema_period, rsiPeriod: cfg.rsi_period, minDip: cfg.min_dip_pct, minRsi: cfg.min_rsi, maxRsi: cfg.max_rsi });
    }
    
    res.json({ 
      success: true, 
      symbol: cfg.symbol, 
      mode: strategyMode, 
      signal: sig,
      source: 'BINANCE_API (Background)' 
    });
  } catch (e) {
    console.error('❌ [API] Signal Error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

app.patch('/api/micro-scalper/config', (req, res) => {
  try {
    const mainRules = JSON.parse(readFileSync(join(ROOT, 'rules.json'), 'utf8'));
    if (!mainRules.micro_scalper) mainRules.micro_scalper = {};
    const { strategy_mode, symbol, trade_size_pct } = req.body;
    if (strategy_mode) mainRules.micro_scalper.strategy_mode = strategy_mode;
    if (symbol) { mainRules.micro_scalper.symbol = symbol; mainRules.micro_scalper.tv_symbol = 'BINANCE:' + symbol; }
    if (trade_size_pct) mainRules.micro_scalper.trade_size_pct = trade_size_pct;
    writeFileSync(join(ROOT, 'rules.json'), JSON.stringify(mainRules, null, 2));
    res.json({ success: true, config: mainRules.micro_scalper });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/micro-scalper/trade', async (req, res) => {
  console.log('🚀 [API] Rapid Trade Execution requested');
  try {
    const rules = getRules().micro_scalper;
    if (!rules) throw new Error('Config micro_scalper missing');
    
    const client = createBinanceClient({
      apiKey: process.env.BINANCE_API_KEY,
      secretKey: process.env.BINANCE_SECRET_KEY,
    });

    await client.syncTime();

    const symbol = rules.symbol || 'BTCUSDT';
    const side = req.body.side?.toUpperCase() || 'BUY';
    
    let result;
    if (side === 'BUY') {
      const tradeUsdt = req.body.amount || Math.min(Math.max(balances.usdt * (rules.trade_size_pct || 0.1), rules.min_trade_usdt || 5), rules.max_trade_usdt || 10);
      
      console.log(`🛒 Buying ${symbol} with ${tradeUsdt} USDT...`);
      result = await client.placeMarketBuyQuote(symbol, tradeUsdt.toFixed(2));
    } else {
      const baseAsset = symbol.replace('USDT', '');
      const price = await client.getPrice(symbol);
      const tradeUsdt = req.body.amount || 10;
      
      // Calcula a quantidade com base no valor em USDT desejado
      const qty = tradeUsdt / price;
      
      // Formata a quantidade conforme os decimais configurados (XRP Spot = 0)
      const decimals = parseInt(rules.qty_decimals ?? 0);
      const f = Math.pow(10, decimals);
      const fmtQty = (Math.floor(qty * f) / f).toFixed(decimals);
      
      if (parseFloat(fmtQty) <= 0) throw new Error(`Valor de ${tradeUsdt} USDT é muito baixo para gerar uma quantidade mínima de ${baseAsset}.`);
      
      console.log(`💰 Selling ${fmtQty} ${baseAsset} (approx ${tradeUsdt} USDT at price ${price})...`);
      result = await client.placeMarketSellQty(symbol, fmtQty);
    }

    if (result.ok) {
      res.json({ success: true, data: result.data });
    } else {
      res.status(400).json({ success: false, error: result.data?.msg || 'Binance error' });
    }
  } catch (e) {
    console.error('❌ [API] Rapid Trade Error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/api/micro-scalper/sync-symbol', async (req, res) => {
  try {
    const rules = getRules().micro_scalper;
    if (!rules || !rules.tv_symbol) throw new Error('Config tv_symbol missing in rules.json');
    console.log(`📺 Syncing TradingView to ${rules.tv_symbol}...`);
    await chart.setSymbol({ symbol: rules.tv_symbol });
    res.json({ success: true, symbol: rules.tv_symbol });
  } catch (e) {
    console.error('❌ [API] Sync Error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── CHART STATE ──────────────────────────────────────────────────
app.get('/api/state', async (_req, res) => {
  try { res.json({ success: true, ...(await chart.getState()) }); }
  catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── QUOTE ────────────────────────────────────────────────────────
app.get('/api/quote', async (req, res) => {
  try { res.json(await data.getQuote({})); }
  catch (e) { 
    if (MOCK_MODE || process.env.VERCEL) res.json(MOCK_DATA.quote);
    else res.status(500).json({ success: false, error: e.message }); 
  }
});

// ── INDICATORS ───────────────────────────────────────────────────
app.get('/api/indicators', async (req, res) => {
  try { res.json(await data.getStudyValues()); }
  catch (e) { 
    if (MOCK_MODE || process.env.VERCEL) res.json(MOCK_DATA.indicators);
    else res.status(500).json({ success: false, error: e.message }); 
  }
});

// ── OHLCV ────────────────────────────────────────────────────────
app.get('/api/ohlcv', async (_req, res) => {
  try { res.json(await data.getOhlcv({ summary: true, count: 20 })); }
  catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── SYMBOL ───────────────────────────────────────────────────────
app.post('/api/symbol', async (req, res) => {
  try {
    const { symbol } = req.body;
    if (!symbol) return res.status(400).json({ success: false, error: 'symbol required' });
    res.json(await chart.setSymbol({ symbol }));
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── TIMEFRAME ────────────────────────────────────────────────────
app.post('/api/timeframe', async (req, res) => {
  try {
    const { timeframe } = req.body;
    if (!timeframe) return res.status(400).json({ success: false, error: 'timeframe required' });
    res.json(await chart.setTimeframe({ timeframe }));
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── CHART GOTO TRADE ─────────────────────────────────────────────
app.post('/api/chart/goto', async (req, res) => {
  try {
    const { symbol, timeframe, date } = req.body;
    if (!symbol || !timeframe || !date) return res.status(400).json({ success: false, error: 'symbol, timeframe, date required' });
    const tvSymbol = symbol.includes(':') ? symbol : `BINANCE:${symbol}`;
    const tfMap = { '1m':'1','3m':'3','5m':'5','15m':'15','30m':'30','1h':'60','1H':'60','2h':'120','4h':'240','4H':'240','1d':'D','1D':'D','1w':'W','1W':'W' };
    const tvTf = tfMap[timeframe] || timeframe.replace(/m$/,'').replace(/[hH]$/, v => String(parseInt(v)*60)).replace(/[dD]$/,'D');
    await chart.setSymbol({ symbol: tvSymbol });
    await new Promise(r => setTimeout(r, 1500));
    await chart.setTimeframe({ timeframe: tvTf });
    await new Promise(r => setTimeout(r, 1500));
    await chart.scrollToDate({ date });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── SYMBOL SEARCH ────────────────────────────────────────────────
app.get('/api/symbol-search', async (req, res) => {
  try {
    const { q } = req.query;
    if (!q) return res.json({ success: true, results: [] });
    res.json(await chart.symbolSearch({ query: q }));
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── SCREENSHOT ───────────────────────────────────────────────────
app.post('/api/screenshot', async (req, res) => {
  try {
    const { region = 'chart' } = req.body || {};
    const result = await capture.captureScreenshot({ region });
    if (result.success && result.file_path) lastScreenshotPath = result.file_path;
    res.json(result);
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get('/api/screenshot-image', (_req, res) => {
  if (!lastScreenshotPath) return res.status(404).json({ error: 'Nenhum screenshot disponível' });
  res.sendFile(lastScreenshotPath);
});

app.get('/api/screenshots/list', (_req, res) => {
  try {
    mkdirSync(SCREENSHOTS_DIR, { recursive: true });
    const files = readdirSync(SCREENSHOTS_DIR)
      .filter(f => f.endsWith('.png'))
      .map(f => ({ name: f, path: join(SCREENSHOTS_DIR, f), url: `/api/screenshots/file/${f}` }))
      .reverse().slice(0, 30);
    res.json({ success: true, files });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get('/api/screenshots/file/:name', (req, res) => {
  const filePath = join(SCREENSHOTS_DIR, req.params.name);
  if (!existsSync(filePath)) return res.status(404).send('Not found');
  res.sendFile(filePath);
});

// ── MORNING BRIEF ────────────────────────────────────────────────
app.get('/api/brief', async (_req, res) => {
  try {
    const state = await chart.getState();
    const [indicators, quote] = await Promise.all([data.getStudyValues(), data.getQuote({})]);
    const rules = getRules();
    res.json({
      success: true,
      generated_at: new Date().toISOString(),
      rules: { bias_criteria: rules.bias_criteria || null, risk_rules: rules.risk_rules || null },
      symbols_scanned: [{ symbol: state.symbol, timeframe: state.resolution, state, indicators, quote }],
    });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── ALERTS ───────────────────────────────────────────────────────
app.get('/api/alerts', async (req, res) => {
  try { res.json(await alerts.list()); }
  catch (e) { 
    if (MOCK_MODE || process.env.VERCEL) res.json(MOCK_DATA.alerts);
    else res.status(500).json({ success: false, error: e.message }); 
  }
});

app.post('/api/alerts', async (req, res) => {
  try {
    const { condition, price, message } = req.body;
    res.json(await alerts.create({ condition, price, message }));
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.delete('/api/alerts', async (_req, res) => {
  try { res.json(await alerts.deleteAlerts({ delete_all: true })); }
  catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── STRATEGY TESTER ──────────────────────────────────────────────
app.get('/api/strategy', async (req, res) => {
  try { res.json(await data.getStrategyResults()); }
  catch (e) { 
    if (MOCK_MODE || process.env.VERCEL) res.json(MOCK_DATA.strategy);
    else res.status(500).json({ success: false, error: e.message }); 
  }
});

app.get('/api/strategy/trades', async (req, res) => {
  try { res.json(await data.getTrades({ max_trades: 50 })); }
  catch (e) { 
    if (MOCK_MODE || process.env.VERCEL) res.json(MOCK_DATA.trades);
    else res.status(500).json({ success: false, error: e.message }); 
  }
});

app.get('/api/strategy/equity', async (_req, res) => {
  try { res.json(await data.getEquity()); }
  catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── SCANNER ──────────────────────────────────────────────────────
// Read the last two bars from TradingView chart using silent: true to suppress
// TradingView's internal promise rejections from polluting CDP exceptionDetails.
const BARS_EXPR = `window.TradingViewApi._activeChartWidgetWV.value()._chartWidget.model().mainSeries().bars()`;
async function readBarsSilent() {
  const result = await evaluate(`
    (function() {
      var bars = ${BARS_EXPR};
      if (!bars || typeof bars.lastIndex !== 'function') return null;
      var end = bars.lastIndex();
      var cur = bars.valueAt(end);
      var prev = bars.valueAt(Math.max(bars.firstIndex(), end - 1));
      if (!cur) return null;
      return {
        close:  cur[4],  open:  cur[1],  high:  cur[2],  low:  cur[3],  volume: cur[5] || 0,
        pOpen:  prev ? prev[1] : cur[1]
      };
    })()
  `, { silent: true });
  if (!result || !result.close) throw new Error('sem dados de barra');
  return result;
}

app.post('/api/scanner', async (req, res) => {
  try {
    const { symbols = ['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT'] } = req.body || {};
    const results = [];
    for (const sym of symbols) {
      try {
        await chart.setSymbol({ symbol: sym });
        await new Promise(r => setTimeout(r, 2500)); // let chart settle
        // retry up to 4× with 600 ms gap if bars are not ready yet
        let bars = null;
        for (let i = 0; i < 4; i++) {
          try { bars = await readBarsSilent(); break; }
          catch { await new Promise(r => setTimeout(r, 600)); }
        }
        if (!bars) { results.push({ symbol: sym, error: 'timeout lendo barras' }); continue; }
        const open  = bars.pOpen;
        const price = bars.close;
        const change_pct = open ? ((price - open) / open * 100) : 0;
        results.push({ symbol: sym, price, open, high: bars.high, low: bars.low, close: price, volume: bars.volume, change_pct });
      } catch (e) {
        results.push({ symbol: sym, error: e.message.replace('JS evaluation error: ', '') });
      }
    }
    res.json({ success: true, results, total: results.length });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── WATCHLIST ────────────────────────────────────────────────────
app.get('/api/watchlist', async (_req, res) => {
  try { res.json(await watchlist.get()); }
  catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/watchlist/add', async (req, res) => {
  try {
    const { symbol } = req.body;
    res.json(await watchlist.add({ symbol }));
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── REPLAY ───────────────────────────────────────────────────────
app.post('/api/replay/start', async (req, res) => {
  try {
    const { date } = req.body || {};
    res.json(await replay.start({ date }));
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/replay/step', async (_req, res) => {
  try { res.json(await replay.step()); }
  catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/replay/autoplay', async (req, res) => {
  try {
    const { speed = 500 } = req.body || {};
    res.json(await replay.autoplay({ speed }));
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/replay/stop', async (_req, res) => {
  try { res.json(await replay.stop()); }
  catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get('/api/replay/status', async (_req, res) => {
  try { res.json(await replay.status()); }
  catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/replay/trade', async (req, res) => {
  try {
    const { action } = req.body;
    res.json(await replay.trade({ action }));
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── PINE EDITOR ──────────────────────────────────────────────────
app.get('/api/pine/source', async (_req, res) => {
  try { res.json(await pine.getSource()); }
  catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/pine/source', async (req, res) => {
  try {
    const { source } = req.body;
    res.json(await pine.setSource({ source }));
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/pine/compile', async (_req, res) => {
  try { res.json(await pine.smartCompile()); }
  catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get('/api/pine/errors', async (_req, res) => {
  try { res.json(await pine.getErrors()); }
  catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/pine/save', async (_req, res) => {
  try { res.json(await pine.save()); }
  catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get('/api/pine/list', async (_req, res) => {
  try { res.json(await pine.listScripts()); }
  catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/pine/open', async (req, res) => {
  try {
    const { name } = req.body;
    res.json(await pine.openScript({ name }));
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get('/api/pine/console', async (_req, res) => {
  try { res.json(await pine.getConsole()); }
  catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── JOURNAL ──────────────────────────────────────────────────────
app.get('/api/journal', (_req, res) => {
  res.json({ success: true, entries: loadJournal() });
});

app.post('/api/journal', async (req, res) => {
  try {
    const { note, type = 'note', symbol, price } = req.body;
    const entries = loadJournal();
    const entry = {
      id: Date.now(),
      timestamp: new Date().toISOString(),
      type,
      symbol: symbol || '',
      price: price || '',
      note: note || '',
    };
    entries.unshift(entry);
    saveJournal(entries.slice(0, 200));
    res.json({ success: true, entry });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.delete('/api/journal/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const entries = loadJournal().filter(e => e.id !== id);
    saveJournal(entries);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── STRATEGIES ───────────────────────────────────────────────────
const WARRIOR_SOURCE = `//@version=6
strategy("Ross Cameron — Warrior Trading", overlay=true, default_qty_type=strategy.percent_of_equity, default_qty_value=10)

// ── Inputs
emaFastLen  = input.int(9,   "EMA Rápida",  minval=1)
emaMidLen   = input.int(20,  "EMA Média",   minval=1)
emaSlowLen  = input.int(200, "EMA Lenta",   minval=1)
rsiLen      = input.int(14,  "RSI Length",  minval=2)
rsiLow      = input.int(40,  "RSI Min",     minval=1)
rsiHigh     = input.int(70,  "RSI Max",     minval=1)
volMult     = input.float(1.5,"Vol Mínimo (x avg)", minval=0.1, step=0.1)
rr          = input.float(2.0,"Risco/Retorno", minval=0.5, step=0.1)
atrLen      = input.int(14,  "ATR Length",  minval=1)
stopAtr     = input.float(1.5, "Stop (x ATR)", minval=0.1, step=0.1)
trailEnabled = input.bool(true, "Ativar Trailing Stop")
trailMult    = input.float(2.0, "Arraste (x ATR)", minval=0.1, step=0.1)

// ── Indicators
emaFast = ta.ema(close, emaFastLen)
emaMid  = ta.ema(close, emaMidLen)
emaSlow = ta.ema(close, emaSlowLen)
[vwapVal, _, _] = ta.vwap(hlc3, false, 1)
rsiVal  = ta.rsi(close, rsiLen)
atrVal  = ta.atr(atrLen)
volAvg  = ta.sma(volume, 20)

// ── Plots
plot(emaFast, "EMA 9",  color=color.new(color.yellow, 0), linewidth=1)
plot(emaMid,  "EMA 20", color=color.new(color.orange, 0), linewidth=1)
plot(emaSlow, "EMA 200",color=color.new(color.red,    0), linewidth=2)
plot(vwapVal, "VWAP",   color=color.new(color.blue,   0), linewidth=2)

// ── Conditions
aboveVwap   = close > vwapVal
trendUp     = emaFast > emaMid and emaMid > emaSlow
rsiOk       = rsiVal >= rsiLow and rsiVal <= rsiHigh
volumeOk    = volume >= volAvg * volMult
pullback    = low[1] < emaFast and close > emaFast
longEntry   = aboveVwap and trendUp and rsiOk and volumeOk and pullback

shortEntry  = not aboveVwap and emaFast < emaMid and emaMid < emaSlow and rsiVal < 60 and volume >= volAvg * volMult and high[1] > emaFast and close < emaFast

// ── Signals
plotshape(longEntry,  "Long",  shape.labelup,   location.belowbar, color.new(color.lime,  0), text="W↑", size=size.small)
plotshape(shortEntry, "Short", shape.labeldown, location.abovebar, color.new(color.red,   0), text="W↓", size=size.small)

// ── Strategy
if longEntry
    strategy.entry("Long", strategy.long)
    if trailEnabled
        strategy.exit("Long Exit", "Long", stop=stopPrice, limit=targetPrice, trail_points=close * 0.01 / syminfo.mintick, trail_offset=atrVal * trailMult / syminfo.mintick)
    else
        strategy.exit("Long Exit", "Long", stop=stopPrice, limit=targetPrice)

if shortEntry
    stopPrice   = close + atrVal * stopAtr
    targetPrice = close - (stopPrice - close) * rr
    strategy.entry("Short", strategy.short)
    strategy.exit("Short TP/SL", "Short", stop=stopPrice, limit=targetPrice)
`;

const STORMER_SOURCE = `//@version=6
strategy("123 Stormer — Alexandre Wolwacz", overlay=true, default_qty_type=strategy.percent_of_equity, default_qty_value=10)

// ── Inputs
emaFastLen = input.int(8,  "EMA Rápida", minval=1)
emaSlowLen = input.int(80, "EMA Lenta",  minval=1)
rr         = input.float(2.0, "Risco/Retorno", minval=0.5, step=0.1)
trailEnabled = input.bool(true, "Ativar Trailing Stop")
trailMult    = input.float(2.0, "Arraste (x ATR)", minval=0.1, step=0.1)
atrLen      = input.int(14, "ATR Length", minval=1)

// ── EMAs
emaFast = ta.ema(close, emaFastLen)
emaSlow = ta.ema(close, emaSlowLen)
atrVal  = ta.atr(atrLen)

plot(emaFast, "EMA 8",  color=color.new(color.yellow, 0), linewidth=1)
plot(emaSlow, "EMA 80", color=color.new(color.red,    0), linewidth=2)

// ── Trend filter
bullTrend = emaFast > emaSlow
bearTrend = emaFast < emaSlow

// ── 123 Pattern
// LONG: candle 1 é pivot de baixa (low[2] < low[1] e low[0] < low[1] é ERRADO)
// Padrão: low[1] é o menor dos 3 (low[2] > low[1] e low[0] > low[1])
pivot123Long  = low[2]  > low[1]  and low[0]  > low[1]  and bullTrend
pivot123Short = high[2] < high[1] and high[0] < high[1] and bearTrend

// Entrada: rompimento do candle 3 (candle atual fecha acima/abaixo da máx/mín do candle 1)
longSignal  = pivot123Long[1]  and close > high[1]
shortSignal = pivot123Short[1] and close < low[1]

plotshape(longSignal,  "123 Long",  shape.labelup,   location.belowbar, color.new(color.lime, 0), text="123↑", size=size.small)
plotshape(shortSignal, "123 Short", shape.labeldown, location.abovebar, color.new(color.red,  0), text="123↓", size=size.small)

// ── Strategy execution
    if trailEnabled
        strategy.exit("Long Exit", "Long", stop=stopLoss, limit=target, trail_points=close * 0.01 / syminfo.mintick, trail_offset=atrVal * trailMult / syminfo.mintick)
    else
        strategy.exit("Long Exit", "Long", stop=stopLoss, limit=target)

if shortSignal
    stopLoss   = high[2]
    target     = close - (stopLoss - close) * rr
    strategy.entry("Short", strategy.short)
    strategy.exit("Short Exit", "Short", stop=stopLoss, limit=target)
`;

const STRATEGIES = [
  {
    id: 'warrior',
    name: 'Ross Cameron — Warrior Trading',
    author: 'Ross Cameron',
    description: 'VWAP + EMA 9/20/200 + Volume Relativo + RSI. Momentum com filtro de tendência macro.',
    script_name: 'Ross Cameron — Warrior Trading',
    indicators: ['VWAP', 'EMA 9', 'EMA 20', 'EMA 200'],
    timeframes: ['1m', '5m', '15m'],
    style: 'Momentum',
    color: '#58a6ff',
    source: WARRIOR_SOURCE,
  },
  {
    id: 'stormer',
    name: '123 Stormer — Alexandre Wolwacz',
    author: 'Alexandre Wolwacz (Stormer)',
    description: 'Padrão de 3 candles com EMA 8/80. Entrada no rompimento do candle 3, stop no pivot, alvo 2:1.',
    script_name: '123 Stormer — Alexandre Wolwacz',
    indicators: ['EMA 8', 'EMA 80'],
    timeframes: ['15m', '60m', '4h', 'D'],
    style: 'Padrão de Candles',
    color: '#bc8cff',
    source: STORMER_SOURCE,
  },
];

app.get('/api/strategies', (_req, res) => {
  res.json({ success: true, strategies: STRATEGIES });
});

app.get('/api/strategies/current', async (_req, res) => {
  try {
    const state = await chart.getState();
    const studyNames = (state.studies || []).map(s => (s.name || '').toLowerCase());
    const matched = STRATEGIES.find(s =>
      studyNames.some(n => n.includes(s.script_name.toLowerCase()) || n.includes(s.id))
    );
    res.json({ success: true, current_id: matched?.id || null, studies: state.studies || [] });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/strategies/apply', async (req, res) => {
  try {
    const { id } = req.body;
    const strat = STRATEGIES.find(s => s.id === id);
    if (!strat) return res.status(404).json({ success: false, error: 'Estratégia não encontrada' });
    const injected = await pine.setSource({ source: strat.source });
    let compiled = null;
    try { compiled = await pine.smartCompile(); } catch (_) { /* ignora — usuário pode clicar manualmente */ }
    res.json({ success: injected.success, strategy: strat, injected, compiled });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── BOT (masterbot consolidado) ─────────────────────────
const BOT_DIR = join(ROOT, 'masterbot');
const BOT_LOG = join(ROOT, 'safety-check-log.json');
const BOT_ENV = join(ROOT, '.env');
const BOT_RULES = join(ROOT, 'rules.json');
const BOT_MASTER_STATUS = join(BOT_DIR, 'master-status.json');
const BOT_MASTER_PID = join(BOT_DIR, 'master.pid');

let masterProcess = null;

function parseEnv(txt) {
  const out = {};
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    let val = line.slice(idx + 1).trim();
    const hash = val.indexOf('#');
    if (hash >= 0) val = val.slice(0, hash).trim();
    out[key] = val;
  }
  return out;
}

app.get('/api/bot/config', (_req, res) => {
  try {
    if (!existsSync(BOT_DIR)) return res.status(404).json({ success: false, error: 'Pasta do bot não encontrada', dir: BOT_DIR });
    const env = existsSync(BOT_ENV) ? parseEnv(readFileSync(BOT_ENV, 'utf8')) : {};
    const rules = existsSync(BOT_RULES) ? JSON.parse(readFileSync(BOT_RULES, 'utf8')) : null;
    const hasRealKeys = (env.BINANCE_API_KEY && !/your_api_key_here|^$/.test(env.BINANCE_API_KEY)) ||
                        (env.BITGET_API_KEY && !/your_api_key_here|^$/.test(env.BITGET_API_KEY));
    res.json({
      success: true,
      dir: BOT_DIR,
      strategyKey: env.BOT_STRATEGY || rules?.strategy?.key || 'warrior',
      strategy: { stormer: '123 Stormer — Alexandre Wolwacz', warrior: 'Warrior Trading — Ross Cameron', both: 'Ambas (Warrior + Stormer)' }[env.BOT_STRATEGY || rules?.strategy?.key || 'warrior'] || 'Warrior Trading — Ross Cameron',
      symbol: env.SYMBOL || 'BTCUSDT',
      timeframe: env.TIMEFRAME || '4H',
      portfolio: Number(env.PORTFOLIO_VALUE_USD || 0),
      maxTrade: Number(env.MAX_TRADE_SIZE_USD || 0),
      maxPerDay: Number(env.MAX_TRADES_PER_DAY || 0),
      paperTrading: env.PAPER_TRADING !== 'false',
      hasRealKeys,
      rules,
      activePlan: rules?.active_plan || null,
      groupPlans: (rules?.group_plans || []).map(p => ({ name: p.name, description: p.description, symbols: p.symbols })),
      watchlist: rules?.watchlist || [],
      watchlistPreset: ['BTCUSDT','ETHUSDT','ENAUSDT','SOLUSDT','RENDERUSDT','PEPEUSDT','XRPUSDT','BONKUSDT'],
    });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── Update watchlist ──────────────────────────────────────────────
app.patch('/api/bot/watchlist', (req, res) => {
  try {
    if (!existsSync(BOT_RULES)) return res.status(404).json({ success: false, error: 'rules.json não encontrado' });
    const { watchlist } = req.body || {};
    if (!Array.isArray(watchlist)) return res.status(400).json({ success: false, error: 'watchlist deve ser um array' });
    const sanitized = watchlist
      .map(s => String(s).toUpperCase().trim())
      .filter(s => /^[A-Z0-9]{3,20}$/.test(s));
    if (sanitized.length === 0) return res.status(400).json({ success: false, error: 'Nenhum símbolo válido enviado' });
    const rules = JSON.parse(readFileSync(BOT_RULES, 'utf8'));
    rules.watchlist = sanitized;
    writeFileSync(BOT_RULES, JSON.stringify(rules, null, 2));
    res.json({ success: true, watchlist: sanitized });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.patch('/api/bot/config', (req, res) => {
  try {
    if (!existsSync(BOT_ENV)) return res.status(404).json({ success: false, error: '.env não encontrado' });
    const { symbol, timeframe, strategy, portfolio, maxTrade, trailingEnabled, trailingMult, paperTrading, activePlan } = req.body || {};
    
    // Validations
    const allowedTf = ['1m','5m','15m','30m','1H','4H','1D','1W'];
    const allowedStrat = ['stormer', 'warrior', 'both', 'auto'];
    if (symbol && !/^[A-Z0-9]{3,20}$/.test(symbol)) return res.status(400).json({ success: false, error: 'Símbolo inválido' });
    if (timeframe && !allowedTf.includes(timeframe)) return res.status(400).json({ success: false, error: 'Timeframe inválido' });
    if (strategy && !allowedStrat.includes(strategy)) return res.status(400).json({ success: false, error: 'Estratégia inválida' });

    // Update .env
    let txt = readFileSync(BOT_ENV, 'utf8');
    const upsert = (key, val) => {
      const re = new RegExp(`^${key}=.*$`, 'm');
      if (re.test(txt)) txt = txt.replace(re, `${key}=${val}`);
      else txt += (txt.endsWith('\n') ? '' : '\n') + `${key}=${val}\n`;
    };
    if (symbol) upsert('SYMBOL', symbol);
    if (timeframe) upsert('TIMEFRAME', timeframe);
    if (strategy) upsert('BOT_STRATEGY', strategy);
    if (portfolio !== undefined) upsert('PORTFOLIO_VALUE_USD', portfolio);
    if (maxTrade !== undefined) upsert('MAX_TRADE_SIZE_USD', maxTrade);
    if (paperTrading !== undefined) upsert('PAPER_TRADING', paperTrading ? 'true' : 'false');
    writeFileSync(BOT_ENV, txt);

    // Update rules.json if trailing params, strategy or activePlan changed
    if (trailingEnabled !== undefined || trailingMult !== undefined || strategy || activePlan !== undefined) {
      if (existsSync(BOT_RULES)) {
        const rules = JSON.parse(readFileSync(BOT_RULES, 'utf8'));
        if (trailingEnabled !== undefined || trailingMult !== undefined) {
          if (!rules.exit_rules_config) rules.exit_rules_config = {};
          if (!rules.exit_rules_config.trailing_stop) rules.exit_rules_config.trailing_stop = { enabled: false, type: 'atr', multiplier: 2.0 };
          if (trailingEnabled !== undefined) rules.exit_rules_config.trailing_stop.enabled = !!trailingEnabled;
          if (trailingMult !== undefined) rules.exit_rules_config.trailing_stop.multiplier = parseFloat(trailingMult);
        }
        if (strategy) {
          if (!rules.strategy) rules.strategy = {};
          rules.strategy.key = strategy;
        }
        if (activePlan !== undefined) rules.active_plan = activePlan || null;
        writeFileSync(BOT_RULES, JSON.stringify(rules, null, 2));
      }
    }

    res.json({ success: true, symbol, timeframe, strategy, portfolio, maxTrade, paperTrading });

    // RESTART MASTERBOT SE ESTIVER RODANDO
    // Isso garante que mudanças de PAPER_TRADING ou Estratégia entrem em vigor na hora
    setTimeout(async () => {
      let pidToKill = masterProcess?.pid;
      if (!pidToKill && existsSync(BOT_MASTER_PID)) {
        pidToKill = parseInt(readFileSync(BOT_MASTER_PID, 'utf8'));
      }
      if (pidToKill) {
        console.log(`♻️ Reiniciando MasterBot para aplicar novas configurações...`);
        try { execSync(`taskkill /F /PID ${pidToKill} /T`); } catch(e){}
        masterProcess = null;
        if (existsSync(BOT_MASTER_PID)) unlinkSync(BOT_MASTER_PID);

        // Aguarda 2s e liga de novo
        setTimeout(() => {
          masterProcess = spawn('node', ['bot.js', '--master'], { cwd: BOT_DIR, detached: true, stdio: 'ignore' });
          if (masterProcess.pid) writeFileSync(BOT_MASTER_PID, masterProcess.pid.toString());
          masterProcess.unref();
          console.log(`✅ MasterBot reiniciado com sucesso.`);
        }, 2000);
      }
    }, 500);

  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get('/api/bot/log', (_req, res) => {
  try {
    if (!existsSync(BOT_LOG)) return res.json({ success: true, trades: [] });
    const log = JSON.parse(readFileSync(BOT_LOG, 'utf8'));
    const trades = (log.trades || []).slice(-20).reverse();
    res.json({ success: true, trades });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/bot/run', (_req, res) => {
  if (!existsSync(BOT_DIR)) return res.status(404).json({ success: false, error: 'Pasta do bot não encontrada' });
  const proc = spawn('node', ['bot.js'], { cwd: BOT_DIR, shell: false });
  let stdout = '', stderr = '';
  const timer = setTimeout(() => proc.kill('SIGKILL'), 60000);
  proc.stdout.on('data', d => stdout += d.toString());
  proc.stderr.on('data', d => stderr += d.toString());
  proc.on('close', code => {
    clearTimeout(timer);
    let last = null;
    try {
      if (existsSync(BOT_LOG)) {
        const log = JSON.parse(readFileSync(BOT_LOG, 'utf8'));
        last = log.trades?.[log.trades.length - 1] || null;
      }
    } catch { /* ignore */ }
    res.json({ success: code === 0, exitCode: code, stdout, stderr, last });
  });
  proc.on('error', err => {
    clearTimeout(timer);
    res.status(500).json({ success: false, error: err.message });
  });
});

// ── Force Trade (ignora safety check) ───────────────────────────
app.post('/api/bot/force-trade', (req, res) => {
  if (!existsSync(BOT_DIR)) return res.status(404).json({ success: false, error: 'Pasta do bot não encontrada' });
  const { symbol, timeframe, side } = req.body || {};
  if (!symbol || !timeframe || !side) return res.status(400).json({ success: false, error: 'symbol, timeframe e side são obrigatórios' });
  const env = { ...process.env, FORCE_SYMBOL: symbol, FORCE_TF: timeframe, FORCE_SIDE: side.toUpperCase(), FORCE_ONCE: '1' };
  const proc = spawn('node', ['bot.js'], { cwd: BOT_DIR, shell: false, env });
  let stdout = '', stderr = '';
  const timer = setTimeout(() => proc.kill('SIGKILL'), 60000);
  proc.stdout.on('data', d => stdout += d.toString());
  proc.stderr.on('data', d => stderr += d.toString());
  proc.on('close', code => {
    clearTimeout(timer);
    let last = null;
    try {
      if (existsSync(BOT_LOG)) {
        const log = JSON.parse(readFileSync(BOT_LOG, 'utf8'));
        last = log.trades?.[log.trades.length - 1] || null;
      }
    } catch {}
    res.json({ success: code === 0, exitCode: code, stdout, stderr, last });
  });
  proc.on('error', err => { clearTimeout(timer); res.status(500).json({ success: false, error: err.message }); });
});

// ── MasterBot Loop Management ────────────────────────────────────

app.get('/api/bot/master/status', (req, res) => {
  try {
    let loopState = { status: 'stopped', watchlist: [], lastResults: [] };
    if (existsSync(BOT_MASTER_STATUS)) {
      loopState = JSON.parse(readFileSync(BOT_MASTER_STATUS, 'utf8'));
    }
    
    // Check if process is actually alive via PID file or memory
    let isAlive = !!(masterProcess && !masterProcess.killed);
    
    if (!isAlive && existsSync(BOT_MASTER_PID)) {
      try {
        const pid = parseInt(readFileSync(BOT_MASTER_PID, 'utf8'));
        if (pid) {
          // No Windows, checa via tasklist
          const stdout = execSync(`tasklist /FI "PID eq ${pid}" /NH`).toString();
          isAlive = stdout.includes(pid.toString());
        }
      } catch (e) { isAlive = false; }
    }

    if (!isAlive && loopState.status !== 'stopped') {
      loopState.status = 'stopped';
    }

    res.json({ success: true, ...loopState, isAlive });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/bot/master/start', (req, res) => {
  try {
    const { interval } = req.body || {};
    const allowedIntervals = ['10m', '30m', '1h', '4h'];
    const safeInterval = allowedIntervals.includes(interval) ? interval : '1h';

    // Matar qualquer instância anterior pelo PID file antes de iniciar nova
    if (existsSync(BOT_MASTER_PID)) {
      const oldPid = parseInt(readFileSync(BOT_MASTER_PID, 'utf8'));
      if (oldPid) {
        try { execSync(`taskkill /F /PID ${oldPid} /T 2>nul`); } catch {}
      }
      unlinkSync(BOT_MASTER_PID);
    }
    if (masterProcess && !masterProcess.killed) {
      try { masterProcess.kill('SIGTERM'); } catch {}
      masterProcess = null;
    }

    // Salva o intervalo no .env para que reinícios automáticos o preservem
    if (existsSync(BOT_ENV)) {
      let txt = readFileSync(BOT_ENV, 'utf8');
      const re = /^MASTERBOT_LOOP_INTERVAL=.*$/m;
      if (re.test(txt)) txt = txt.replace(re, `MASTERBOT_LOOP_INTERVAL=${safeInterval}`);
      else txt += (txt.endsWith('\n') ? '' : '\n') + `MASTERBOT_LOOP_INTERVAL=${safeInterval}\n`;
      writeFileSync(BOT_ENV, txt);
    }

    console.log(`🚀 Iniciando MasterBot em modo LOOP (--master) | intervalo: ${safeInterval}...`);
    masterProcess = spawn('node', ['bot.js', '--master'], {
      cwd: BOT_DIR,
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, MASTERBOT_LOOP_INTERVAL: safeInterval }
    });

    if (masterProcess.pid) {
      writeFileSync(BOT_MASTER_PID, masterProcess.pid.toString());
    }

    masterProcess.unref();
    res.json({ success: true, pid: masterProcess.pid });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/bot/master/stop', (req, res) => {
  try {
    let pidToKill = masterProcess?.pid;
    
    if (!pidToKill && existsSync(BOT_MASTER_PID)) {
      pidToKill = parseInt(readFileSync(BOT_MASTER_PID, 'utf8'));
    }

    if (pidToKill) {
      console.log(`🛑 Matando MasterBot (PID: ${pidToKill})...`);
      try {
        execSync(`taskkill /F /PID ${pidToKill} /T`);
      } catch (e) { console.log('Processo já estava morto ou erro no kill:', e.message); }
    }

    masterProcess = null;
    if (existsSync(BOT_MASTER_PID)) unlinkSync(BOT_MASTER_PID);

    // Atualiza o arquivo de status para que a UI saiba que parou
    try {
      if (existsSync(BOT_MASTER_STATUS)) {
        const state = JSON.parse(readFileSync(BOT_MASTER_STATUS, 'utf8'));
        state.status = 'stopped';
        state.nextRun = null;
        writeFileSync(BOT_MASTER_STATUS, JSON.stringify(state, null, 2));
      }
    } catch (e) { console.error('Erro ao limpar status:', e); }

    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── POSITIONS ────────────────────────────────────────────────────
const BOT_POSITIONS = join(BOT_DIR, 'positions.json');

async function syncPositionsWithBinance(env) {
  const apiKey = env.BINANCE_API_KEY || env.BITGET_API_KEY;
  const secretKey = env.BINANCE_SECRET_KEY || env.BITGET_SECRET_KEY;
  if (!apiKey || !secretKey || env.PAPER_TRADING === 'true') return { synced: 0, details: [] };
  if (!existsSync(BOT_POSITIONS)) return { synced: 0, details: [] };

  const positions = JSON.parse(readFileSync(BOT_POSITIONS, 'utf8'));
  let synced = 0;
  const details = [];

  for (const pos of positions) {
    if (pos.status !== 'open') continue;

    // ── Posições com OCO ativo ────────────────────────────────────
    if (pos.ocoPlaced && pos.ocoOrderListId) {
      try {
        const ts = (await (await fetch('https://api.binance.com/api/v3/time')).json()).serverTime;
        const qs = `orderListId=${pos.ocoOrderListId}&timestamp=${ts}&recvWindow=10000`;
        const sig = crypto.createHmac('sha256', secretKey).update(qs).digest('hex');
        const data = await (await fetch(`https://api.binance.com/api/v3/orderList?${qs}&signature=${sig}`, {
          headers: { 'X-MBX-APIKEY': apiKey }
        })).json();

        details.push({ symbol: pos.symbol, ocoId: pos.ocoOrderListId, response: data.listOrderStatus || data.code, msg: data.msg });

        // OCO não existe na Binance → já foi executada e limpa
        if (data.code === -2011 || data.code === -1121) {
          pos.status = 'closed'; pos.closedAt = new Date().toISOString();
          pos.exitReason = 'OCO não encontrada — executada e removida da Binance';
          pos.exitPrice = null; pos.pnl = null;
          synced++; continue;
        }

        if (data.code && data.code < 0) continue; // outro erro de API, pula

        if (data.listOrderStatus === 'ALL_DONE' || data.listStatusType === 'ALL_DONE') {
          const filledOrder = (data.orderReports || []).find(o => o.status === 'FILLED');
          if (filledOrder) {
            const execQty  = parseFloat(filledOrder.executedQty || 0);
            const quoteQty = parseFloat(filledOrder.cummulativeQuoteQty || 0);
            const exitPrice = execQty > 0 && quoteQty > 0
              ? quoteQty / execQty
              : parseFloat(filledOrder.price) || parseFloat(filledOrder.stopPrice) || pos.entryPrice;
            const isTP = filledOrder.type === 'LIMIT_MAKER' || exitPrice >= (pos.takeProfitPrice || exitPrice);
            pos.status      = 'closed';
            pos.closedAt    = new Date(filledOrder.updateTime || Date.now()).toISOString();
            pos.exitPrice   = exitPrice;
            pos.exitReason  = isTP ? `TAKE PROFIT via OCO @ $${exitPrice.toFixed(8)}` : `STOP LOSS via OCO @ $${exitPrice.toFixed(8)}`;
            pos.exitOrderId = String(filledOrder.orderId);
            pos.pnl         = parseFloat(((exitPrice - pos.entryPrice) * pos.quantity).toFixed(4));
            synced++;
          } else {
            // ALL_DONE sem FILLED → OCO cancelada inteira (sem execução de venda)
            pos.status = 'closed'; pos.closedAt = new Date().toISOString();
            pos.exitReason = 'OCO cancelada — posição encerrada (sem preço de venda)';
            pos.exitPrice = pos.entryPrice; pos.pnl = 0;
            synced++;
          }
        }
      } catch (e) {
        details.push({ symbol: pos.symbol, result: 'exception', error: e.message });
      }
      continue;
    }

    // ── Posições SEM OCO: verifica se a ordem de compra foi preenchida ──
    if (pos.orderId && !pos.ocoPlaced) {
      try {
        const ts = (await (await fetch('https://api.binance.com/api/v3/time')).json()).serverTime;
        const qs = `symbol=${pos.symbol}&orderId=${pos.orderId}&timestamp=${ts}&recvWindow=10000`;
        const sig = crypto.createHmac('sha256', secretKey).update(qs).digest('hex');
        const data = await (await fetch(`https://api.binance.com/api/v3/order?${qs}&signature=${sig}`, {
          headers: { 'X-MBX-APIKEY': apiKey }
        })).json();
        details.push({ symbol: pos.symbol, orderId: pos.orderId, orderStatus: data.status || data.code });
        // se a ordem de compra foi cancelada/rejeitada → posição nunca abriu de fato
        if (data.status === 'CANCELED' || data.status === 'REJECTED' || data.status === 'EXPIRED') {
          pos.status = 'closed'; pos.closedAt = new Date().toISOString();
          pos.exitReason = `Ordem de compra ${data.status} — posição nunca aberta`;
          pos.exitPrice = pos.entryPrice; pos.pnl = 0;
          synced++;
        }
      } catch (e) {
        details.push({ symbol: pos.symbol, result: 'buy_check_exception', error: e.message });
      }
    }
  }

  if (synced > 0) writeFileSync(BOT_POSITIONS, JSON.stringify(positions, null, 2));
  return { synced, details };
}

app.get('/api/bot/positions', async (_req, res) => {
  try {
    const env = existsSync(BOT_ENV) ? parseEnv(readFileSync(BOT_ENV, 'utf8')) : {};
    await syncPositionsWithBinance(env);
    const positions = existsSync(BOT_POSITIONS) ? JSON.parse(readFileSync(BOT_POSITIONS, 'utf8')) : [];
    res.json({ success: true, positions });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/bot/positions/sync', async (_req, res) => {
  try {
    const env = existsSync(BOT_ENV) ? parseEnv(readFileSync(BOT_ENV, 'utf8')) : {};
    const result = await syncPositionsWithBinance(env);
    res.json({ success: true, synced: result.synced, details: result.details });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Busca o stepSize do LOT_SIZE para arredondar a quantidade corretamente
async function getStepSize(symbol) {
  try {
    const r = await fetch(`https://api.binance.com/api/v3/exchangeInfo?symbol=${symbol}`);
    const d = await r.json();
    const lot = d.symbols?.[0]?.filters?.find(f => f.filterType === 'LOT_SIZE');
    return lot?.stepSize || '1';
  } catch(e) { return '1'; }
}

function floorToStep(qty, stepSize) {
  const step = parseFloat(stepSize);
  const decimals = stepSize.includes('.') ? stepSize.replace(/0+$/, '').split('.')[1]?.length || 0 : 0;
  return parseFloat((Math.floor(qty / step) * step).toFixed(decimals));
}

app.post('/api/bot/positions/:id/close', async (req, res) => {
  try {
    if (!existsSync(BOT_POSITIONS)) return res.status(404).json({ success: false, error: 'positions.json não encontrado' });
    const positions = JSON.parse(readFileSync(BOT_POSITIONS, 'utf8'));
    const pos = positions.find(p => p.id === req.params.id && p.status === 'open');
    if (!pos) return res.status(404).json({ success: false, error: 'Posição não encontrada ou já fechada' });

    const env = existsSync(BOT_ENV) ? parseEnv(readFileSync(BOT_ENV, 'utf8')) : {};
    const apiKey = env.BINANCE_API_KEY || env.BITGET_API_KEY;
    const secretKey = env.BINANCE_SECRET_KEY || env.BITGET_SECRET_KEY;
    const paperTrading = env.PAPER_TRADING !== 'false';
    // ?markOnly=true → apenas marca como fechado sem enviar ordem (já vendeu manualmente)
    const markOnly = req.query.markOnly === 'true';

    // Buscar preço atual
    let exitPrice = null;
    try {
      const pr = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${pos.symbol}`);
      exitPrice = parseFloat((await pr.json()).price);
    } catch(e) {}

    let exitOrderId = null;

    if (!markOnly && !paperTrading && apiKey && secretKey) {
      // ── Cancelar OCO automático (se tiver listId salvo) ──
      if (pos.ocoOrderListId && !pos.ocoManual) {
        try {
          const timeRes = await fetch('https://api.binance.com/api/v3/time');
          const ts = (await timeRes.json()).serverTime;
          const qs = `symbol=${pos.symbol}&orderListId=${pos.ocoOrderListId}&timestamp=${ts}&recvWindow=10000`;
          const sig = crypto.createHmac('sha256', secretKey).update(qs).digest('hex');
          await fetch(`https://api.binance.com/api/v3/orderList?${qs}&signature=${sig}`, { method: 'DELETE', headers: { 'X-MBX-APIKEY': apiKey } });
        } catch(e) {}
      }

      // ── Buscar saldo real do ativo na Binance ──
      // Extrai o base asset com match exato (RENDERUSDT → RENDER, BTCUSDT → BTC)
      const baseAsset = pos.symbol.endsWith('USDT') ? pos.symbol.slice(0, -4)
                      : pos.symbol.endsWith('BTC')  ? pos.symbol.slice(0, -3)
                      : pos.symbol.slice(0, -4);
      // Fallback: pos.quantity * 0.999 (desconta 0.1% de taxa de compra que a Binance já reteve)
      let actualBalance = parseFloat((pos.quantity * 0.999).toFixed(8));
      try {
        const tsRes = await fetch('https://api.binance.com/api/v3/time');
        const tsNow = (await tsRes.json()).serverTime;
        const qsAcc = `timestamp=${tsNow}`;
        const sigAcc = crypto.createHmac('sha256', secretKey).update(qsAcc).digest('hex');
        const accRes = await fetch(`https://api.binance.com/api/v3/account?${qsAcc}&signature=${sigAcc}`, { headers: { 'X-MBX-APIKEY': apiKey } });
        const accData = await accRes.json();
        // Busca exata pelo asset (evita match parcial como "R" casando antes de "RENDER")
        const bal = accData.balances?.find(b => b.asset === baseAsset);
        if (bal && parseFloat(bal.free) > 0) actualBalance = parseFloat(bal.free);
      } catch(e) {}

      // ── SELL MARKET com quantidade ajustada ao LOT_SIZE ──
      const stepSize = await getStepSize(pos.symbol);
      const qty = floorToStep(Math.min(pos.quantity, actualBalance), stepSize);
      if (qty <= 0) return res.status(400).json({ success: false, error: `Saldo insuficiente na carteira Spot. Saldo detectado: ${actualBalance} ${baseAsset}` });

      const timeRes = await fetch('https://api.binance.com/api/v3/time');
      const timestamp = (await timeRes.json()).serverTime;
      const qs = `symbol=${pos.symbol}&side=SELL&type=MARKET&quantity=${qty}&recvWindow=10000&timestamp=${timestamp}`;
      const sig = crypto.createHmac('sha256', secretKey).update(qs).digest('hex');
      const sellRes = await fetch(`https://api.binance.com/api/v3/order?${qs}&signature=${sig}`, {
        method: 'POST', headers: { 'X-MBX-APIKEY': apiKey }
      });
      const sellData = await sellRes.json();
      if (sellData.code && sellData.code < 0) {
        let errMsg = `Binance SELL falhou: [${sellData.code}] ${sellData.msg}`;
        if (sellData.code === -2010 || sellData.code === -1100) {
          errMsg = `Saldo indisponível no Spot Trading (código ${sellData.code}). O ativo pode estar em Earn Flexível ou Funding. Resgate manualmente na Binance e tente novamente, ou use "Já Vendido" para marcar como fechado.`;
        }
        return res.status(400).json({ success: false, error: errMsg, code: sellData.code });
      }
      exitOrderId = String(sellData.orderId);
      exitPrice = parseFloat(sellData.fills?.[0]?.price) || exitPrice;
    } else {
      exitOrderId = markOnly ? 'MARKED-CLOSED' : `PAPER-SELL-${Date.now()}`;
    }

    const reason = markOnly ? 'Marcado como fechado manualmente (sem ordem)' : 'Fechamento manual pelo dashboard';
    pos.status = 'closed';
    pos.closedAt = new Date().toISOString();
    pos.exitPrice = exitPrice;
    pos.exitReason = reason;
    pos.exitOrderId = exitOrderId;
    pos.pnl = exitPrice ? parseFloat(((exitPrice - pos.entryPrice) * pos.quantity).toFixed(4)) : null;

    writeFileSync(BOT_POSITIONS, JSON.stringify(positions, null, 2));
    res.json({ success: true, position: pos });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── PLACE OCO FOR EXISTING POSITION ─────────────────────────────
app.post('/api/bot/positions/:id/oco', async (req, res) => {
  try {
    if (!existsSync(BOT_POSITIONS)) return res.status(404).json({ success: false, error: 'positions.json não encontrado' });
    const positions = JSON.parse(readFileSync(BOT_POSITIONS, 'utf8'));
    const pos = positions.find(p => p.id === req.params.id && p.status === 'open');
    if (!pos) return res.status(404).json({ success: false, error: 'Posição não encontrada' });

    const env = existsSync(BOT_ENV) ? parseEnv(readFileSync(BOT_ENV, 'utf8')) : {};
    const apiKey = env.BINANCE_API_KEY || env.BITGET_API_KEY;
    const secretKey = env.BINANCE_SECRET_KEY || env.BITGET_SECRET_KEY;
    if (!apiKey || !secretKey) return res.status(400).json({ success: false, error: 'Sem credenciais da Binance' });

    const { stopPrice, takeProfitPrice } = pos;
    if (!stopPrice || !takeProfitPrice) return res.status(400).json({ success: false, error: 'Stop ou TP não definidos na posição' });

    // Buscar saldo real do ativo
    const stepSize = await getStepSize(pos.symbol);
    const tsA = (await (await fetch('https://api.binance.com/api/v3/time')).json()).serverTime;
    const qsA = `timestamp=${tsA}`;
    const sigA = crypto.createHmac('sha256', secretKey).update(qsA).digest('hex');
    const accData = await (await fetch(`https://api.binance.com/api/v3/account?${qsA}&signature=${sigA}`, { headers: { 'X-MBX-APIKEY': apiKey } })).json();
    const bal = accData.balances?.find(b => pos.symbol.startsWith(b.asset));
    const actualQty = bal ? parseFloat(bal.free) : pos.quantity;
    const qty = floorToStep(Math.min(pos.quantity, actualQty), stepSize);
    if (qty <= 0) return res.status(400).json({ success: false, error: 'Saldo zero na carteira Spot' });

    // Arredondar preços ao tick size
    const tickRes = await fetch(`https://api.binance.com/api/v3/exchangeInfo?symbol=${pos.symbol}`);
    const tickData = await tickRes.json();
    const priceFilter = tickData.symbols?.[0]?.filters?.find(f => f.filterType === 'PRICE_FILTER');
    const tickSize = priceFilter?.tickSize || '0.00001';
    function floorTick(price) {
      const tick = parseFloat(tickSize);
      const dec = tickSize.replace(/0+$/, '').split('.')[1]?.length || 0;
      return parseFloat((Math.floor(price / tick) * tick).toFixed(dec));
    }
    const tpPrice  = floorTick(takeProfitPrice);
    const spPrice  = floorTick(stopPrice);
    const slpPrice = floorTick(stopPrice * 0.995);

    const ts = (await (await fetch('https://api.binance.com/api/v3/time')).json()).serverTime;
    const qs = [
      `symbol=${pos.symbol}`, `side=SELL`, `quantity=${qty}`,
      `price=${tpPrice}`, `stopPrice=${spPrice}`, `stopLimitPrice=${slpPrice}`,
      `stopLimitTimeInForce=GTC`, `recvWindow=10000`, `timestamp=${ts}`
    ].join('&');
    const sig = crypto.createHmac('sha256', secretKey).update(qs).digest('hex');
    const ocoRes = await fetch(`https://api.binance.com/api/v3/order/oco?${qs}&signature=${sig}`, {
      method: 'POST', headers: { 'X-MBX-APIKEY': apiKey }
    });
    const ocoData = await ocoRes.json();
    if (ocoData.code && ocoData.code < 0) return res.status(400).json({ success: false, error: `OCO falhou: [${ocoData.code}] ${ocoData.msg}` });

    pos.ocoPlaced = true;
    pos.ocoOrderListId = ocoData.orderListId;
    pos.ocoManual = false;
    writeFileSync(BOT_POSITIONS, JSON.stringify(positions, null, 2));
    res.json({ success: true, orderListId: ocoData.orderListId });
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── BALANCE ───────────────────────────────────────────────────────
app.get('/api/bot/balance', async (_req, res) => {
  try {
    const env = existsSync(BOT_ENV) ? parseEnv(readFileSync(BOT_ENV, 'utf8')) : {};
    const apiKey = env.BINANCE_API_KEY || env.BITGET_API_KEY;
    const secretKey = env.BINANCE_SECRET_KEY || env.BITGET_SECRET_KEY;
    if (!apiKey || !secretKey) return res.json({ success: false, error: 'Sem credenciais' });

    const timeRes = await fetch('https://api.binance.com/api/v3/time');
    const timestamp = (await timeRes.json()).serverTime;
    const queryString = `timestamp=${timestamp}`;
    const signature = crypto.createHmac('sha256', secretKey).update(queryString).digest('hex');
    const r = await fetch(`https://api.binance.com/api/v3/account?${queryString}&signature=${signature}`, {
      headers: { 'X-MBX-APIKEY': apiKey }
    });
    const data = await r.json();
    if (data.code && data.code < 0) return res.json({ success: false, error: data.msg });
    const usdt = data.balances?.find(b => b.asset === 'USDT');
    res.json({ success: true, usdt: usdt ? parseFloat(usdt.free) : 0 });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── PORTFOLIO ─────────────────────────────────────────────────────
app.get('/api/bot/portfolio', async (_req, res) => {
  try {
    const env = existsSync(BOT_ENV) ? parseEnv(readFileSync(BOT_ENV, 'utf8')) : {};
    const apiKey = env.BINANCE_API_KEY || env.BITGET_API_KEY;
    const secretKey = env.BINANCE_SECRET_KEY || env.BITGET_SECRET_KEY;
    if (!apiKey || !secretKey) return res.json({ success: false, error: 'Sem credenciais' });

    const timeRes = await fetch('https://api.binance.com/api/v3/time');
    const timestamp = (await timeRes.json()).serverTime;
    const qs = `timestamp=${timestamp}`;
    const sig = crypto.createHmac('sha256', secretKey).update(qs).digest('hex');
    const r = await fetch(`https://api.binance.com/api/v3/account?${qs}&signature=${sig}`, {
      headers: { 'X-MBX-APIKEY': apiKey }
    });
    const data = await r.json();
    if (data.code && data.code < 0) return res.json({ success: false, error: data.msg });

    const nonZero = (data.balances || []).filter(b => parseFloat(b.free) + parseFloat(b.locked) > 0);
    const assets = nonZero.filter(b => b.asset !== 'USDT');
    const usdtBal = nonZero.find(b => b.asset === 'USDT');
    let total = usdtBal ? parseFloat(usdtBal.free) + parseFloat(usdtBal.locked) : 0;
    const freeUsdt = usdtBal ? parseFloat(usdtBal.free) : 0;

    // Fetch prices for all non-USDT assets in parallel
    await Promise.all(assets.map(async b => {
      try {
        const pr = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${b.asset}USDT`);
        const pd = await pr.json();
        if (pd.price) total += (parseFloat(b.free) + parseFloat(b.locked)) * parseFloat(pd.price);
      } catch { /* skip asset if no USDT pair */ }
    }));

    // BRL conversion via public API
    let brlRate = 5.7;
    try {
      const brlRes = await fetch('https://economia.awesomeapi.com.br/json/last/USD-BRL');
      const brlData = await brlRes.json();
      brlRate = parseFloat(brlData['USDBRL']?.bid || brlRate);
    } catch { /* use fallback rate */ }

    res.json({ success: true, total_usdt: total, total_brl: total * brlRate, free_usdt: freeUsdt, brl_rate: brlRate });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── PRICE ─────────────────────────────────────────────────────────
app.get('/api/price/:symbol', async (req, res) => {
  try {
    const r = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${req.params.symbol}`);
    const d = await r.json();
    res.json({ success: true, symbol: req.params.symbol, price: parseFloat(d.price) });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── MICRO-SCALPER ────────────────────────────────────────────────
const MICRO_SCRIPT = join(ROOT, 'micro-scalper.js');
const MICRO_LOG = join(ROOT, 'micro-scalper-log.json');
const MICRO_PID = join(ROOT, '.micro-scalper.pid');
let microProcess = null;

function microIsAlive() {
  if (microProcess && !microProcess.killed) return { alive: true, pid: microProcess.pid };
  if (existsSync(MICRO_PID)) {
    const pid = parseInt(readFileSync(MICRO_PID, 'utf8'));
    if (pid) {
      try {
        const stdout = execSync(`tasklist /FI "PID eq ${pid}" /NH`).toString();
        if (stdout.includes(pid.toString())) return { alive: true, pid };
      } catch {}
    }
  }
  return { alive: false, pid: null };
}

app.get('/api/micro-scalper/config', (_req, res) => {
  try {
    const cfg = getRules().micro_scalper || null;
    res.json({ success: true, config: cfg });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get('/api/micro-scalper/status', (_req, res) => {
  try {
    const liveness = microIsAlive();
    let lastSession = null;
    if (existsSync(MICRO_LOG)) {
      const all = JSON.parse(readFileSync(MICRO_LOG, 'utf8'));
      if (Array.isArray(all) && all.length) lastSession = all[all.length - 1];
    }
    res.json({ success: true, running: liveness.alive, pid: liveness.pid, lastSession });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get('/api/micro-scalper/log', (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    if (!existsSync(MICRO_LOG)) return res.json({ success: true, sessions: [], trades: [], daily: { trades: 0, pnl: 0 } });
    
    const all = JSON.parse(readFileSync(MICRO_LOG, 'utf8'));
    const flat = [];
    
    let todayTrades = 0;
    let todayPnl = 0;
    // Pega a data de hoje baseada na hora local do servidor (Brasil)
    const todayStr = new Date(new Date().getTime() - (3 * 60 * 60 * 1000)).toISOString().split('T')[0];

    for (const sess of all) {
      for (const tr of (sess.trades || [])) {
        flat.push({ session: sess.sessionStart, ...tr });
        
        // Se o trade for de hoje (ajuste grosseiro usando o dia) e for um evento de saída, contabiliza o PnL
        if (tr.t && tr.t.includes(todayStr) && tr.event === 'exit') {
          todayTrades++;
          if (tr.pnlPct) todayPnl += tr.pnlPct;
        }
      }
    }
    res.json({ 
      success: true, 
      sessions: all.length, 
      trades: flat.slice(-limit).reverse(),
      daily: { trades: todayTrades, pnl: todayPnl }
    });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get('/api/micro-scalper/ai-review', async (_req, res) => {
  try {
    const { getAiPerformanceReview } = await import('../src/ai/reviewer.js');
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return res.status(400).json({ success: false, error: 'Chave de API do Gemini não configurada' });
    
    const analysis = await getAiPerformanceReview(apiKey);
    res.json({ success: true, analysis });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/micro-scalper/start', (_req, res) => {
  try {
    const liveness = microIsAlive();
    if (liveness.alive) return res.json({ success: false, error: 'already running', pid: liveness.pid });

    if (existsSync(MICRO_PID)) {
      try { unlinkSync(MICRO_PID); } catch {}
    }
    if (!existsSync(MICRO_SCRIPT)) {
      return res.status(404).json({ success: false, error: 'micro-scalper.js not found at ' + MICRO_SCRIPT });
    }

    console.log(`⚡ Iniciando Micro-Scalper...`);
    microProcess = spawn('node', [MICRO_SCRIPT], {
      cwd: ROOT,
      detached: true,
      stdio: 'ignore',
      env: { ...process.env },
    });
    if (microProcess.pid) writeFileSync(MICRO_PID, microProcess.pid.toString());
    microProcess.unref();
    res.json({ success: true, pid: microProcess.pid });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/micro-scalper/stop', (_req, res) => {
  try {
    let pidToKill = microProcess?.pid;
    if (!pidToKill && existsSync(MICRO_PID)) pidToKill = parseInt(readFileSync(MICRO_PID, 'utf8'));
    if (!pidToKill) return res.json({ success: false, error: 'not running' });

    console.log(`🛑 Matando Micro-Scalper (PID: ${pidToKill})...`);
    try { execSync(`taskkill /F /PID ${pidToKill} /T 2>nul`); } catch {}
    if (microProcess) { try { microProcess.kill('SIGTERM'); } catch {} microProcess = null; }
    if (existsSync(MICRO_PID)) { try { unlinkSync(MICRO_PID); } catch {} }
    res.json({ success: true, killed: pidToKill });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});


// ── FALLBACK ─────────────────────────────────────────────────────
app.get('/*splat', (_req, res) => res.sendFile(join(__dirname, 'index.html')));

// ── START ─────────────────────────────────────────────────────────
if (process.env.NODE_ENV !== 'production' || !process.env.VERCEL) {
  const PORT = process.env.PORT || 3333;
  createServer(app).listen(PORT, () => {
    console.log(`\n✅ Dashboard: http://localhost:${PORT}\n`);
  });
}

export default app;
