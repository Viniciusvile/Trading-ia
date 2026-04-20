/**
 * TradingView Dashboard Server — localhost:3333
 */
import express from 'express';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import * as health from '../src/core/health.js';
import * as chart from '../src/core/chart.js';
import * as data from '../src/core/data.js';
import * as capture from '../src/core/capture.js';
import * as alerts from '../src/core/alerts.js';
import * as replay from '../src/core/replay.js';
import * as watchlist from '../src/core/watchlist.js';

import * as pine from '../src/core/pine.js';
import { evaluate } from '../src/connection.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const SCREENSHOTS_DIR = join(ROOT, 'screenshots');
const JOURNAL_FILE = join(__dirname, 'journal.json');

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
stopAtr     = input.float(1.5,"Stop (x ATR)", minval=0.1, step=0.1)

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
    stopPrice   = close - atrVal * stopAtr
    targetPrice = close + (close - stopPrice) * rr
    strategy.entry("Long", strategy.long)
    strategy.exit("Long TP/SL", "Long", stop=stopPrice, limit=targetPrice)

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

// ── EMAs
emaFast = ta.ema(close, emaFastLen)
emaSlow = ta.ema(close, emaSlowLen)

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
if longSignal
    stopLoss   = low[2]
    target     = close + (close - stopLoss) * rr
    strategy.entry("Long", strategy.long)
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

// ── BOT (claude-tradingview-mcp-trading) ─────────────────────────
const BOT_DIR = resolve(ROOT, '..', 'claude-tradingview-mcp-trading');
const BOT_LOG = join(BOT_DIR, 'safety-check-log.json');
const BOT_ENV = join(BOT_DIR, '.env');
const BOT_RULES = join(BOT_DIR, 'rules.json');

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
    const hasRealKeys = env.BITGET_API_KEY && !/your_api_key_here|^$/.test(env.BITGET_API_KEY);
    res.json({
      success: true,
      dir: BOT_DIR,
      strategy: rules?.strategy?.name || 'n/a',
      symbol: env.SYMBOL || 'BTCUSDT',
      timeframe: env.TIMEFRAME || '4H',
      portfolio: Number(env.PORTFOLIO_VALUE_USD || 0),
      maxTrade: Number(env.MAX_TRADE_SIZE_USD || 0),
      maxPerDay: Number(env.MAX_TRADES_PER_DAY || 0),
      paperTrading: env.PAPER_TRADING !== 'false',
      hasRealKeys,
      rules,
    });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.patch('/api/bot/config', (req, res) => {
  try {
    if (!existsSync(BOT_ENV)) return res.status(404).json({ success: false, error: '.env não encontrado' });
    const { symbol, timeframe } = req.body || {};
    const allowedTf = ['1m','5m','15m','30m','1H','4H','1D','1W'];
    if (symbol && !/^[A-Z0-9]{3,20}$/.test(symbol)) return res.status(400).json({ success: false, error: 'Símbolo inválido' });
    if (timeframe && !allowedTf.includes(timeframe)) return res.status(400).json({ success: false, error: 'Timeframe inválido' });
    let txt = readFileSync(BOT_ENV, 'utf8');
    const upsert = (key, val) => {
      const re = new RegExp(`^${key}=.*$`, 'm');
      if (re.test(txt)) txt = txt.replace(re, `${key}=${val}`);
      else txt += (txt.endsWith('\n') ? '' : '\n') + `${key}=${val}\n`;
    };
    if (symbol) upsert('SYMBOL', symbol);
    if (timeframe) upsert('TIMEFRAME', timeframe);
    writeFileSync(BOT_ENV, txt);
    res.json({ success: true, symbol, timeframe });
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
