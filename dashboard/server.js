/**
 * TradingView Dashboard Server — localhost:3333
 */
import express from 'express';
import { createServer } from 'node:http';
import * as db from '../masterbot/db.js';
import * as adaptiveStore from '../adaptive-bot/lib/store.js';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, openSync } from 'node:fs';
import { spawn } from 'node:child_process';
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
import { simulateTrades, computeStats, buildEquityCurve } from '../masterbot/lib/backtest-engine.js';
import { createSignalFn, getPlanWarnings } from '../masterbot/lib/strategy-signals.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const SCREENSHOTS_DIR = join(ROOT, 'screenshots');
const JOURNAL_FILE = join(__dirname, 'journal.json');

dotenv.config({ path: join(ROOT, '.env') });

const app = express();
app.use(express.json());

const JWT_SECRET = process.env.JWT_SECRET || 'trading-saas-super-secret-key-2026';

// Middleware de Autenticação JWT
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

  if (!token) {
    return res.status(401).json({ success: false, error: 'Token de autenticação ausente' });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ success: false, error: 'Token inválido ou expirado' });
    }
    req.user = user;
    next();
  });
}

// Rota de Cadastro (Register)
app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ success: false, error: 'Email e senha são obrigatórios' });
    }
    const userName = name || email.split('@')[0];

    const existingUser = await db.getUserByEmail(email);
    if (existingUser) {
      return res.status(400).json({ success: false, error: 'Este e-mail já está cadastrado' });
    }

    const passwordHash = bcrypt.hashSync(password, 10);
    const newUser = await db.createUser(userName, email, passwordHash);

    const token = jwt.sign(
      { id: newUser.id, name: newUser.name, email: newUser.email },
      JWT_SECRET,
      { expiresIn: '30d' }
    );

    res.json({ success: true, token, user: newUser });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Rota de Login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ success: false, error: 'Email e senha são obrigatórios' });
    }

    const user = await db.getUserByEmail(email);
    if (!user) {
      return res.status(401).json({ success: false, error: 'E-mail ou senha incorretos' });
    }

    const isMatch = bcrypt.compareSync(password, user.password_hash);
    if (!isMatch) {
      return res.status(401).json({ success: false, error: 'E-mail ou senha incorretos' });
    }

    const token = jwt.sign(
      { id: user.id, name: user.name, email: user.email },
      JWT_SECRET,
      { expiresIn: '30d' }
    );

    res.json({
      success: true,
      token,
      user: { id: user.id, name: user.name, email: user.email }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Rota Perfil (Me)
app.get('/api/auth/me', authenticateToken, async (req, res) => {
  try {
    const user = await db.getUserById(req.user.id);
    if (!user) {
      return res.status(404).json({ success: false, error: 'Usuário não encontrado' });
    }
    res.json({
      success: true,
      user: { id: user.id, name: user.name, email: user.email }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// No Vercel, o static pode ser resolvido pelo vercel.json, 
// mas mantemos aqui para compatibilidade local.
app.use(express.static(__dirname));

// ── helpers ──────────────────────────────────────────────────────
function getRules() {
  try { return JSON.parse(readFileSync(join(ROOT, 'rules.json'), 'utf8')); } catch { return {}; }
}

/**
 * As estratégias (group_plans) agora vivem por usuário no Postgres, mas o BOT
 * real ainda opera lendo group_plans/active_plan do rules.json global. Para o
 * bot refletir as estratégias do dono da conta (a que ele usa via .env), só o
 * usuário DONO espelha suas alterações no rules.json. Outros usuários editam
 * apenas o próprio conjunto no banco e não tocam no bot.
 */
async function isOwnerUser(userId) {
  if (!userId) return false;
  try {
    const ownerId = await db.getOwnerUserId();
    return ownerId && String(ownerId) === String(userId);
  } catch { return false; }
}

/** Reescreve group_plans/active_plan(s) do rules.json a partir do banco do dono. */
async function syncRulesFromOwner(ownerUserId) {
  try {
    const plans = await db.listStrategies(ownerUserId);
    const activeNames = await db.getActiveStrategyNames(ownerUserId);
    if (!existsSync(BOT_RULES)) return;
    const rules = JSON.parse(readFileSync(BOT_RULES, 'utf8'));
    // Remove a chave interna _active antes de persistir no arquivo do bot
    rules.group_plans = plans.map(({ _active, ...p }) => p);
    // Multi-estratégia: active_plans é a fonte de verdade; active_plan é
    // mantido para retrocompatibilidade quando há exatamente uma ativa.
    rules.active_plans = activeNames;
    rules.active_plan = activeNames.length === 1 ? activeNames[0] : null;
    writeFileSync(BOT_RULES, JSON.stringify(rules, null, 2));
  } catch (e) {
    console.error('⚠️  Falha ao sincronizar rules.json a partir do dono:', e.message);
  }
}

/**
 * Config do Micro Scalper visível para um usuário: o que ele salvou no banco
 * por cima dos defaults globais do rules.json (campos não editáveis pela UI,
 * como cooldowns, continuam vindo do arquivo).
 */
async function getMergedMicroConfig(userId) {
  const globalCfg = getRules().micro_scalper || {};
  const userCfg = await db.getUserMicroConfig(userId);
  return { ...globalCfg, ...(userCfg || {}) };
}

/** Espelha a config do Micro Scalper do DONO no rules.json (o robô real lê de lá). */
async function syncMicroRulesFromOwner(ownerUserId) {
  try {
    const userCfg = await db.getUserMicroConfig(ownerUserId);
    if (!userCfg || !existsSync(BOT_RULES)) return;
    const rules = JSON.parse(readFileSync(BOT_RULES, 'utf8'));
    rules.micro_scalper = { ...(rules.micro_scalper || {}), ...userCfg };
    writeFileSync(BOT_RULES, JSON.stringify(rules, null, 2));
  } catch (e) {
    console.error('⚠️  Falha ao sincronizar micro_scalper do dono:', e.message);
  }
}

/** Atualiza uma flag (liga/desliga lógico) no estado de robôs do usuário. */
async function setUserBotFlag(userId, key, value) {
  const st = await db.getUserBotState(userId);
  st[key] = value;
  await db.saveUserBotState(userId, st);
}

/** Reinicia o Micro Scalper (lê rules.json só no startup). Retorna true se reiniciou. */
function restartMicroScalperIfRunning() {
  const liveness = microIsAlive();
  if (!liveness.alive) return false;
  try { process.kill(liveness.pid, 'SIGTERM'); } catch {}
  if (microProcess) { try { microProcess.kill('SIGTERM'); } catch {} microProcess = null; }
  if (existsSync(MICRO_PID)) { try { unlinkSync(MICRO_PID); } catch {} }
  setTimeout(() => {
    try {
      microProcess = spawn('node', [MICRO_SCRIPT], { cwd: ROOT, detached: true, stdio: 'ignore', env: { ...process.env } });
      if (microProcess.pid) writeFileSync(MICRO_PID, microProcess.pid.toString());
      microProcess.unref();
      console.log(`♻️ Micro-Scalper reiniciado para aplicar nova config (PID ${microProcess.pid})`);
    } catch (e) { console.error('Falha ao reiniciar micro-scalper:', e.message); }
  }, 2000);
  return true;
}
function loadJournal() {
  if (!existsSync(JOURNAL_FILE)) return [];
  try { return JSON.parse(readFileSync(JOURNAL_FILE, 'utf8')); } catch { return []; }
}
function saveJournal(entries) {
  writeFileSync(JOURNAL_FILE, JSON.stringify(entries, null, 2));
}

function isProcessAlive(proc) {
  if (!proc) return false;
  if (proc.exitCode !== null || proc.signalCode !== null) return false;
  try {
    process.kill(proc.pid, 0);
    return true;
  } catch {
    return false;
  }
}

let lastScreenshotPath = null;
// Resposta padrão quando TradingView Desktop não está disponível (ambiente cloud)
const TV_NA = { success: false, tv_unavailable: true, message: 'TradingView Desktop não conectado (ambiente cloud)' };
function noTv(res) { return res.json(TV_NA); }

// ── HEALTH ───────────────────────────────────────────────────────
app.get('/api/health', async (req, res) => {
  try { res.json(await health.healthCheck()); }
  catch (e) { res.json({ success: true, cdp_connected: false, tv_unavailable: true, is_cloud: true }); }
});

// ── MICRO-SCALPER LIVE SIGNAL ────────────────────────────────────
app.get('/api/micro-scalper/signal', authenticateToken, async (req, res) => {
  try {
    // Sinais calculados com os planos do PRÓPRIO usuário
    const rules = await getMergedMicroConfig(req.user.id);
    if (!rules) return res.status(404).json({ success: false, error: 'Config micro_scalper missing' });

    const active = rules.active_symbols || [];
    const results = await Promise.all(active.map(async (sym) => {
      try {
        const sig = await getSymbolSignal(sym, rules);
        return { symbol: sym, success: true, signal: sig };
      } catch (e) {
        return { symbol: sym, success: false, error: e.message };
      }
    }));
    res.json({ success: true, signals: results });
  } catch (e) {
    console.error('❌ [API] Multi-Signal Error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

async function getSymbolSignal(symbol, rules) {
  const { createBinanceClient } = await import('../src/exchange/binance.js');
  const { wv5gSignal, microScalpSignal, turboReversionSignal } = await import('../src/scalper/signals.js');

  const client = createBinanceClient({
    apiKey: process.env.BINANCE_API_KEY,
    secretKey: process.env.BINANCE_SECRET_KEY
  });
  
  const candles = await client.getKlines(symbol, '5m', 50);
  const planCfg = (rules.plans && rules.plans[symbol]) ? rules.plans[symbol] : rules;
  const strategyMode = planCfg.strategy_mode || "micro-dip";

  if (strategyMode === "wv5g-aggr") {
    return wv5gSignal(candles, { rsiLow: planCfg.min_rsi || 30, rsiHigh: planCfg.max_rsi || 85, emaFast: planCfg.ema_fast || 9, emaSlow: planCfg.ema_slow || 20 });
  } else if (strategyMode === "turbo-reversion") {
    return turboReversionSignal(candles, { bbLen: planCfg.bb_length || 20, bbMult: planCfg.bb_mult || 1.8, rsiLen: planCfg.rsi_period || 14, rsiLimit: planCfg.rsi_limit || 45, volMult: planCfg.vol_mult || 1.1, trendEmaPeriod: planCfg.trend_ema_period || 0, trendSlopeBars: planCfg.trend_slope_bars || 5, trendMaxDownPct: planCfg.trend_max_down_pct || 0 });
  } else {
    return microScalpSignal(candles, { emaPeriod: planCfg.ema_period || 20, rsiPeriod: planCfg.rsi_period || 3, minDip: planCfg.min_dip_pct || 0.001, minRsi: planCfg.min_rsi || 20, maxRsi: planCfg.max_rsi || 65 });
  }
}

const PLAN_PRESETS = {
  btc: {
    symbol: 'BTCUSDT',
    tv_symbol: 'BINANCE:BTCUSDT',
    strategy_mode: 'turbo-reversion',
    rsi_period: 14,
    rsi_limit: 42,
    bb_length: 20,
    bb_mult: 2.0,
    vol_mult: 1.2,
    tp_pct: 0.006,       // 0.6% TP — BTC tem movimentos pequenos no 5m
    sl_pct: 0.003,       // 0.3% SL — apertado, BTC é mais previsível
    qty_decimals: 5,
    quote_decimals: 2,
    breakeven_pct: 0.003,
    max_hold_ms: 1800000  // 30 min max
  },
  eth: {
    symbol: 'ETHUSDT',
    tv_symbol: 'BINANCE:ETHUSDT',
    strategy_mode: 'micro-dip',
    ema_period: 20,
    rsi_period: 3,
    min_dip_pct: 0.001,
    min_rsi: 20,
    max_rsi: 65,
    tp_pct: 0.008,       // 0.8% TP — ETH mais volátil que BTC
    sl_pct: 0.004,       // 0.4% SL
    qty_decimals: 4,
    quote_decimals: 2,
    breakeven_pct: 0.004,
    max_hold_ms: 2400000  // 40 min max
  },
  xrp: {
    symbol: 'XRPUSDT',
    tv_symbol: 'BINANCE:XRPUSDT',
    strategy_mode: 'turbo-reversion',
    rsi_period: 14,
    rsi_limit: 45,
    bb_length: 20,
    bb_mult: 2.0,
    vol_mult: 1.1,
    tp_pct: 0.012,       // 1.2% TP — XRP faz movimentos maiores
    sl_pct: 0.006,       // 0.6% SL
    qty_decimals: 0,
    quote_decimals: 2,
    breakeven_pct: 0.006,
    max_hold_ms: 3600000  // 60 min max
  },
  sol: {
    symbol: 'SOLUSDT',
    tv_symbol: 'BINANCE:SOLUSDT',
    strategy_mode: 'micro-dip',
    ema_period: 20,
    rsi_period: 3,
    min_dip_pct: 0.001,
    min_rsi: 20,
    max_rsi: 65,
    tp_pct: 0.010,       // 1.0% TP — SOL tem boa amplitude
    sl_pct: 0.005,       // 0.5% SL
    qty_decimals: 2,
    quote_decimals: 2,
    breakeven_pct: 0.005,
    max_hold_ms: 3600000  // 60 min max
  }
};


app.patch('/api/micro-scalper/config', authenticateToken, async (req, res) => {
  try {
    const { plan, action, max_trade_usdt } = req.body; // action: 'add' | 'remove' | 'toggle'

    // Estado do PRÓPRIO usuário (banco por cima dos defaults globais) — cada
    // conta edita só a sua config; o robô real segue a config do DONO.
    const merged = await getMergedMicroConfig(req.user.id);
    const userCfg = {
      active_symbols: [...(merged.active_symbols || [])],
      plans: { ...(merged.plans || {}) },
      ...(merged.max_trade_usdt !== undefined ? { max_trade_usdt: merged.max_trade_usdt } : {}),
      ...(merged.min_trade_usdt !== undefined ? { min_trade_usdt: merged.min_trade_usdt } : {}),
    };

    if (max_trade_usdt !== undefined) {
      // Limite financeiro por trade do Micro Scalper (isolado do MasterBot)
      const val = parseFloat(max_trade_usdt);
      if (!Number.isFinite(val) || val <= 0) {
        return res.status(400).json({ success: false, error: 'max_trade_usdt inválido' });
      }
      userCfg.max_trade_usdt = val;
      userCfg.min_trade_usdt = parseFloat((val * 0.6).toFixed(2)); // 60% do max
    }

    if (plan && PLAN_PRESETS[plan]) {
      const symbol = PLAN_PRESETS[plan].symbol;
      userCfg.plans[symbol] = { ...PLAN_PRESETS[plan] };

      const isActive = userCfg.active_symbols.includes(symbol);
      if (action === 'add') {
        if (!isActive) userCfg.active_symbols.push(symbol);
      } else if (action === 'remove') {
        userCfg.active_symbols = userCfg.active_symbols.filter(s => s !== symbol);
      } else if (action === 'toggle') {
        if (isActive) userCfg.active_symbols = userCfg.active_symbols.filter(s => s !== symbol);
        else userCfg.active_symbols.push(symbol);
      }
      userCfg.active_symbols = [...new Set(userCfg.active_symbols)];
    }

    await db.saveUserMicroConfig(req.user.id, userCfg);

    // Só o DONO reflete no rules.json e reinicia o robô real
    let restarted = false;
    if (await isOwnerUser(req.user.id)) {
      await syncMicroRulesFromOwner(req.user.id);
      restarted = restartMicroScalperIfRunning();
    }

    res.json({ success: true, config: userCfg, max_trade_usdt: userCfg.max_trade_usdt, restart_required: restarted });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/micro-scalper/trade', async (req, res) => {
  console.log('🚀 [API] Rapid Trade Execution requested');
  try {
    const rules = getRules().micro_scalper;
    if (!rules) throw new Error('Config micro_scalper missing');
    
    const client = createBinanceClient({
      apiKey: process.env.USE_BINANCE_KEY || process.env.BINANCE_API_KEY,
      secretKey: process.env.USE_BINANCE_SECRET || process.env.BINANCE_SECRET_KEY,
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
  } catch (e) { return noTv(res); }
});

// ── CHART STATE ──────────────────────────────────────────────────
app.get('/api/state', async (_req, res) => {
  try { res.json({ success: true, ...(await chart.getState()) }); }
  catch (e) { return noTv(res); }
});

// ── QUOTE ────────────────────────────────────────────────────────
app.get('/api/quote', async (req, res) => {
  // Fonte primária: API pública da Binance (24h ticker) — funciona no cloud,
  // ao contrário do getQuote() do TradingView Desktop (CDP indisponível aqui).
  const symbol = (req.query.symbol || '').toString().toUpperCase().trim();
  if (symbol && /^[A-Z0-9]{5,20}$/.test(symbol)) {
    try {
      const r = await fetch(`https://api.binance.com/api/v3/ticker/24hr?symbol=${symbol}`);
      const t = await r.json();
      if (t && t.lastPrice) {
        return res.json({
          symbol,
          last: parseFloat(t.lastPrice),
          change: parseFloat(t.priceChange),
          changePct: parseFloat(t.priceChangePercent),
          high: parseFloat(t.highPrice),
          low: parseFloat(t.lowPrice),
          volume: parseFloat(t.quoteVolume), // volume em USDT
        });
      }
    } catch (e) { /* cai no fallback do TradingView abaixo */ }
  }
  try { res.json(await data.getQuote({})); }
  catch (e) { return noTv(res); }
});

// ── INDICATORS ───────────────────────────────────────────────────
app.get('/api/indicators', async (req, res) => {
  try { res.json(await data.getStudyValues()); }
  catch (e) { return noTv(res); }
});

// ── OHLCV ────────────────────────────────────────────────────────
app.get('/api/ohlcv', async (_req, res) => {
  try { res.json(await data.getOhlcv({ summary: true, count: 20 })); }
  catch (e) { return noTv(res); }
});

// ── SYMBOL ───────────────────────────────────────────────────────
app.post('/api/symbol', async (req, res) => {
  try {
    const { symbol } = req.body;
    if (!symbol) return res.status(400).json({ success: false, error: 'symbol required' });
    res.json(await chart.setSymbol({ symbol }));
  } catch (e) { return noTv(res); }
});

// ── TIMEFRAME ────────────────────────────────────────────────────
app.post('/api/timeframe', async (req, res) => {
  try {
    const { timeframe } = req.body;
    if (!timeframe) return res.status(400).json({ success: false, error: 'timeframe required' });
    res.json(await chart.setTimeframe({ timeframe }));
  } catch (e) { return noTv(res); }
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
  } catch (e) { return noTv(res); }
});

// ── SYMBOL SEARCH ────────────────────────────────────────────────
app.get('/api/symbol-search', async (req, res) => {
  try {
    const { q } = req.query;
    if (!q) return res.json({ success: true, results: [] });
    res.json(await chart.symbolSearch({ query: q }));
  } catch (e) { return noTv(res); }
});

// ── SCREENSHOT ───────────────────────────────────────────────────
app.post('/api/screenshot', async (req, res) => {
  try {
    const { region = 'chart' } = req.body || {};
    const result = await capture.captureScreenshot({ region });
    if (result.success && result.file_path) lastScreenshotPath = result.file_path;
    res.json(result);
  } catch (e) { return noTv(res); }
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
  } catch (e) { return noTv(res); }
});

// ── ALERTS ───────────────────────────────────────────────────────
app.get('/api/alerts', async (req, res) => {
  try { res.json(await alerts.list()); }
  catch (e) { return noTv(res); }
});

app.post('/api/alerts', async (req, res) => {
  try {
    const { condition, price, message } = req.body;
    res.json(await alerts.create({ condition, price, message }));
  } catch (e) { return noTv(res); }
});

app.delete('/api/alerts', async (_req, res) => {
  try { res.json(await alerts.deleteAlerts({ delete_all: true })); }
  catch (e) { return noTv(res); }
});

// ── STRATEGY TESTER ──────────────────────────────────────────────
app.get('/api/strategy', async (req, res) => {
  try { res.json(await data.getStrategyResults()); }
  catch (e) { return noTv(res); }
});

app.get('/api/strategy/trades', async (req, res) => {
  try { res.json(await data.getTrades({ max_trades: 50 })); }
  catch (e) { return noTv(res); }
});

app.get('/api/strategy/equity', async (_req, res) => {
  try { res.json(await data.getEquity()); }
  catch (e) { return noTv(res); }
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
const BOT_ENV = join(ROOT, '.env');
const BOT_RULES = join(ROOT, 'rules.json');
const BOT_MASTER_PID = join(BOT_DIR, 'master.pid');
const BOT_FUTURES_PID = join(BOT_DIR, 'futures.pid');

let masterProcess = null;
let futuresProcess = null;

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

// Retorna env mesclado: process.env (Railway vars) + .env local quando existir.
async function getBotEnv(userId = null) {
  const fileEnv = existsSync(BOT_ENV) ? parseEnv(readFileSync(BOT_ENV, 'utf8')) : {};
  const merged = { ...process.env, ...fileEnv };
  if (userId) {
    const activeAcc = await db.getActiveAccount(userId);
    if (activeAcc) {
      merged.BINANCE_API_KEY = activeAcc.api_key;
      merged.BINANCE_SECRET_KEY = activeAcc.secret_key;
      merged.BINANCE_IS_TESTNET = activeAcc.is_testnet ? 'true' : 'false';
    } else {
      merged.BINANCE_API_KEY = '';
      merged.BINANCE_SECRET_KEY = '';
    }
  }
  // Garantir trim nas chaves críticas de API
  if (merged.BINANCE_API_KEY) merged.BINANCE_API_KEY = merged.BINANCE_API_KEY.trim();
  if (merged.BINANCE_SECRET_KEY) merged.BINANCE_SECRET_KEY = merged.BINANCE_SECRET_KEY.trim();
  if (merged.BITGET_API_KEY) merged.BITGET_API_KEY = merged.BITGET_API_KEY.trim();
  if (merged.BITGET_SECRET_KEY) merged.BITGET_SECRET_KEY = merged.BITGET_SECRET_KEY.trim();
  return merged;
}

app.post('/api/bot/futures/config', (req, res) => {
  try {
    const { portfolioValue, maxTradeUsd, leverage, symbols } = req.body;
    const rules = JSON.parse(readFileSync(BOT_RULES, 'utf8'));
    if (!rules.group_plans) rules.group_plans = [];
    
    let plan = rules.group_plans.find(p => p.name === 'Alpha_Futures_Trend');
    if (!plan) {
      plan = { name: 'Alpha_Futures_Trend', mode: 'futures', strategy: 'warrior' };
      rules.group_plans.push(plan);
    }
    
    if (portfolioValue !== undefined) plan.portfolioValue = parseFloat(portfolioValue);
    if (maxTradeUsd !== undefined) plan.maxTradeUsd = parseFloat(maxTradeUsd);
    if (leverage !== undefined) plan.leverage = parseInt(leverage);
    if (symbols !== undefined && Array.isArray(symbols)) plan.symbols = symbols;
    
    writeFileSync(BOT_RULES, JSON.stringify(rules, null, 2));
    res.json({ success: true, plan });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get('/api/bot/config', authenticateToken, async (req, res) => {
  try {
    if (!existsSync(BOT_DIR)) return res.status(404).json({ success: false, error: 'Pasta do bot não encontrada', dir: BOT_DIR });
    const env = await getBotEnv(req.user.id);
    const rules = existsSync(BOT_RULES) ? JSON.parse(readFileSync(BOT_RULES, 'utf8')) : null;
    const hasRealKeys = (env.BINANCE_API_KEY && !/your_api_key_here|^$/.test(env.BINANCE_API_KEY)) ||
                        (env.BITGET_API_KEY && !/your_api_key_here|^$/.test(env.BITGET_API_KEY));

    // Estratégias e plano ativo vêm do banco do PRÓPRIO usuário — nunca do
    // rules.json global (que vazava as estratégias do dono para todos).
    const userPlans = await db.listStrategies(req.user.id);
    const userActivePlan = await db.getActiveStrategyName(req.user.id);
    const userActivePlans = await db.getActiveStrategyNames(req.user.id);

    // Config do MasterBot: dono lê do .env (fonte do robô real); demais
    // usuários leem a PRÓPRIA cópia salva no banco (não a do dono).
    const isOwner = await isOwnerUser(req.user.id);
    const mc = isOwner ? {} : ((await db.getUserBotState(req.user.id)).master_config || {});

    res.json({
      success: true,
      dir: BOT_DIR,
      strategyKey: (!isOwner && mc.strategy) || env.BOT_STRATEGY || rules?.strategy?.key || 'warrior',
      strategy: { stormer: '123 Stormer — Alexandre Wolwacz', warrior: 'Warrior Trading — Ross Cameron', both: 'Ambas (Warrior + Stormer)' }[(!isOwner && mc.strategy) || env.BOT_STRATEGY || rules?.strategy?.key || 'warrior'] || 'Warrior Trading — Ross Cameron',
      symbol: (!isOwner && mc.symbol) || env.SYMBOL || 'BTCUSDT',
      timeframe: (!isOwner && mc.timeframe) || env.TIMEFRAME || '4H',
      portfolio: !isOwner ? Number(mc.portfolio || 0) : Number(env.PORTFOLIO_VALUE_USD || 0),
      maxTrade: !isOwner ? Number(mc.maxTrade || 0) : Number(env.MAX_TRADE_SIZE_USD || 0),
      maxPerDay: Number(env.MAX_TRADES_PER_DAY || 0),
      paperTrading: !isOwner ? (mc.paperTrading !== false) : (env.PAPER_TRADING !== 'false'),
      dailyMaxLoss: !isOwner ? Number(mc.dailyMaxLoss || 0) : Number(rules?.risk?.daily_max_loss_usd || 0),
      hasRealKeys,
      // rules.json inteiro só para o dono — contém dados do robô real
      rules: isOwner ? rules : null,
      activePlan: userActivePlan || null,
      activePlans: userActivePlans,
      loopInterval: (!isOwner && mc.loopInterval) || rules?.master_interval || env.MASTERBOT_LOOP_INTERVAL || '1h',
      groupPlans: userPlans.map(p => ({ name: p.name, description: p.description, symbols: p.symbols })),
      watchlist: rules?.watchlist || [],
      watchlistPreset: ['BTCUSDT','ETHUSDT','SOLUSDT','XRPUSDT','LTCUSDT','AVAXUSDT','TRXUSDT'],
    });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── STRATEGY ENDPOINTS ──────────────────────────────────────────
app.get('/api/bot/strategies', authenticateToken, async (req, res) => {
  try {
    // Estratégias isoladas por usuário (antes vazavam via rules.json global)
    const plans = await db.listStrategies(req.user.id);

    // Uma única consulta ao log de trades do próprio usuário para todos os planos
    let allRealTrades = [];
    try {
      const dbRes = await db.loadRecentLog(1000, req.user.id);
      allRealTrades = dbRes.trades || [];
    } catch (err) {
      // banco indisponível: estratégias caem para backtest/sem-dados
    }

    const strategies = plans.map((p) => {
      const active = !!p._active;

      // Sem dados até provar o contrário (fim das estatísticas fake por seed)
      let totalTrades = 0, winRate = 0, profitFactor = 0, netProfit = 0;
      let statsSource = 'sem-dados';

      // Prioridade 2: último backtest real persistido
      if (p.lastBacktest?.combined) {
        const c = p.lastBacktest.combined;
        totalTrades = c.totalTrades;
        winRate = c.winRate;
        profitFactor = c.profitFactor;
        netProfit = c.netProfitUsd;
        statsSource = 'backtest';
      }

      // Prioridade 1: trades reais executados pelo bot (≥5 com PnL)
      const planTrades = allRealTrades.filter(t =>
        (t.plan === p.name ||
         (t.strategy === p.strategy && (p.symbols || []).includes(t.symbol))
        ) && t.orderPlaced
      );
      const tradesWithPnl = planTrades.filter(t => t.pnl != null && t.pnl !== 0);

      // realStats sempre que houver QUALQUER trade real com PnL — permite a
      // comparação "Esperado (backtest) × Realizado" no modal de estatísticas.
      let realStats = null;
      if (tradesWithPnl.length >= 1) {
        const rWins = tradesWithPnl.filter(t => t.pnl > 0);
        const rGains = rWins.reduce((acc, t) => acc + (t.pnl || 0), 0);
        const rLosses = Math.abs(tradesWithPnl.filter(t => t.pnl < 0).reduce((acc, t) => acc + (t.pnl || 0), 0));
        realStats = {
          totalTrades: tradesWithPnl.length,
          winRate: rWins.length / tradesWithPnl.length,
          profitFactor: rLosses > 0 ? rGains / rLosses : (rGains > 0 ? 99 : 0),
          netProfit: tradesWithPnl.reduce((acc, t) => acc + (t.pnl || 0), 0),
        };
      }

      // Os stats do card só trocam para "real" com amostra mínima (≥5 trades)
      if (realStats && realStats.totalTrades >= 5) {
        totalTrades = realStats.totalTrades;
        winRate = realStats.winRate;
        profitFactor = realStats.profitFactor;
        netProfit = realStats.netProfit;
        statsSource = 'real';
      }

      return {
        name: p.name,
        description: p.description || `Estratégia automática para ${p.symbols?.join(', ') || 'ativos'}`,
        symbols: p.symbols || [],
        timeframes: p.timeframes || [],
        strategy: p.strategy || 'warrior',
        mode: p.mode || 'spot',
        leverage: p.leverage || 1,
        active,
        winRate,
        profitFactor,
        netProfit,
        totalTrades,
        statsSource,
        realStats,
        winRateTarget: p.winRateTarget ?? null,
        lastBacktest: p.lastBacktest ?? null,
        filters: p.filters || {},
        sl: p.sl || { type: 'atr', multiplier: 1.5 },
        tp: p.tp || { type: 'atr', multiplier: 2.0 }
      };
    });

    res.json({ success: true, strategies });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/api/bot/strategies', authenticateToken, async (req, res) => {
  try {
    const { name, description, symbols, timeframes, strategy, mode, leverage, sl, tp, filters, winRateTarget, lastBacktest } = req.body;
    if (!name) return res.status(400).json({ success: false, error: 'Nome da estratégia é obrigatório' });

    const newPlan = {
      name,
      description: description || `Estratégia personalizada para ${symbols?.join(', ')}`,
      symbols: symbols || ['BTCUSDT'],
      timeframes: timeframes || ['1H'],
      strategy: strategy || 'warrior',
      mode: mode || 'spot',
      leverage: leverage ? parseInt(leverage) : 1,
      sl: sl || { type: 'atr', multiplier: 1.5 },
      tp: tp || { type: 'atr', multiplier: 2.0 },
      filters: filters || {},
      winRateTarget: winRateTarget != null ? Number(winRateTarget) : null,
      lastBacktest: lastBacktest || null
    };

    await db.upsertStrategy(req.user.id, name, newPlan);

    // Só o dono da conta do bot espelha no rules.json (o bot opera por ele)
    if (await isOwnerUser(req.user.id)) await syncRulesFromOwner(req.user.id);

    res.json({ success: true, strategy: newPlan });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/api/bot/strategies/:name/activate', authenticateToken, async (req, res) => {
  try {
    const { name } = req.params;
    const plans = await db.listStrategies(req.user.id);
    if (!plans.find(p => p.name === name)) {
      return res.status(404).json({ success: false, error: 'Estratégia não encontrada' });
    }

    // Multi-estratégia: ativa ESTA sem desativar as outras
    await db.setStrategyActive(req.user.id, name, true);
    if (await isOwnerUser(req.user.id)) await syncRulesFromOwner(req.user.id);

    res.json({ success: true, activePlan: name, activePlans: await db.getActiveStrategyNames(req.user.id) });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/api/bot/strategies/:name/deactivate', authenticateToken, async (req, res) => {
  try {
    // Multi-estratégia: desativa SÓ a estratégia informada
    await db.setStrategyActive(req.user.id, req.params.name, false);
    if (await isOwnerUser(req.user.id)) await syncRulesFromOwner(req.user.id);

    res.json({ success: true, activePlan: null, activePlans: await db.getActiveStrategyNames(req.user.id) });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.delete('/api/bot/strategies/:name', authenticateToken, async (req, res) => {
  try {
    const { name } = req.params;
    const plans = await db.listStrategies(req.user.id);
    if (!plans.find(p => p.name === name)) {
      return res.status(404).json({ success: false, error: 'Estratégia não encontrada' });
    }

    await db.deleteStrategy(req.user.id, name);
    if (await isOwnerUser(req.user.id)) await syncRulesFromOwner(req.user.id);

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── BACKTEST ────────────────────────────────────────────────────
// Cache de candles em memória (evita martelar a API pública da Binance)
const candleCache = new Map(); // `${symbol}:${tf}` → { candles, fetchedAt }
const CANDLE_TTL_MS = 10 * 60 * 1000;

const BINANCE_INTERVALS = { '1m': '1m', '5m': '5m', '15m': '15m', '30m': '30m', '1H': '1h', '4H': '4h', '1D': '1d' };

async function fetchHistoricalCandles(symbol, timeframe, total = 1400) {
  const key = `${symbol}:${timeframe}:${total}`;
  const cached = candleCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < CANDLE_TTL_MS) return cached.candles;

  const interval = BINANCE_INTERVALS[timeframe] || '1h';
  let candles = [];
  let endTime;
  // Pagina para trás (máx. 1000 por request da Binance)
  while (candles.length < total) {
    const limit = Math.min(1000, total - candles.length);
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`
      + (endTime ? `&endTime=${endTime}` : '');
    const r = await fetch(url);
    if (!r.ok) throw new Error(`Binance ${r.status} para ${symbol} ${timeframe}`);
    const data = await r.json();
    if (!Array.isArray(data) || !data.length) break;
    const page = data.map(k => ({
      time: k[0], open: parseFloat(k[1]), high: parseFloat(k[2]),
      low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]),
    }));
    candles = [...page, ...candles];
    endTime = page[0].time - 1;
    if (data.length < limit) break;
  }
  // Só cacheia histórico completo — resultado curto (falha transitória da
  // Binance) não pode ficar 10 min envenenando o cache
  if (candles.length >= total) {
    candleCache.set(key, { candles, fetchedAt: Date.now() });
  }
  return candles;
}

app.post('/api/bot/backtest', authenticateToken, async (req, res) => {
  try {
    const plan = req.body || {};
    if (!Array.isArray(plan.symbols) || !plan.symbols.length ||
        !Array.isArray(plan.timeframes) || !plan.timeframes.length) {
      return res.status(400).json({ success: false, error: 'symbols e timeframes são obrigatórios' });
    }
    // Limite de carga: máx. 6 combinações símbolo×timeframe por análise
    const combos = [];
    for (const symbol of plan.symbols) {
      for (const timeframe of plan.timeframes) combos.push({ symbol, timeframe });
    }
    if (combos.length > 6) {
      return res.status(400).json({ success: false, error: 'Máximo de 6 combinações ativo×timeframe por análise' });
    }

    const signalFn = createSignalFn(plan);
    const results = [];
    let allTrades = [];

    for (const { symbol, timeframe } of combos) {
      // Cede o event loop entre combos para não congelar os demais endpoints
      await new Promise(r => setImmediate(r));
      try {
        const candles = await fetchHistoricalCandles(symbol, timeframe);
        if (candles.length < 300) {
          results.push({ symbol, timeframe, error: 'Histórico insuficiente', stats: null, trades: [] });
          continue;
        }
        const trades = simulateTrades(candles, signalFn)
          .map(t => ({ ...t, symbol, timeframe }));
        allTrades = allTrades.concat(trades);
        results.push({
          symbol,
          timeframe,
          periodStart: candles[0].time,
          periodEnd: candles[candles.length - 1].time,
          stats: computeStats(trades),
          trades: trades.slice(-10),
        });
      } catch (comboErr) {
        results.push({ symbol, timeframe, error: comboErr.message, stats: null, trades: [] });
      }
    }

    allTrades.sort((a, b) => a.entryTime - b.entryTime);
    const combined = computeStats(allTrades);
    const equityCurve = buildEquityCurve(allTrades);
    const winRateTarget = plan.winRateTarget != null ? Number(plan.winRateTarget) : null;
    const approved = combined && winRateTarget != null
      ? combined.winRate * 100 >= winRateTarget
      : null;

    // Walk-forward 70/30: compara o desempenho dos 70% iniciais do período com
    // os 30% finais. Divergência grande sugere overfitting ou mudança de regime.
    let walkForward = null;
    const periods = results.filter(r => r.periodStart && r.periodEnd);
    if (allTrades.length >= 8 && periods.length) {
      const t0 = Math.min(...periods.map(r => r.periodStart));
      const t1 = Math.max(...periods.map(r => r.periodEnd));
      const splitTime = t0 + (t1 - t0) * 0.7;
      walkForward = {
        splitTime,
        inSample: computeStats(allTrades.filter(t => t.entryTime < splitTime)),
        outOfSample: computeStats(allTrades.filter(t => t.entryTime >= splitTime)),
      };
    }

    const lastBacktest = {
      ranAt: Date.now(),
      combined,
      equityCurve,
      winRateTarget,
      approved,
      feePctPerSide: 0.1,
      walkForward,
      warnings: getPlanWarnings(plan),
      results,
      recentTrades: allTrades.slice(-20),
    };

    // Persiste o backtest na estratégia DO USUÁRIO (no banco), se ela existir
    if (plan.name) {
      try {
        const userPlans = await db.listStrategies(req.user.id);
        const saved = userPlans.find(p => p.name === plan.name);
        if (saved) {
          const { _active, ...planData } = saved;
          planData.lastBacktest = lastBacktest;
          if (winRateTarget != null) planData.winRateTarget = winRateTarget;
          await db.upsertStrategy(req.user.id, plan.name, planData);
          // Reflete no rules.json só se for o dono da conta do bot
          if (await isOwnerUser(req.user.id)) await syncRulesFromOwner(req.user.id);
        }
      } catch { /* persistência best-effort não bloqueia a resposta */ }
    }

    res.json({ success: true, ...lastBacktest });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
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

app.patch('/api/bot/config', authenticateToken, async (req, res) => {
  try {
    const { symbol, timeframe, strategy, portfolio, maxTrade, trailingEnabled, trailingMult, paperTrading, activePlan, dailyMaxLoss, loopInterval } = req.body || {};
    const allowedLoop = ['10m','15m','20m','30m','45m','1h','4h'];
    if (loopInterval !== undefined && !allowedLoop.includes(loopInterval)) {
      return res.status(400).json({ success: false, error: 'Intervalo inválido (use 10m–1h)' });
    }

    // Validations
    const allowedTf = ['1m','5m','15m','30m','1H','4H','1D','1W'];
    const allowedStrat = ['stormer', 'warrior', 'both', 'auto'];
    if (symbol && !/^[A-Z0-9]{3,20}$/.test(symbol)) return res.status(400).json({ success: false, error: 'Símbolo inválido' });
    if (timeframe && !allowedTf.includes(timeframe)) return res.status(400).json({ success: false, error: 'Timeframe inválido' });
    if (strategy && !allowedStrat.includes(strategy)) return res.status(400).json({ success: false, error: 'Estratégia inválida' });

    // O plano ativo é PER-USUÁRIO (vive no banco). Multi-estratégia: passar
    // um nome GARANTE que ele está ativo sem desativar os demais (gerencie
    // as outras na página Estratégias); null desativa todas (modo avulso).
    if (activePlan !== undefined) {
      if (activePlan) await db.setStrategyActive(req.user.id, activePlan, true);
      else await db.setActiveStrategy(req.user.id, null);
    }

    // Persiste a config do MasterBot NA VISÃO DO USUÁRIO (banco). Para o
    // dono ela também vai para .env/rules abaixo (o robô real é dele).
    const st = await db.getUserBotState(req.user.id);
    st.master_config = { ...(st.master_config || {}) };
    if (symbol) st.master_config.symbol = symbol;
    if (timeframe) st.master_config.timeframe = timeframe;
    if (strategy) st.master_config.strategy = strategy;
    if (portfolio !== undefined) st.master_config.portfolio = Number(portfolio);
    if (maxTrade !== undefined) st.master_config.maxTrade = Number(maxTrade);
    if (paperTrading !== undefined) st.master_config.paperTrading = !!paperTrading;
    if (dailyMaxLoss !== undefined) st.master_config.dailyMaxLoss = Number(dailyMaxLoss) || 0;
    if (loopInterval !== undefined) st.master_config.loopInterval = loopInterval;
    await db.saveUserBotState(req.user.id, st);

    // Não-dono: nunca toca .env/rules.json nem reinicia o robô real
    if (!(await isOwnerUser(req.user.id))) {
      return res.json({ success: true, symbol, timeframe, strategy, portfolio, maxTrade, paperTrading, simulated: true });
    }

    // Se .env não existe (Railway), cria um a partir das variáveis de ambiente
    if (!existsSync(BOT_ENV)) {
      const envVars = ['BINANCE_API_KEY','BINANCE_SECRET_KEY','TELEGRAM_BOT_TOKEN','TELEGRAM_CHAT_ID',
        'GEMINI_API_KEY','PAPER_TRADING','MAX_TRADE_SIZE_USD','MAX_TRADES_PER_DAY','SYMBOL','TIMEFRAME',
        'BOT_STRATEGY','PORTFOLIO_VALUE_USD'];
      const content = envVars.filter(k => process.env[k]).map(k => `${k}=${process.env[k]}`).join('\n') + '\n';
      writeFileSync(BOT_ENV, content);
    }

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
    if (loopInterval !== undefined) upsert('MASTERBOT_LOOP_INTERVAL', loopInterval);
    writeFileSync(BOT_ENV, txt);

    // Update rules.json if trailing params, strategy or risk changed.
    // NOTA: maxTrade aqui é exclusivo do MasterBot (MAX_TRADE_SIZE_USD acima).
    // O max_trade_usdt do Micro Scalper tem endpoint próprio (/api/micro-scalper/config).
    if (trailingEnabled !== undefined || trailingMult !== undefined || strategy || dailyMaxLoss !== undefined || loopInterval !== undefined) {
      if (existsSync(BOT_RULES)) {
        const rules = JSON.parse(readFileSync(BOT_RULES, 'utf8'));
        if (loopInterval !== undefined) {
          // O bot re-lê master_interval do rules.json a cada ciclo — aplica
          // sem reiniciar o processo.
          rules.master_interval = loopInterval;
        }
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
        if (dailyMaxLoss !== undefined) {
          if (!rules.risk) rules.risk = {};
          rules.risk.daily_max_loss_usd = parseFloat(dailyMaxLoss) || 0; // 0 = desligado
        }
        writeFileSync(BOT_RULES, JSON.stringify(rules, null, 2));
      }
    }

    // Se quem editou é o dono da conta do bot, reflete group_plans/active_plan
    // do banco no rules.json para o MasterBot real operar a estratégia certa.
    if (activePlan !== undefined && await isOwnerUser(req.user.id)) {
      await syncRulesFromOwner(req.user.id);
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
        try { process.kill(pidToKill, 'SIGTERM'); } catch(e){}
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

// ── EMERGENCY SELL ──────────────────────────────────────────────
/** Liquida todo o saldo spot de um símbolo (cancela ordens + venda a mercado). */
async function liquidateSymbol(client, symbol) {
  try {
    console.log(`  🧹 [${symbol}] Cancelando ordens abertas...`);
    await client.cancelOpenOrders(symbol);
  } catch (e) {
    console.warn(`  ⚠️ [${symbol}] Erro ao cancelar ordens (talvez nenhuma aberta):`, e.message);
  }

  const asset = symbol.replace('USDT', '');
  const account = await client.getAccountInfo();
  const balance = account.balances.find(b => b.asset === asset);
  const qty = parseFloat(balance?.free || 0);

  if (qty <= 0) {
    return { symbol, success: true, msg: `Saldo de ${asset} já está zerado.` };
  }

  // Precisão de quantidade (LOT_SIZE)
  const exInfo = await fetch(`https://api.binance.com/api/v3/exchangeInfo?symbol=${symbol}`).then(r => r.json());
  const filter = exInfo.symbols?.[0]?.filters?.find(f => f.filterType === 'LOT_SIZE');
  const stepSize = parseFloat(filter?.stepSize || '0.00000001');
  const countDecimals = (n) => {
    if (Math.floor(n) === n) return 0;
    const s = n.toString();
    if (s.includes('e-')) return parseInt(s.split('e-')[1]);
    return s.split(".")[1].length || 0;
  };
  const qtyRounded = qty.toFixed(countDecimals(stepSize));

  console.log(`  💰 [${symbol}] Vendendo saldo total: ${qtyRounded} ${asset}`);
  const sellRes = await client.placeMarketSellQty(symbol, qtyRounded);
  if (sellRes.ok) return { symbol, success: true, qty: qtyRounded };
  return { symbol, success: false, error: sellRes.data?.msg || 'Erro na venda da Binance' };
}

app.post('/api/bot/emergency-sell', authenticateToken, async (req, res) => {
  const { symbol } = req.body || {};

  try {
    // Liquida na corretora da CONTA DE QUEM CLICOU — sem auth e com as
    // chaves do .env, qualquer um podia vender a carteira do dono.
    const env = await getBotEnv(req.user.id);
    if (!env.BINANCE_API_KEY || !env.BINANCE_SECRET_KEY) {
      return res.status(400).json({ success: false, error: 'Sua conta ativa não tem chaves de API configuradas' });
    }
    const client = createBinanceClient({
      apiKey: env.BINANCE_API_KEY,
      secretKey: env.BINANCE_SECRET_KEY,
    });
    await client.syncTime();

    // Sem símbolo ("Vender tudo agora"): liquida os símbolos de TODAS as
    // posições abertas da conta do usuário. Antes retornava 400 e o botão
    // de pânico nunca funcionou.
    let symbols;
    if (symbol) {
      symbols = [symbol];
    } else {
      const positions = await db.loadPositions(req.user.id);
      symbols = [...new Set(positions.filter(p => p.status === 'open').map(p => p.symbol))];
      if (symbols.length === 0) {
        return res.json({ success: true, message: 'Nenhuma posição aberta para liquidar.' });
      }
    }

    console.log(`🚨 [EMERGENCY] Liquidação solicitada: ${symbols.join(', ')}`);
    const results = [];
    for (const sym of symbols) {
      try { results.push(await liquidateSymbol(client, sym)); }
      catch (e) { results.push({ symbol: sym, success: false, error: e.message }); }
    }

    const failed = results.filter(r => !r.success);
    res.json({
      success: failed.length === 0,
      message: failed.length === 0
        ? `Liquidação enviada para: ${symbols.join(', ')}`
        : `Falhas em: ${failed.map(f => f.symbol).join(', ')}`,
      results,
    });
  } catch (e) {
    console.error(`❌ [EMERGENCY] Falha crítica na liquidação:`, e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/api/bot/log', authenticateToken, async (req, res) => {
  try {
    const { trades } = await db.loadRecentLog(100, req.user.id);
    res.json({ success: true, trades });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Diagnóstico: retorna últimas linhas do masterbot.log (texto cru)
app.get('/api/bot/master/raw-log', authenticateToken, async (req, res) => {
  try {
    // Log do processo real é do dono — outras contas não têm robô próprio
    if (!(await isOwnerUser(req.user.id))) {
      return res.json({ success: true, lines: [], message: 'Logs do robô disponíveis apenas na conta operadora.' });
    }
    const logFile = join(BOT_DIR, 'masterbot.log');
    if (!existsSync(logFile)) return res.json({ success: true, lines: [], message: 'Log ainda não existe — bot nunca rodou' });
    const text = readFileSync(logFile, 'utf8');
    const lines = text.split('\n').slice(-200);
    res.json({ success: true, lines, totalBytes: text.length });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/bot/run', (_req, res) => {
  if (!existsSync(BOT_DIR)) return res.status(404).json({ success: false, error: 'Pasta do bot não encontrada' });
  const proc = spawn('node', ['bot.js'], { cwd: BOT_DIR, shell: false });
  let stdout = '', stderr = '';
  const timer = setTimeout(() => proc.kill('SIGKILL'), 60000);
  proc.stdout.on('data', d => stdout += d.toString());
  proc.stderr.on('data', d => stderr += d.toString());
  proc.on('close', async code => {
    clearTimeout(timer);
    let last = null;
    try { ({ trades: [last] } = await db.loadRecentLog(1)); } catch { /* ignore */ }
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
  const { symbol, timeframe, side, amount, mode } = req.body || {};
  if (!symbol || !timeframe || !side) return res.status(400).json({ success: false, error: 'symbol, timeframe e side são obrigatórios' });
  
  const env = { 
    ...process.env, 
    FORCE_SYMBOL: symbol, 
    FORCE_TF: timeframe, 
    FORCE_SIDE: side.toUpperCase(), 
    FORCE_MODE: mode === 'futures' ? 'futures' : 'spot',
    FORCE_ONCE: '1',
    PAPER_TRADING: 'false',
    // Se o usuário passar um valor específico, usamos ele via env var que o bot.js pode ler
    MAX_TRADE_SIZE_USD: amount ? String(amount) : (process.env.MAX_TRADE_SIZE_USD || '10'),
    BINANCE_API_KEY: (process.env.BINANCE_API_KEY || '').trim(),
    BINANCE_SECRET_KEY: (process.env.BINANCE_SECRET_KEY || '').trim(),
    DATABASE_URL: process.env.DATABASE_URL
  };
  
  console.log(`⚡ FORÇANDO TRADE: ${symbol} ${side} ${amount ? `($${amount})` : ''} [Mode: ${env.FORCE_MODE}]`);
  const proc = spawn(process.execPath, ['bot.js'], { cwd: BOT_DIR, shell: false, env });
  let stdout = '', stderr = '';
  const timer = setTimeout(() => proc.kill('SIGKILL'), 60000);
  proc.stdout.on('data', d => stdout += d.toString());
  proc.stderr.on('data', d => stderr += d.toString());
  proc.on('close', async code => {
    clearTimeout(timer);
    let last = null;
    try { ({ trades: [last] } = await db.loadRecentLog(1)); } catch {}
    res.json({ success: code === 0, exitCode: code, stdout, stderr, last });
  });
  proc.on('error', err => { clearTimeout(timer); res.status(500).json({ success: false, error: err.message }); });
});

// ── MasterBot Loop Management ────────────────────────────────────

app.get('/api/bot/master/status', authenticateToken, async (req, res) => {
  try {
    // O processo real do MasterBot é único e pertence ao DONO. Outros
    // usuários veem apenas o próprio estado lógico (flag no banco).
    if (!(await isOwnerUser(req.user.id))) {
      const st = await db.getUserBotState(req.user.id);
      const enabled = !!st.master_enabled;
      return res.json({
        success: true,
        status: enabled ? 'waiting' : 'stopped',
        watchlist: [],
        timeframes: [],
        lastResults: [],
        isAlive: enabled,
      });
    }

    let loopState = await db.loadMasterStatus();

    // Check if process is actually alive via PID file or memory
    let isAlive = isProcessAlive(masterProcess);
    
    if (!isAlive && existsSync(BOT_MASTER_PID)) {
      try {
        const pid = parseInt(readFileSync(BOT_MASTER_PID, 'utf8'));
        if (pid) {
          try { process.kill(pid, 0); isAlive = true; } catch { isAlive = false; }
        }
      } catch (e) { isAlive = false; }
    }

    if (!isAlive && loopState.status !== 'stopped') {
      loopState.status = 'stopped';
    }

    res.json({ success: true, ...loopState, isAlive });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/bot/master/config', async (req, res) => {
  try {
    const { interval } = req.body || {};
    const allowedIntervals = ['10m', '15m', '20m', '30m', '45m', '1h', '4h'];
    const safeInterval = allowedIntervals.includes(interval) ? interval : '1h';

    // 1. Atualiza rules.json
    const rules = getRules();
    rules.master_interval = safeInterval;
    writeFileSync(join(ROOT, 'rules.json'), JSON.stringify(rules, null, 2));

    // 2. Atualiza .env (só existe localmente; no Railway o var vem de process.env)
    if (existsSync(BOT_ENV)) {
      let txt = readFileSync(BOT_ENV, 'utf8');
      const re = /^MASTERBOT_LOOP_INTERVAL=.*$/m;
      if (re.test(txt)) txt = txt.replace(re, `MASTERBOT_LOOP_INTERVAL=${safeInterval}`);
      else txt += (txt.endsWith('\n') ? '' : '\n') + `MASTERBOT_LOOP_INTERVAL=${safeInterval}\n`;
      writeFileSync(BOT_ENV, txt);
    }

    // 3. Atualiza master-status.json para refletir na UI imediatamente
    try {
      const status = await db.loadMasterStatus();
      status.interval = safeInterval;
      await db.writeMasterStatus(status);
    } catch (e) {}

    res.json({ success: true, interval: safeInterval });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/api/bot/master/start', authenticateToken, async (req, res) => {
  try {
    // Não-dono: liga apenas o estado lógico DELE — nunca o processo real
    if (!(await isOwnerUser(req.user.id))) {
      await setUserBotFlag(req.user.id, 'master_enabled', true);
      return res.json({ success: true, simulated: true });
    }

    const { interval } = req.body || {};
    const allowedIntervals = ['10m', '15m', '20m', '30m', '45m', '1h', '4h'];
    const safeInterval = allowedIntervals.includes(interval) ? interval : '1h';

    // Matar qualquer instância anterior pelo PID file antes de iniciar nova
    if (existsSync(BOT_MASTER_PID)) {
      const oldPid = parseInt(readFileSync(BOT_MASTER_PID, 'utf8'));
      if (oldPid) {
        try { process.kill(oldPid, 'SIGTERM'); } catch {}
      }
      unlinkSync(BOT_MASTER_PID);
    }
    if (isProcessAlive(masterProcess)) {
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
    const logFile = join(BOT_DIR, 'masterbot.log');
    const out = openSync(logFile, 'a');
    const err = openSync(logFile, 'a');

    masterProcess = spawn('node', ['bot.js', '--master'], {
      cwd: BOT_DIR,
      detached: true,
      stdio: ['ignore', out, err],
      env: { ...process.env, MASTERBOT_LOOP_INTERVAL: safeInterval }
    });

    masterProcess.on('error', (e) => console.error(`❌ MasterBot spawn error: ${e.message}`));
    masterProcess.on('exit', (code, signal) => console.log(`⚠️ MasterBot exited code=${code} signal=${signal}`));

    if (masterProcess.pid) {
      writeFileSync(BOT_MASTER_PID, masterProcess.pid.toString());
    }

    masterProcess.unref();

    // Aguarda 500ms e verifica se ainda está vivo (detecta crash imediato)
    setTimeout(() => {
      try { process.kill(masterProcess.pid, 0); }
      catch { console.error(`❌ MasterBot morreu logo após start. Veja /api/bot/master/raw-log`); }
    }, 500);

    res.json({ success: true, pid: masterProcess.pid });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/bot/master/stop', authenticateToken, async (req, res) => {
  try {
    // Não-dono: desliga apenas o estado lógico DELE — nunca o processo real
    if (!(await isOwnerUser(req.user.id))) {
      await setUserBotFlag(req.user.id, 'master_enabled', false);
      return res.json({ success: true, simulated: true });
    }

    let pidToKill = masterProcess?.pid;

    if (!pidToKill && existsSync(BOT_MASTER_PID)) {
      pidToKill = parseInt(readFileSync(BOT_MASTER_PID, 'utf8'));
    }

    if (pidToKill) {
      console.log(`🛑 Matando MasterBot (PID: ${pidToKill})...`);
      try { process.kill(pidToKill, 'SIGTERM'); } catch (e) { console.log('Processo já estava morto:', e.message); }
    }

    masterProcess = null;
    if (existsSync(BOT_MASTER_PID)) unlinkSync(BOT_MASTER_PID);

    // Atualiza o status no banco para que a UI saiba que parou
    try {
      const state = await db.loadMasterStatus();
      state.status = 'stopped';
      state.nextRun = null;
      await db.writeMasterStatus(state);
    } catch (e) { console.error('Erro ao limpar status:', e); }

    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── FuturesBot Loop Management ───────────────────────────────────

app.get('/api/bot/futures/status', authenticateToken, async (req, res) => {
  try {
    // Processo real é único (do dono); demais usuários veem o próprio flag
    if (!(await isOwnerUser(req.user.id))) {
      const st = await db.getUserBotState(req.user.id);
      const enabled = !!st.futures_enabled;
      return res.json({
        success: true,
        status: enabled ? 'waiting' : 'stopped',
        watchlist: [],
        timeframes: [],
        lastResults: [],
        isAlive: enabled,
      });
    }

    let loopState = await db.loadFuturesStatus();

    let isAlive = isProcessAlive(futuresProcess);
    
    if (!isAlive && existsSync(BOT_FUTURES_PID)) {
      try {
        const pid = parseInt(readFileSync(BOT_FUTURES_PID, 'utf8'));
        if (pid) {
          try { process.kill(pid, 0); isAlive = true; } catch { isAlive = false; }
        }
      } catch (e) { isAlive = false; }
    }

    if (!isAlive) {
      if (loopState.status !== 'stopped') {
        loopState.status = 'stopped';
        // Atualiza a persistência real no banco para limpar o status pendente/crachado
        try { await db.writeFuturesStatus(loopState); } catch (_) {}
      }
      // Limpa PID zumbi para evitar conflitos no start e 'Connection Refused'
      if (existsSync(BOT_FUTURES_PID)) {
        try { unlinkSync(BOT_FUTURES_PID); } catch (_) {}
      }
    }

    res.json({ success: true, ...loopState, isAlive });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Watchdog Keep-Alive Automático: monitora a saúde e religa os bots em caso de queda
setInterval(async () => {
  // 1. Watchdog FuturesBot
  try {
    const fState = await db.loadFuturesStatus();
    if (fState && (fState.status === 'running' || fState.status === 'waiting')) {
      let isAlive = isProcessAlive(futuresProcess);
      if (!isAlive && existsSync(BOT_FUTURES_PID)) {
        try {
          const pid = parseInt(readFileSync(BOT_FUTURES_PID, 'utf8'));
          if (pid) { try { process.kill(pid, 0); isAlive = true; } catch { isAlive = false; } }
        } catch {}
      }
      if (!isAlive) {
        console.log(`⚠️  [Watchdog] FuturesBot inativo detectado! O processo encerrou inesperadamente. Religa automática iniciada...`);
        if (existsSync(BOT_FUTURES_PID)) try { unlinkSync(BOT_FUTURES_PID); } catch {}
        futuresProcess = null;
        
        const logFile = join(BOT_DIR, 'futuresbot.log');
        const out = openSync(logFile, 'a');
        const err = openSync(logFile, 'a');
        futuresProcess = spawn('node', ['bot.js', '--futures'], {
          cwd: BOT_DIR, detached: true, stdio: ['ignore', out, err], env: { ...process.env }
        });
        if (futuresProcess.pid) writeFileSync(BOT_FUTURES_PID, futuresProcess.pid.toString());
        futuresProcess.unref();
      }
    }
  } catch (err) {}

  // 2. Watchdog MasterBot
  try {
    const mState = await db.loadMasterStatus();
    if (mState && (mState.status === 'running' || mState.status === 'waiting')) {
      let isAlive = isProcessAlive(masterProcess);
      if (!isAlive && existsSync(BOT_MASTER_PID)) {
        try {
          const pid = parseInt(readFileSync(BOT_MASTER_PID, 'utf8'));
          if (pid) { try { process.kill(pid, 0); isAlive = true; } catch { isAlive = false; } }
        } catch {}
      }
      if (!isAlive) {
        console.log(`⚠️  [Watchdog] MasterBot inativo detectado! O processo encerrou inesperadamente. Religa automática iniciada...`);
        if (existsSync(BOT_MASTER_PID)) try { unlinkSync(BOT_MASTER_PID); } catch {}
        masterProcess = null;

        const intervalStr = mState.interval || process.env.MASTERBOT_LOOP_INTERVAL || '10m';
        const logFile = join(BOT_DIR, 'masterbot.log');
        const out = openSync(logFile, 'a');
        const err = openSync(logFile, 'a');
        masterProcess = spawn('node', ['bot.js', '--master'], {
          cwd: BOT_DIR, detached: true, stdio: ['ignore', out, err],
          env: { ...process.env, MASTERBOT_LOOP_INTERVAL: intervalStr }
        });
        masterProcess.on('error', (e) => console.error(`❌ [Watchdog] MasterBot respawn error: ${e.message}`));
        masterProcess.on('exit', (code, signal) => console.log(`⚠️ [Watchdog] MasterBot respawned exited code=${code} signal=${signal}`));
        if (masterProcess.pid) writeFileSync(BOT_MASTER_PID, masterProcess.pid.toString());
        masterProcess.unref();
        console.log(`✅ [Watchdog] MasterBot relgado com PID ${masterProcess.pid} | intervalo: ${intervalStr}`);
      }
    }
  } catch (err) {}

  // 3. Watchdog Micro-Scalper
  try {
    const microPidPath = join(ROOT, '.micro-scalper.pid');
    const microScriptPath = join(ROOT, 'micro-scalper.js');
    if (existsSync(microPidPath)) {
      let isAlive = false;
      try {
        const pid = parseInt(readFileSync(microPidPath, 'utf8'));
        if (pid) { try { process.kill(pid, 0); isAlive = true; } catch { isAlive = false; } }
      } catch {}
      
      if (!isAlive) {
        console.log(`⚠️  [Watchdog] Micro-Scalper inativo detectado! O processo encerrou inesperadamente. Religa automática iniciada...`);
        try { unlinkSync(microPidPath); } catch {}
        
        if (existsSync(microScriptPath)) {
          const child = spawn('node', [microScriptPath], {
            cwd: ROOT, detached: true, stdio: 'ignore', env: { ...process.env }
          });
          if (child.pid) writeFileSync(microPidPath, child.pid.toString());
          child.unref();
        }
      }
    }
  } catch (err) {}
}, 30000);

app.post('/api/bot/futures/start', authenticateToken, async (req, res) => {
  try {
    // Não-dono: liga apenas o estado lógico DELE — nunca o processo real
    if (!(await isOwnerUser(req.user.id))) {
      await setUserBotFlag(req.user.id, 'futures_enabled', true);
      return res.json({ success: true, simulated: true });
    }

    if (existsSync(BOT_FUTURES_PID)) {
      const oldPid = parseInt(readFileSync(BOT_FUTURES_PID, 'utf8'));
      if (oldPid) {
        try { process.kill(oldPid, 'SIGTERM'); } catch {}
      }
      unlinkSync(BOT_FUTURES_PID);
    }
    if (isProcessAlive(futuresProcess)) {
      try { futuresProcess.kill('SIGTERM'); } catch {}
      futuresProcess = null;
    }

    console.log(`🚀 Iniciando FuturesBot independente em modo LOOP (--futures)...`);
    const logFile = join(BOT_DIR, 'futuresbot.log');
    const out = openSync(logFile, 'a');
    const err = openSync(logFile, 'a');

    futuresProcess = spawn('node', ['bot.js', '--futures'], {
      cwd: BOT_DIR,
      detached: true,
      stdio: ['ignore', out, err],
      env: { ...process.env }
    });

    futuresProcess.on('error', (e) => console.error(`❌ FuturesBot spawn error: ${e.message}`));
    futuresProcess.on('exit', (code, signal) => console.log(`⚠️ FuturesBot exited code=${code} signal=${signal}`));

    if (futuresProcess.pid) {
      writeFileSync(BOT_FUTURES_PID, futuresProcess.pid.toString());
    }

    futuresProcess.unref();

    setTimeout(() => {
      try { process.kill(futuresProcess.pid, 0); }
      catch { console.error(`❌ FuturesBot morreu logo após start.`); }
    }, 500);

    res.json({ success: true, pid: futuresProcess.pid });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/bot/futures/stop', authenticateToken, async (req, res) => {
  try {
    // Não-dono: desliga apenas o estado lógico DELE — nunca o processo real
    if (!(await isOwnerUser(req.user.id))) {
      await setUserBotFlag(req.user.id, 'futures_enabled', false);
      return res.json({ success: true, simulated: true });
    }

    let pidToKill = futuresProcess?.pid;

    if (!pidToKill && existsSync(BOT_FUTURES_PID)) {
      pidToKill = parseInt(readFileSync(BOT_FUTURES_PID, 'utf8'));
    }

    if (pidToKill) {
      console.log(`🛑 Matando FuturesBot (PID: ${pidToKill})...`);
      try { process.kill(pidToKill, 'SIGTERM'); } catch (e) { console.log('Processo já estava morto:', e.message); }
    }

    futuresProcess = null;
    if (existsSync(BOT_FUTURES_PID)) unlinkSync(BOT_FUTURES_PID);

    try {
      const state = await db.loadFuturesStatus();
      state.status = 'stopped';
      state.nextRun = null;
      await db.writeFuturesStatus(state);
    } catch (e) { console.error('Erro ao limpar status de futuros:', e); }

    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── POSITIONS ────────────────────────────────────────────────────

async function syncPositionsWithBinance(env, userId = null) {
  const apiKey = env.BINANCE_API_KEY || env.BITGET_API_KEY;
  const secretKey = env.BINANCE_SECRET_KEY || env.BITGET_SECRET_KEY;
  if (!apiKey || !secretKey || env.PAPER_TRADING === 'true') return { synced: 0, details: [] };

  const positions = await db.loadPositions(userId);
  if (positions.length === 0) return { synced: 0, details: [] };
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
          let filledOrder = (data.orderReports || []).find(o => o.status === 'FILLED');
          
          // Se não veio no report, busca cada ordem individualmente
          if (!filledOrder && data.orders) {
            for (const ord of data.orders) {
              try {
                const oTs = (await (await fetch('https://api.binance.com/api/v3/time')).json()).serverTime;
                const oQs = `symbol=${pos.symbol}&orderId=${ord.orderId}&timestamp=${oTs}&recvWindow=10000`;
                const oSig = crypto.createHmac('sha256', secretKey).update(oQs).digest('hex');
                const oData = await (await fetch(`https://api.binance.com/api/v3/order?${oQs}&signature=${oSig}`, {
                  headers: { 'X-MBX-APIKEY': apiKey }
                })).json();
                if (oData.status === 'FILLED') {
                  filledOrder = oData;
                  break;
                }
              } catch (e) {}
            }
          }

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
            // ALL_DONE sem FILLED → OCO cancelada inteira (tentativa de buscar preço atual para não zerar PnL)
            let currentPrice = pos.entryPrice;
            try {
              const ticker = await (await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${pos.symbol}`)).json();
              currentPrice = parseFloat(ticker.price) || pos.entryPrice;
            } catch (e) {}
            
            pos.status = 'closed'; pos.closedAt = new Date().toISOString();
            pos.exitReason = 'OCO encerrada/cancelada (usando preço atual)';
            pos.exitPrice = currentPrice;
            pos.pnl = parseFloat(((currentPrice - pos.entryPrice) * pos.quantity).toFixed(4));
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

  if (synced > 0) await db.savePositions(positions, userId);
  return { synced, details };
}

app.get('/api/bot/positions', authenticateToken, async (req, res) => {
  try {
    const positions = await db.loadPositions(req.user.id);
    res.json({ success: true, positions });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── Reconciliação: confere as posições do banco contra a Binance ────────────
// Fecha registros fantasma (saldo inexistente), aponta posições sem OCO de
// proteção e lista saldos relevantes sem posição registrada.
app.post('/api/bot/reconcile', authenticateToken, async (req, res) => {
  try {
    const apiKey = process.env.BINANCE_API_KEY, secretKey = process.env.BINANCE_SECRET_KEY;
    if (!apiKey || !secretKey) return res.status(400).json({ success: false, error: 'Chaves Binance não configuradas' });
    const sign = (qs) => qs + '&signature=' + crypto.createHmac('sha256', secretKey).update(qs).digest('hex');
    const H = { headers: { 'X-MBX-APIKEY': apiKey } };

    const positions = await db.loadPositions(req.user.id);
    const open = positions.filter(p => p.status === 'open');
    const report = { checked: open.length, ghostsClosed: [], missingOco: [], ok: [], untracked: [] };

    const acct = await (await fetch(`https://api.binance.com/api/v3/account?${sign('timestamp=' + Date.now())}`, H)).json();
    const balances = Array.isArray(acct.balances) ? acct.balances : [];
    const balOf = (asset) => {
      const b = balances.find(x => x.asset === asset);
      return b ? parseFloat(b.free) + parseFloat(b.locked) : 0;
    };

    const closeGhost = async (pos, motivo) => {
      pos.status = 'closed';
      pos.closedAt = new Date().toISOString();
      pos.exitReason = `Reconciliação: ${motivo}`;
      pos.exitPrice = pos.entryPrice;
      pos.pnl = pos.pnl ?? 0;
      await db.savePosition(pos, req.user.id);
      report.ghostsClosed.push(`${pos.symbol} (${pos.id})`);
    };

    for (const pos of open) {
      const isFut = pos.mode === 'futures' || (pos.plan || '').includes('Futures');
      if (isFut) {
        const risk = await (await fetch(`https://fapi.binance.com/fapi/v2/positionRisk?${sign(`symbol=${pos.symbol}&timestamp=${Date.now()}`)}`, H)).json();
        const amt = Array.isArray(risk) ? parseFloat(risk.find(r => r.symbol === pos.symbol)?.positionAmt || 0) : 0;
        if (amt === 0) await closeGhost(pos, 'posição de futuros inexistente na exchange');
        else report.ok.push(pos.symbol);
      } else {
        const baseAsset = pos.symbol.replace(/USDT$/, '');
        const held = balOf(baseAsset);
        if (held < pos.quantity * 0.9) {
          await closeGhost(pos, `saldo na exchange (${held}) não cobre a posição (${pos.quantity})`);
        } else {
          const oo = await (await fetch(`https://api.binance.com/api/v3/openOrders?${sign(`symbol=${pos.symbol}&timestamp=${Date.now()}`)}`, H)).json();
          if (!Array.isArray(oo) || oo.length === 0) report.missingOco.push(pos.symbol);
          else report.ok.push(pos.symbol);
        }
      }
    }

    // Saldos relevantes (> $5) sem posição registrada
    const openBaseAssets = new Set(
      positions.filter(p => p.status === 'open').map(p => p.symbol.replace(/USDT$/, ''))
    );
    for (const b of balances) {
      const total = parseFloat(b.free) + parseFloat(b.locked);
      if (total <= 0 || ['USDT', 'BNB', 'BUSD', 'FDUSD', 'BRL'].includes(b.asset) || openBaseAssets.has(b.asset)) continue;
      try {
        const pr = await (await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${b.asset}USDT`)).json();
        const valueUsd = total * parseFloat(pr.price || 0);
        if (valueUsd > 5) report.untracked.push({ asset: b.asset, qty: total, valueUsd: Math.round(valueUsd * 100) / 100 });
      } catch { /* par sem USDT: ignora */ }
    }

    res.json({ success: true, ...report });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/bot/positions/sync', authenticateToken, async (req, res) => {
  try {
    const activeAcc = await db.getActiveAccount(req.user.id);
    if (!activeAcc) return res.status(400).json({ success: false, error: 'Nenhuma conta ativa configurada' });

    const apiKey = activeAcc.api_key;
    const secretKey = activeAcc.secret_key;

    // Se não há posições no banco, cria do zero a partir dos saldos reais da Binance
    const existingPositions = await db.loadPositions(req.user.id);
    if (existingPositions.length === 0) {
      const ts = (await (await fetch('https://api.binance.com/api/v3/time')).json()).serverTime;
      const qs = `timestamp=${ts}&recvWindow=10000`;
      const sig = crypto.createHmac('sha256', secretKey).update(qs).digest('hex');
      const acct = await (await fetch(`https://api.binance.com/api/v3/account?${qs}&signature=${sig}`, {
        headers: { 'X-MBX-APIKEY': apiKey }
      })).json();

      if (acct.code) return res.status(400).json({ success: false, error: acct.msg });

      const balances = (acct.balances || []).filter(b => {
        const qty = parseFloat(b.free) + parseFloat(b.locked);
        return qty > 0 && b.asset !== 'USDT' && b.asset !== 'BNB';
      });

      const newPositions = [];
      for (const b of balances) {
        const symbol = b.asset + 'USDT';
        try {
          const ticker = await (await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`)).json();
          const price = parseFloat(ticker.price);
          const qty = parseFloat(b.free) + parseFloat(b.locked);
          if (!price || qty * price < 1) continue;

          newPositions.push({
            id: `POS-SYNC-${Date.now()}-${b.asset}`,
            symbol, side: 'LONG',
            entryPrice: price,
            quantity: qty,
            stopPrice: null, takeProfitPrice: null,
            ocoPlaced: parseFloat(b.locked) > 0,
            status: 'open',
            strategy: 'sync',
            openedAt: new Date().toISOString(),
            indicators: {}, conditions: [],
            note: 'Importado via Sincronizar Binance'
          });
        } catch {}
      }

      await db.savePositions(newPositions, req.user.id);
      return res.json({ success: true, synced: newPositions.length, created: newPositions.length, details: newPositions.map(p => p.symbol) });
    }

    // Posições existem: atualiza status
    const env = existsSync(BOT_ENV) ? parseEnv(readFileSync(BOT_ENV, 'utf8')) : { BINANCE_API_KEY: apiKey, BINANCE_SECRET_KEY: secretKey };
    const result = await syncPositionsWithBinance({ ...env, BINANCE_API_KEY: apiKey, BINANCE_SECRET_KEY: secretKey }, req.user.id);
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

const fallbacksFutures = {
  BTCUSDT: { price: 1, qty: 3 },
  ETHUSDT: { price: 2, qty: 2 },
  SOLUSDT: { price: 3, qty: 0 },
  XRPUSDT: { price: 4, qty: 0 },
  ADAUSDT: { price: 4, qty: 0 },
  AVAXUSDT: { price: 3, qty: 0 },
  LINKUSDT: { price: 3, qty: 2 },
  DOGEUSDT: { price: 5, qty: 0 },
  BNBUSDT: { price: 2, qty: 2 }
};

function isFuturesPosition(pos) {
  if (pos.mode === 'futures') return true;
  if (pos.plan && pos.plan.toLowerCase().includes('futures')) return true;
  if (pos.strategy && pos.strategy.toLowerCase().includes('futures')) return true;
  try {
    const rules = JSON.parse(readFileSync(BOT_RULES, 'utf8'));
    const planObj = (rules?.group_plans || []).find(p => p.name === pos.plan);
    if (planObj && planObj.mode === 'futures') return true;
    const inFuturesPlan = (rules?.group_plans || []).some(p => p.mode === 'futures' && p.symbols?.includes(pos.symbol));
    const inSpotPlan = (rules?.group_plans || []).some(p => p.mode !== 'futures' && p.symbols?.includes(pos.symbol));
    if (inFuturesPlan && !inSpotPlan) return true;
  } catch(e) {}
  return false;
}

app.post('/api/bot/positions/:id/close', authenticateToken, async (req, res) => {
  try {
    const positions = await db.loadPositions(req.user.id);
    const pos = positions.find(p => p.id === req.params.id && p.status === 'open');
    if (!pos) return res.status(404).json({ success: false, error: 'Posição não encontrada ou já fechada' });

    const env = await getBotEnv(req.user.id);
    const apiKey = env.BINANCE_API_KEY || env.BITGET_API_KEY;
    const secretKey = env.BINANCE_SECRET_KEY || env.BITGET_SECRET_KEY;
    const paperTrading = env.PAPER_TRADING !== 'false';
    const markOnly = req.query.markOnly === 'true';
    const isFut = isFuturesPosition(pos);

    // Buscar preço atual
    let exitPrice = null;
    try {
      const baseUrl = isFut ? 'https://fapi.binance.com/fapi/v1' : 'https://api.binance.com/api/v3';
      const pr = await fetch(`${baseUrl}/ticker/price?symbol=${pos.symbol}`);
      exitPrice = parseFloat((await pr.json()).price);
    } catch(e) {}

    let exitOrderId = null;

    if (!markOnly && !paperTrading && apiKey && secretKey) {
      if (isFut) {
        // --- FECHAR POSIÇÃO FUTUROS ---
        const fb = fallbacksFutures[pos.symbol] || { price: 4, qty: 2 };
        let pQty = fb.qty;
        try {
          const resInfo = await fetch(`https://fapi.binance.com/fapi/v1/exchangeInfo?symbol=${pos.symbol}`);
          const dInfo = await resInfo.json();
          const info = (dInfo.symbols || []).find(s => s.symbol === pos.symbol);
          if (info) {
            const lf = info.filters.find(f => f.filterType === 'LOT_SIZE');
            if (lf && lf.stepSize) {
              const str = lf.stepSize.toString().trim().replace(/0+$/, '');
              pQty = str.includes('.') ? str.split('.')[1].length : 0;
            }
          }
        } catch(e) {}

        const qtyRounded = parseFloat(pos.quantity.toFixed(pQty));
        const timeRes = await fetch('https://fapi.binance.com/fapi/v1/time');
        const timestamp = (timeRes.ok) ? (await timeRes.json()).serverTime : Date.now();
        const closeSide = pos.side === 'LONG' ? 'SELL' : 'BUY';
        const qs = `symbol=${pos.symbol}&side=${closeSide}&type=MARKET&quantity=${qtyRounded}&recvWindow=10000&timestamp=${timestamp}`;
        const sig = crypto.createHmac('sha256', secretKey).update(qs).digest('hex');
        const sellRes = await fetch(`https://fapi.binance.com/fapi/v1/order?${qs}&signature=${sig}`, {
          method: 'POST', headers: { 'X-MBX-APIKEY': apiKey }
        });
        const sellData = await sellRes.json();
        if (sellData.code && sellData.code < 0) {
          return res.status(400).json({ success: false, error: `Binance Futures Close falhou: [${sellData.code}] ${sellData.msg}` });
        }
        exitOrderId = String(sellData.orderId);
        exitPrice = parseFloat(sellData.avgPrice) || exitPrice;
      } else {
        // --- FECHAR POSIÇÃO SPOT ---
        if (pos.ocoOrderListId && !pos.ocoManual) {
          try {
            const timeRes = await fetch('https://api.binance.com/api/v3/time');
            const ts = (await timeRes.json()).serverTime;
            const qs = `symbol=${pos.symbol}&orderListId=${pos.ocoOrderListId}&timestamp=${ts}&recvWindow=10000`;
            const sig = crypto.createHmac('sha256', secretKey).update(qs).digest('hex');
            await fetch(`https://api.binance.com/api/v3/orderList?${qs}&signature=${sig}`, { method: 'DELETE', headers: { 'X-MBX-APIKEY': apiKey } });
            // Aguardar 1500ms para a Binance processar o cancelamento e atualizar o saldo
            await new Promise(r => setTimeout(r, 1500));
          } catch(e) {}
        }

        const baseAsset = pos.symbol.endsWith('USDT') ? pos.symbol.slice(0, -4)
                        : pos.symbol.endsWith('BTC')  ? pos.symbol.slice(0, -3)
                        : pos.symbol.slice(0, -4);
        let actualBalance = parseFloat((pos.quantity * 0.999).toFixed(8));
        try {
          const tsRes = await fetch('https://api.binance.com/api/v3/time');
          const tsNow = (await tsRes.json()).serverTime;
          const qsAcc = `timestamp=${tsNow}`;
          const sigAcc = crypto.createHmac('sha256', secretKey).update(qsAcc).digest('hex');
          const accRes = await fetch(`https://api.binance.com/api/v3/account?${qsAcc}&signature=${sigAcc}`, { headers: { 'X-MBX-APIKEY': apiKey } });
          const accData = await accRes.json();
          const bal = accData.balances?.find(b => b.asset === baseAsset);
          if (bal && parseFloat(bal.free) > 0) actualBalance = parseFloat(bal.free);
        } catch(e) {}

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
      }
    } else {
      exitOrderId = markOnly ? 'MARKED-CLOSED' : `PAPER-SELL-${Date.now()}`;
    }

    const reason = markOnly ? 'Marcado como fechado manualmente (sem ordem)' : 'Fechamento manual pelo dashboard';
    pos.status = 'closed';
    pos.closedAt = new Date().toISOString();
    pos.exitPrice = exitPrice;
    pos.exitReason = reason;
    pos.exitOrderId = exitOrderId;
    pos.pnl = exitPrice ? parseFloat(((exitPrice - pos.entryPrice) * (pos.side === 'SHORT' ? -1 : 1) * pos.quantity).toFixed(4)) : null;

    await db.savePosition(pos, req.user.id);
    res.json({ success: true, position: pos });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── PLACE OCO / STOP FOR EXISTING POSITION ─────────────────────────────
app.post('/api/bot/positions/:id/oco', authenticateToken, async (req, res) => {
  try {
    const positions = await db.loadPositions(req.user.id);
    const pos = positions.find(p => p.id === req.params.id && p.status === 'open');
    if (!pos) return res.status(404).json({ success: false, error: 'Posição não encontrada' });

    const env = await getBotEnv(req.user.id);
    const apiKey = env.BINANCE_API_KEY || env.BITGET_API_KEY;
    const secretKey = env.BINANCE_SECRET_KEY || env.BITGET_SECRET_KEY;
    if (!apiKey || !secretKey) return res.status(400).json({ success: false, error: 'Sem credenciais da Binance' });

    const { stopPrice, takeProfitPrice } = pos;
    if (!stopPrice || !takeProfitPrice) return res.status(400).json({ success: false, error: 'Stop ou TP não definidos na posição' });

    const isFut = isFuturesPosition(pos);
    if (isFut) {
      // --- ATRELAR STOP E TP EM FUTUROS ---
      const fb = fallbacksFutures[pos.symbol] || { price: 4, qty: 2 };
      let pPrice = fb.price;
      let pQty = fb.qty;
      try {
        const resInfo = await fetch(`https://fapi.binance.com/fapi/v1/exchangeInfo?symbol=${pos.symbol}`);
        const dInfo = await resInfo.json();
        const info = (dInfo.symbols || []).find(s => s.symbol === pos.symbol);
        if (info) {
          const pf = info.filters.find(f => f.filterType === 'PRICE_FILTER');
          if (pf && pf.tickSize) {
            const str = pf.tickSize.toString().trim().replace(/0+$/, '');
            pPrice = str.includes('.') ? str.split('.')[1].length : 0;
          }
          const lf = info.filters.find(f => f.filterType === 'LOT_SIZE');
          if (lf && lf.stepSize) {
            const str = lf.stepSize.toString().trim().replace(/0+$/, '');
            pQty = str.includes('.') ? str.split('.')[1].length : 0;
          }
        }
      } catch(e) {}

      const slPriceStr = stopPrice.toFixed(pPrice);
      const tpPriceStr = takeProfitPrice.toFixed(pPrice);
      const qtyRounded = pos.quantity.toFixed(pQty);
      const closeSide = pos.side === 'LONG' ? 'SELL' : 'BUY';

      // 1. O Stop Loss não será enviado para a Binance (evita erro -4120 de restrição regional)
      // O bot.js monitorará o preço e fechará a mercado se bater no Stop.
      console.log(`  ℹ [${pos.symbol}] SL de Futuros será monitorado localmente pelo robô para evitar erro -4120.`);
      let orderIdSL = 'LOCAL_WATCHDOG';

      // 2. Tenta Take Profit (LIMIT padrão) - Sem reduceOnly para evitar erro -2022
      const t2 = Date.now();
      let qsTP = `symbol=${pos.symbol}&side=${closeSide}&type=LIMIT&price=${tpPriceStr}&quantity=${qtyRounded}&timeInForce=GTC&recvWindow=10000&timestamp=${t2}`;
      let sigTP = crypto.createHmac('sha256', secretKey).update(qsTP).digest('hex');
      let resTP = await fetch(`https://fapi.binance.com/fapi/v1/order?${qsTP}&signature=${sigTP}`, { method: 'POST', headers: { 'X-MBX-APIKEY': apiKey } });
      let dataTP = await resTP.json();
      if (dataTP.code && dataTP.code < 0) {
        return res.status(400).json({ success: false, error: `Take Profit Futures falhou: [${dataTP.code}] ${dataTP.msg}` });
      }

      pos.ocoPlaced = true;
      pos.ocoOrderListId = `FUT-TP-${dataTP.orderId || Date.now()}`;
      pos.ocoManual = true;
      pos.slManagedLocally = true; // Ativa o monitoramento local no bot.js para contornar erro -4120
      await db.savePosition(pos, req.user.id);
      return res.json({ success: true, orderListId: pos.ocoOrderListId, message: 'Take Profit enviado para Binance. Stop Loss monitorado localmente pelo robô.' });
    }

    // --- COLOCAR OCO SPOT (Lógica inalterada) ---
    const stepSize = await getStepSize(pos.symbol);
    const tsA = (await (await fetch('https://api.binance.com/api/v3/time')).json()).serverTime;
    const qsA = `timestamp=${tsA}`;
    const sigA = crypto.createHmac('sha256', secretKey).update(qsA).digest('hex');
    const accData = await (await fetch(`https://api.binance.com/api/v3/account?${qsA}&signature=${sigA}`, { headers: { 'X-MBX-APIKEY': apiKey } })).json();
    const bal = accData.balances?.find(b => pos.symbol.startsWith(b.asset));
    const actualQty = bal ? parseFloat(bal.free) : pos.quantity;
    const qty = floorToStep(Math.min(pos.quantity, actualQty), stepSize);
    if (qty <= 0) return res.status(400).json({ success: false, error: 'Saldo zero na carteira Spot' });

    const tickRes = await fetch(`https://api.binance.com/api/v3/exchangeInfo?symbol=${pos.symbol}`);
    const tickData = await tickRes.json();
    const priceFilter = tickData.symbols?.[0]?.filters?.find(f => f.filterType === 'PRICE_FILTER');
    const tickSize = priceFilter?.tickSize || '0.00001';
    const tickerRes = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${pos.symbol}`);
    const tickerData = await tickerRes.json();
    const currentPrice = parseFloat(tickerData.price);

    function floorTick(price) {
      const tick = parseFloat(tickSize);
      const dec = tickSize.replace(/0+$/, '').split('.')[1]?.length || 0;
      return parseFloat((Math.floor(price / tick) * tick).toFixed(dec));
    }
    function ceilTick(price) {
      const tick = parseFloat(tickSize);
      const dec = tickSize.replace(/0+$/, '').split('.')[1]?.length || 0;
      return parseFloat((Math.ceil(price / tick) * tick).toFixed(dec));
    }

    let tpPrice  = floorTick(takeProfitPrice);
    let spPrice  = floorTick(stopPrice);
    let slpPrice = floorTick(stopPrice * 0.998);

    if (tpPrice <= currentPrice) tpPrice = ceilTick(currentPrice * 1.0005);
    if (spPrice >= currentPrice) spPrice = floorTick(currentPrice * 0.9995);
    if (slpPrice > spPrice) slpPrice = spPrice;

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
    await db.savePosition(pos, req.user.id);
    res.json({ success: true, orderListId: ocoData.orderListId });
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── DASHBOARD SUMMARY (página Início) ─────────────────────────────
// Métricas REAIS agregadas das posições do usuário (todos os bots gravam
// em positions). Substitui os números mockados que a home exibia.
app.get('/api/dashboard/summary', authenticateToken, async (req, res) => {
  try {
    const positions = await db.loadPositions(req.user.id);
    const dayKey = (iso) => (iso || '').slice(0, 10);
    const todayUtc = new Date().toISOString().slice(0, 10);

    const closed = positions.filter(p => p.status === 'closed' && p.pnl != null);
    const closedToday = closed.filter(p => dayKey(p.closedAt) === todayUtc);
    const pnlToday = closedToday.reduce((acc, p) => acc + (parseFloat(p.pnl) || 0), 0);

    // Operações de hoje = entradas abertas hoje (qualquer robô)
    const operationsToday = positions.filter(p => dayKey(p.openedAt) === todayUtc).length;

    // Taxa de acerto dos últimos 30 dias (posições fechadas com PnL)
    const cutoff30 = Date.now() - 30 * 86_400_000;
    const closed30 = closed.filter(p => new Date(p.closedAt).getTime() >= cutoff30);
    const wins30 = closed30.filter(p => parseFloat(p.pnl) > 0).length;
    const winRate30d = closed30.length ? wins30 / closed30.length : null;

    const openPositions = positions.filter(p => p.status === 'open').length;

    // Atividade recente real: aberturas e fechamentos mais novos primeiro
    const events = [];
    for (const p of positions) {
      if (p.openedAt) {
        events.push({ time: p.openedAt, kind: 'open', symbol: p.symbol, title: `Robô abriu posição em ${p.symbol}` });
      }
      if (p.status === 'closed' && p.closedAt) {
        const pnl = parseFloat(p.pnl);
        const pnlTxt = Number.isFinite(pnl) ? ` (${pnl >= 0 ? '+' : '-'}$${Math.abs(pnl).toFixed(2)})` : '';
        events.push({ time: p.closedAt, kind: Number.isFinite(pnl) && pnl < 0 ? 'loss' : 'win', symbol: p.symbol, title: `Posição fechada em ${p.symbol}${pnlTxt}` });
      }
    }
    events.sort((a, b) => new Date(b.time) - new Date(a.time));

    res.json({
      success: true,
      pnlToday,
      operationsToday,
      winRate30d,
      totalTrades30d: closed30.length,
      openPositions,
      recentActivity: events.slice(0, 6),
    });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── BALANCE ───────────────────────────────────────────────────────
app.get('/api/bot/balance', authenticateToken, async (req, res) => {
  try {
    const env = await getBotEnv(req.user.id);
    const apiKey = env.BINANCE_API_KEY || env.BITGET_API_KEY;
    const secretKey = env.BINANCE_SECRET_KEY || env.BITGET_SECRET_KEY;
    if (!apiKey || !secretKey) return res.json({ success: false, error: 'Sem credenciais' });

    // 1. Balance SPOT (Calcula soma de todos os ativos convertidos para USDT)
    const tsS = (await (await fetch('https://api.binance.com/api/v3/time')).json()).serverTime;
    const qsS = `timestamp=${tsS}`;
    const sigS = crypto.createHmac('sha256', secretKey).update(qsS).digest('hex');
    const resS = await (await fetch(`https://api.binance.com/api/v3/account?${qsS}&signature=${sigS}`, { headers: { 'X-MBX-APIKEY': apiKey } })).json();
    
    let spotTotal = 0;
    if (resS.balances) {
      const nonZero = resS.balances.filter(b => parseFloat(b.free) + parseFloat(b.locked) > 0);
      const assets = nonZero.filter(b => b.asset !== 'USDT');
      const usdtBal = nonZero.find(b => b.asset === 'USDT');
      spotTotal = usdtBal ? parseFloat(usdtBal.free) + parseFloat(usdtBal.locked) : 0;

      await Promise.all(assets.map(async b => {
        try {
          const pr = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${b.asset}USDT`);
          const pd = await pr.json();
          if (pd.price) spotTotal += (parseFloat(b.free) + parseFloat(b.locked)) * parseFloat(pd.price);
        } catch { /* ignorar ativo se não houver par USDT */ }
      }));
    }

    // 2. Balance FUTURES
    let futuresTotal = 0;
    try {
      const tsF = (await (await fetch('https://fapi.binance.com/fapi/v1/time')).json()).serverTime;
      const qsF = `timestamp=${tsF}`;
      const sigF = crypto.createHmac('sha256', secretKey).update(qsF).digest('hex');
      const resF = await (await fetch(`https://fapi.binance.com/fapi/v2/account?${qsF}&signature=${sigF}`, { headers: { 'X-MBX-APIKEY': apiKey } })).json();
      const futuresUsdt = resF.assets?.find(a => a.asset === 'USDT');
      futuresTotal = futuresUsdt ? parseFloat(futuresUsdt.availableBalance) : 0;
    } catch (e) {
      console.error("Erro ao carregar saldo de futuros:", e.message);
    }

    res.json({ 
      success: true, 
      spot: spotTotal,
      futures: futuresTotal
    });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── PORTFOLIO ─────────────────────────────────────────────────────
app.get('/api/bot/portfolio', authenticateToken, async (req, res) => {
  try {
    const env = await getBotEnv(req.user.id);
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
const MICRO_PID = join(ROOT, '.micro-scalper.pid');
let microProcess = null;

function microIsAlive() {
  if (isProcessAlive(microProcess)) return { alive: true, pid: microProcess.pid };
  if (existsSync(MICRO_PID)) {
    const pid = parseInt(readFileSync(MICRO_PID, 'utf8'));
    if (pid) {
      try { process.kill(pid, 0); return { alive: true, pid }; } catch {}
    }
  }
  return { alive: false, pid: null };
}

app.get('/api/micro-scalper/config', authenticateToken, async (req, res) => {
  try {
    // Config do PRÓPRIO usuário (banco) sobre os defaults globais
    const cfg = await getMergedMicroConfig(req.user.id);
    res.json({ success: true, config: cfg });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// NOTA: a rota GET /api/micro-scalper/signal vive no topo do arquivo (a
// primeira registrada vence no Express) — duplicata removida daqui.

app.post('/api/micro-scalper/trade', async (req, res) => {
  try {
    const { side, amount } = req.body;
    const rules = getRules();
    const active = rules.micro_scalper?.active_symbols || ['XRPUSDT'];
    const symbol = active[0] || 'XRPUSDT';
    
    const env = existsSync(join(ROOT, '.env')) ? readFileSync(join(ROOT, '.env'), 'utf8') : '';
    const apiKey = process.env.BINANCE_API_KEY || env.match(/BINANCE_API_KEY=(.*)/)?.[1]?.trim();
    const secretKey = process.env.BINANCE_SECRET_KEY || env.match(/BINANCE_SECRET_KEY=(.*)/)?.[1]?.trim();

    if (!apiKey || !secretKey) {
      return res.json({ success: true, simulated: true, symbol, side, amount });
    }

    const pr = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`);
    const price = parseFloat((await pr.json()).price);
    if (!price) return res.status(400).json({ success: false, error: 'Preço indisponível' });

    const qty = parseFloat((amount / price).toFixed(4));
    const ts = (await (await fetch('https://api.binance.com/api/v3/time')).json()).serverTime;
    const qs = `symbol=${symbol}&side=${side.toUpperCase()}&type=MARKET&quantity=${qty}&recvWindow=10000&timestamp=${ts}`;
    const sig = crypto.createHmac('sha256', secretKey).update(qs).digest('hex');
    
    const orderRes = await fetch(`https://api.binance.com/api/v3/order?${qs}&signature=${sig}`, {
      method: 'POST', headers: { 'X-MBX-APIKEY': apiKey }
    });
    const orderData = await orderRes.json();
    if (orderData.code && orderData.code < 0) {
      return res.status(400).json({ success: false, error: orderData.msg });
    }

    res.json({ success: true, order: orderData });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get('/api/micro-scalper/status', authenticateToken, async (req, res) => {
  try {
    const [hb, sessions] = await Promise.all([
      db.readMicroHeartbeat(120_000),
      db.loadMicroSessions(5, req.user.id),
    ]);
    // Heartbeat é a fonte de verdade; PID local como fallback.
    // Para não-donos o processo real não conta: vale o flag lógico DELES.
    const isOwner = await isOwnerUser(req.user.id);
    const localLiveness = microIsAlive();
    let running = hb.alive || localLiveness.alive;
    let pid = hb.pid ?? localLiveness.pid;
    if (!isOwner) {
      const st = await db.getUserBotState(req.user.id);
      running = !!st.micro_enabled;
      pid = null;
    }
    const lastSession = sessions.length ? sessions[sessions.length - 1] : null;
    // Ativos ativos NA VISÃO DO USUÁRIO (config dele no banco)
    const activeSymbols = (await getMergedMicroConfig(req.user.id))?.active_symbols || [];
    res.json({ success: true, running, pid, lastSeen: hb.lastSeen, lastSession, activeSymbols });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ─── AdaptiveBot (bot auto-adaptativo com Gemini) ────────────────────────────
// Somente leitura: o bot roda como processo pm2 próprio (adaptivebot) e este
// endpoint expõe o estado dele (params ativos, trades, lições e revisões).
let adaptiveInitPromise = null;
function ensureAdaptiveInit() {
  if (!adaptiveInitPromise) adaptiveInitPromise = adaptiveStore.init().catch((e) => { adaptiveInitPromise = null; throw e; });
  return adaptiveInitPromise;
}

app.get('/api/adaptive/status', authenticateToken, async (req, res) => {
  try {
    await ensureAdaptiveInit();
    const [hb, active, openTrades, lessons, reviews] = await Promise.all([
      adaptiveStore.readHeartbeat(),
      adaptiveStore.getActiveParams(),
      adaptiveStore.getOpenTrades(),
      adaptiveStore.getActiveLessons(10),
      adaptiveStore.getRecentReviews(10),
    ]);
    const since30d = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
    const closed = await adaptiveStore.getClosedTradesSince(since30d, 100);
    const wins = closed.filter((t) => Number(t.return_pct) > 0).length;
    res.json({
      success: true,
      running: hb.alive,
      lastSeen: hb.lastSeen,
      paper: true, // execução real ainda fora de escopo — sempre paper
      params: { version: active.version, ...active.params },
      openTrades: openTrades.map((t) => ({ id: t.id, symbol: t.symbol, openedAt: t.opened_at, entry: t.data?.entry, stop: t.data?.stop, tp: t.data?.tp })),
      stats30d: {
        trades: closed.length,
        winRate: closed.length ? wins / closed.length : 0,
        pnlPct: closed.reduce((a, t) => a + (Number(t.return_pct) || 0), 0),
      },
      recentTrades: closed.slice(0, 10).map((t) => ({ id: t.id, result: t.result, returnPct: Number(t.return_pct), closedAt: t.closed_at, version: Number(t.params_version) })),
      lessons: lessons.map((l) => l.lesson),
      reviews: reviews.map((r) => ({ at: r.created_at, applied: r.applied, reason: r.reason, analysis: r.analysis, newVersion: r.new_version != null ? Number(r.new_version) : null })),
    });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get('/api/micro-scalper/log', authenticateToken, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const all = await db.loadMicroSessions(200, req.user.id);
    if (!all.length) return res.json({ success: true, sessions: 0, trades: [], daily: { trades: 0, pnl: 0 }, weekly: {} });

    const flat = [];
    let todayTrades = 0, todayPnl = 0, todayProfit = 0;
    const weeklyStats = {}; // { 'YYYY-MM-DD': pnlPct }
    const processedTs = new Set();
    
    // Usamos UTC-3 para alinhar com o horário do usuário
    const nowLocal = new Date(new Date().getTime() - (3 * 60 * 60 * 1000));
    const todayStr = nowLocal.toISOString().split('T')[0];

    for (const sess of all) {
      const trades = sess.trades || [];
      const exits = trades.filter(t => t.event === 'exit');
      
      for (const tr of trades) {
        if (!tr.t) continue;
        const trKey = `${tr.t}_${tr.event}`;
        if (processedTs.has(trKey)) continue;
        processedTs.add(trKey);

        let isOpen = false;
        if (tr.event === 'entry') {
          // Se não houver nenhum exit posterior nesta sessão, marcamos como aberta
          const hasExit = exits.some(ex => new Date(ex.t) > new Date(tr.t));
          if (!hasExit) isOpen = true;
        }

        flat.push({ session: sess.sessionStart, isOpen, ...tr });
        
        if (tr.event === 'exit' && tr.pnlPct != null) {
          // Converter timestamp da trade para data local (UTC-3)
          const trLocalDate = new Date(new Date(tr.t).getTime() - (3 * 60 * 60 * 1000)).toISOString().split('T')[0];
          
          // Acumular no semanal (usamos todas as sessões carregadas)
          weeklyStats[trLocalDate] = (weeklyStats[trLocalDate] || 0) + tr.pnlPct;

          if (trLocalDate === todayStr) {
            todayTrades++;
            todayPnl += tr.pnlPct;
            const entries = trades.filter(t => t.event === 'entry');
            const entry = entries.filter(e => e.t < tr.t).pop();
            const entryVal = entry ? (entry.entryPrice * entry.qty) : 10;
            todayProfit += tr.pnlUsdt !== undefined ? tr.pnlUsdt : (tr.pnlPct * entryVal);
          }
        }
      }
    }
    // Sort strictly by timestamp to ensure chronological order across different symbols/sessions
    flat.sort((a, b) => new Date(a.t) - new Date(b.t));

    // Pós-processamento inteligente: garantir que todo 'exit' tenha um 'entry' correspondente no log devolvido
    const finalFlat = [];
    const openEntries = new Set();
    for (const item of flat) {
      const sym = item.symbol || 'DEFAULT';
      if (item.event === 'entry') {
        openEntries.add(sym);
        finalFlat.push(item);
      } else if (item.event === 'exit') {
        if (!openEntries.has(sym)) {
          // Injeta um entry sintético logo antes da saída para consistência da UI
          const entryTime = new Date(new Date(item.t).getTime() - 15 * 60 * 1000).toISOString();
          finalFlat.push({
            session: item.session,
            isOpen: false,
            t: entryTime,
            event: 'entry',
            side: 'buy',
            symbol: item.symbol,
            entryPrice: item.entryPrice || item.exitPrice || 0,
            qty: item.qty || 0,
            signal: 'histórico / sincronizado'
          });
        } else {
          openEntries.delete(sym);
        }
        finalFlat.push(item);
      } else {
        finalFlat.push(item);
      }
    }

    res.json({
      success: true,
      sessions: all.length,
      trades: finalFlat.slice(-limit).reverse(),
      daily: { trades: todayTrades, pnl: todayPnl, profit: todayProfit },
      weekly: weeklyStats
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

app.post('/api/micro-scalper/start', authenticateToken, async (req, res) => {
  try {
    // Não-dono: liga apenas o estado lógico DELE — nunca o processo real
    if (!(await isOwnerUser(req.user.id))) {
      await setUserBotFlag(req.user.id, 'micro_enabled', true);
      return res.json({ success: true, simulated: true });
    }

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

app.post('/api/micro-scalper/stop', authenticateToken, async (req, res) => {
  try {
    // Não-dono: desliga apenas o estado lógico DELE — nunca o processo real
    if (!(await isOwnerUser(req.user.id))) {
      await setUserBotFlag(req.user.id, 'micro_enabled', false);
      return res.json({ success: true, simulated: true });
    }

    let pidToKill = microProcess?.pid;
    if (!pidToKill && existsSync(MICRO_PID)) pidToKill = parseInt(readFileSync(MICRO_PID, 'utf8'));
    if (!pidToKill) return res.json({ success: false, error: 'not running' });

    console.log(`🛑 Matando Micro-Scalper (PID: ${pidToKill})...`);
    try { process.kill(pidToKill, 'SIGTERM'); } catch {}
    if (microProcess) { try { microProcess.kill('SIGTERM'); } catch {} microProcess = null; }
    if (existsSync(MICRO_PID)) { try { unlinkSync(MICRO_PID); } catch {} }
    res.json({ success: true, killed: pidToKill });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── Estratégia do Micro-Scalper (planos por símbolo) ────────────────────────
// Atualiza rules.micro_scalper (plano do símbolo, ativação e parâmetros globais)
// e reinicia o scalper se estiver rodando — ele só lê a config na inicialização.
app.patch('/api/micro-scalper/strategy', authenticateToken, async (req, res) => {
  try {
    const { symbol, plan, active, global } = req.body || {};

    // Ativar/pausar/personalizar opera SÓ na config do próprio usuário —
    // antes gravava no rules.json global e vazava para todas as contas.
    const merged = await getMergedMicroConfig(req.user.id);
    const userCfg = {
      ...merged,
      active_symbols: Array.isArray(merged.active_symbols) ? [...merged.active_symbols] : [],
      plans: { ...(merged.plans || {}) },
    };

    if (symbol && plan && typeof plan === 'object') {
      userCfg.plans[symbol] = { ...(userCfg.plans[symbol] || {}), ...plan };
    }
    if (symbol && active !== undefined) {
      userCfg.active_symbols = userCfg.active_symbols.filter(s => s !== symbol);
      if (active) userCfg.active_symbols.push(symbol);
    }
    if (global && typeof global === 'object') {
      for (const k of ['max_trade_usdt', 'min_trade_usdt', 'daily_profit_target_usdt', 'loop_interval_ms', 'cooldown_ms', 'max_trades']) {
        if (global[k] !== undefined) userCfg[k] = Number(global[k]);
      }
    }

    await db.saveUserMicroConfig(req.user.id, userCfg);

    // Só o DONO espelha no rules.json e reinicia o robô real
    let restarted = false;
    if (await isOwnerUser(req.user.id)) {
      await syncMicroRulesFromOwner(req.user.id);
      restarted = restartMicroScalperIfRunning();
    }

    res.json({ success: true, micro_scalper: userCfg, restarted });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ─── Accounts Helper Functions ───────────────────────────────────────────────
async function syncEnvWithActiveAccount(userId = null) {
  try {
    // Sem userId (boot): resolve a conta do DONO do bot. "Primeira conta
    // ativa" global podia ser a conta de teste de OUTRO usuário e envenenava
    // process.env — micro-scalper/masterbot herdam essas chaves no spawn.
    const targetUser = userId || await db.getOwnerUserId();
    const activeAcc = await db.getActiveAccount(targetUser);
    if (activeAcc) {
      process.env.BINANCE_API_KEY = activeAcc.api_key;
      process.env.BINANCE_SECRET_KEY = activeAcc.secret_key;
      process.env.BINANCE_IS_TESTNET = activeAcc.is_testnet ? 'true' : 'false';
      console.log(`🔑 Env configurado para a conta ativa: ${activeAcc.name} (${activeAcc.id})`);
      return true;
    }
  } catch (e) {
    console.error("❌ Erro ao sincronizar env com conta ativa:", e.message);
  }
  return false;
}

async function restartRunningBots() {
  // Restart MasterBot if running
  let masterPid = masterProcess?.pid;
  if (!masterPid && existsSync(BOT_MASTER_PID)) {
    try { masterPid = parseInt(readFileSync(BOT_MASTER_PID, 'utf8')); } catch {}
  }
  if (masterPid) {
    console.log(`♻️ Reiniciando MasterBot com a nova conta...`);
    try { process.kill(masterPid, 'SIGTERM'); } catch {}
    masterProcess = null;
    if (existsSync(BOT_MASTER_PID)) { try { unlinkSync(BOT_MASTER_PID); } catch {} }
    
    setTimeout(() => {
      masterProcess = spawn('node', ['bot.js', '--master'], {
        cwd: BOT_DIR,
        detached: true,
        stdio: 'ignore',
        env: { ...process.env }
      });
      if (masterProcess.pid) writeFileSync(BOT_MASTER_PID, masterProcess.pid.toString());
      masterProcess.unref();
      console.log(`✅ MasterBot reiniciado.`);
    }, 2000);
  }

  // Restart Micro-Scalper if running
  const microState = await db.readMicroHeartbeat();
  if (microState.alive && microState.pid) {
    console.log(`♻️ Reiniciando Micro-Scalper com a nova conta...`);
    try { process.kill(microState.pid, 'SIGTERM'); } catch {}
    if (microProcess) { try { microProcess.kill('SIGTERM'); } catch {} microProcess = null; }
    if (existsSync(MICRO_PID)) { try { unlinkSync(MICRO_PID); } catch {} }

    setTimeout(() => {
      microProcess = spawn('node', [MICRO_SCRIPT], {
        cwd: ROOT,
        detached: true,
        stdio: 'ignore',
        env: { ...process.env }
      });
      if (microProcess.pid) writeFileSync(MICRO_PID, microProcess.pid.toString());
      microProcess.unref();
      console.log(`✅ Micro-Scalper reiniciado.`);
    }, 2000);
  }
}

// ─── Accounts Endpoints ───────────────────────────────────────────────────────
app.get('/api/accounts', authenticateToken, async (req, res) => {
  try {
    const list = await db.listAccounts(req.user.id);
    res.json({ success: true, accounts: list });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/api/accounts', authenticateToken, async (req, res) => {
  try {
    const { name, apiKey, secretKey, isTestnet } = req.body || {};
    if (!name || !apiKey || !secretKey) {
      return res.status(400).json({ success: false, error: 'name, apiKey e secretKey são obrigatórios' });
    }
    const id = await db.createAccount(req.user.id, name, apiKey.trim(), secretKey.trim(), !!isTestnet);
    // Só a conta do DONO alimenta as chaves dos robôs reais
    if (await isOwnerUser(req.user.id)) await syncEnvWithActiveAccount(req.user.id);
    res.json({ success: true, id });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/api/accounts/:id/activate', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    await db.activateAccount(req.user.id, id);
    // Trocar de conta só afeta os ROBÔS se quem trocou for o dono — outro
    // usuário ativando a própria conta não pode reiniciar os bots com as
    // chaves dele (sequestro das operações reais).
    if (await isOwnerUser(req.user.id)) {
      await syncEnvWithActiveAccount(req.user.id);
      await restartRunningBots();
    }
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.delete('/api/accounts/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    await db.deleteAccount(req.user.id, id);
    if (await isOwnerUser(req.user.id)) {
      await syncEnvWithActiveAccount(req.user.id);
      await restartRunningBots();
    }
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});


// ── FALLBACK ─────────────────────────────────────────────────────
app.get('/*splat', (_req, res) => res.sendFile(join(__dirname, 'index.html')));

// ── START ─────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3333;
const server = createServer(app);
db.initDb()
  .then(() => syncEnvWithActiveAccount())
  .then(() => migrateStrategiesToDb())
  .catch(e => console.error('⚠️  PostgreSQL indisponível:', e.message));

/**
 * Migração one-time: move os group_plans do rules.json global para a tabela
 * strategies, atribuindo-os ao usuário DONO da conta do bot. Idempotente —
 * seedStrategiesForUser só insere se o dono ainda não tiver estratégias.
 */
async function migrateStrategiesToDb() {
  try {
    const ownerId = await db.getOwnerUserId();
    if (!ownerId) return;
    const rules = getRules();
    const plans = rules.group_plans || [];
    const n = await db.seedStrategiesForUser(ownerId, plans, rules.active_plan || null);
    if (n > 0) {
      console.log(`📦 Migradas ${n} estratégia(s) do rules.json para o dono (isolamento por usuário).`);
    }

    // Config do Micro Scalper (active_symbols + plans) também vira por-usuário
    const ms = rules.micro_scalper;
    if (ms) {
      const seeded = await db.seedMicroConfigForUser(ownerId, {
        active_symbols: ms.active_symbols || [],
        plans: ms.plans || {},
        ...(ms.max_trade_usdt !== undefined ? { max_trade_usdt: ms.max_trade_usdt } : {}),
        ...(ms.min_trade_usdt !== undefined ? { min_trade_usdt: ms.min_trade_usdt } : {}),
      });
      if (seeded) console.log('📦 Config do Micro Scalper migrada para o dono (isolamento por usuário).');
    }
  } catch (e) {
    console.error('⚠️  Falha na migração de estratégias:', e.message);
  }
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n✅ Dashboard Server running on port ${PORT}\n`);
});

export default app;
