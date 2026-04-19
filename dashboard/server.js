/**
 * TradingView Dashboard Server — localhost:3333
 */
import express from 'express';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import * as health from '../src/core/health.js';
import * as chart from '../src/core/chart.js';
import * as data from '../src/core/data.js';
import * as capture from '../src/core/capture.js';
import * as alerts from '../src/core/alerts.js';
import * as replay from '../src/core/replay.js';
import * as watchlist from '../src/core/watchlist.js';
import * as batch from '../src/core/batch.js';
import * as pine from '../src/core/pine.js';

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

// ── HEALTH ───────────────────────────────────────────────────────
app.get('/api/health', async (req, res) => {
  try { res.json(await health.healthCheck()); }
  catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── CHART STATE ──────────────────────────────────────────────────
app.get('/api/state', async (req, res) => {
  try { res.json({ success: true, ...(await chart.getState()) }); }
  catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── QUOTE ────────────────────────────────────────────────────────
app.get('/api/quote', async (req, res) => {
  try { res.json(await data.getQuote({})); }
  catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── INDICATORS ───────────────────────────────────────────────────
app.get('/api/indicators', async (req, res) => {
  try { res.json(await data.getStudyValues()); }
  catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── OHLCV ────────────────────────────────────────────────────────
app.get('/api/ohlcv', async (req, res) => {
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

app.get('/api/screenshot-image', (req, res) => {
  if (!lastScreenshotPath) return res.status(404).json({ error: 'Nenhum screenshot disponível' });
  res.sendFile(lastScreenshotPath);
});

app.get('/api/screenshots/list', (req, res) => {
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
app.get('/api/brief', async (req, res) => {
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
  catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/alerts', async (req, res) => {
  try {
    const { condition, price, message } = req.body;
    res.json(await alerts.create({ condition, price, message }));
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.delete('/api/alerts', async (req, res) => {
  try { res.json(await alerts.deleteAlerts({ delete_all: true })); }
  catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── STRATEGY TESTER ──────────────────────────────────────────────
app.get('/api/strategy', async (req, res) => {
  try { res.json(await data.getStrategyResults()); }
  catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get('/api/strategy/trades', async (req, res) => {
  try { res.json(await data.getTrades({ max_trades: 50 })); }
  catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get('/api/strategy/equity', async (req, res) => {
  try { res.json(await data.getEquity()); }
  catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── SCANNER ──────────────────────────────────────────────────────
app.post('/api/scanner', async (req, res) => {
  try {
    const { symbols = ['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT'] } = req.body || {};
    const result = await batch.batchRun({ symbols, action: 'get_indicators', delay_ms: 800 });
    res.json(result);
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── WATCHLIST ────────────────────────────────────────────────────
app.get('/api/watchlist', async (req, res) => {
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

app.post('/api/replay/step', async (req, res) => {
  try { res.json(await replay.step()); }
  catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/replay/autoplay', async (req, res) => {
  try {
    const { speed = 500 } = req.body || {};
    res.json(await replay.autoplay({ speed }));
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/replay/stop', async (req, res) => {
  try { res.json(await replay.stop()); }
  catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get('/api/replay/status', async (req, res) => {
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
app.get('/api/pine/source', async (req, res) => {
  try { res.json(await pine.getSource()); }
  catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/pine/source', async (req, res) => {
  try {
    const { source } = req.body;
    res.json(await pine.setSource({ source }));
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/pine/compile', async (req, res) => {
  try { res.json(await pine.smartCompile()); }
  catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get('/api/pine/errors', async (req, res) => {
  try { res.json(await pine.getErrors()); }
  catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/pine/save', async (req, res) => {
  try { res.json(await pine.save()); }
  catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get('/api/pine/list', async (req, res) => {
  try { res.json(await pine.listScripts()); }
  catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/pine/open', async (req, res) => {
  try {
    const { name } = req.body;
    res.json(await pine.openScript({ name }));
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get('/api/pine/console', async (req, res) => {
  try { res.json(await pine.getConsole()); }
  catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── JOURNAL ──────────────────────────────────────────────────────
app.get('/api/journal', (req, res) => {
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

// ── FALLBACK ─────────────────────────────────────────────────────
app.get('/*splat', (req, res) => res.sendFile(join(__dirname, 'index.html')));

// ── START ─────────────────────────────────────────────────────────
if (process.env.NODE_ENV !== 'production' || !process.env.VERCEL) {
  const PORT = process.env.PORT || 3333;
  createServer(app).listen(PORT, () => {
    console.log(`\n✅ Dashboard: http://localhost:${PORT}\n`);
  });
}

export default app;
