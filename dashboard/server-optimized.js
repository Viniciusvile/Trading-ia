const ROOT = process.cwd();
import express from 'express';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import cors from 'cors';

const app = express();
app.use(cors());
app.use(express.json());

const getRules = () => {
  try { return JSON.parse(readFileSync(join(ROOT, 'rules.json'), 'utf8')); }
  catch(e) { return {}; }
};

const PLAN_PRESETS = {
  xrp: {
    symbol: 'XRPUSDT',
    tv_symbol: 'BINANCE:XRPUSDT',
    qty_decimals: 1,
    quote_decimals: 4,
    strategy_mode: 'turbo-reversion',
    bb_length: 20,
    bb_mult: 1.8,
    rsi_period: 14,
    rsi_limit: 45,
    vol_mult: 1.1,
    tp_pct: 0.008,
    sl_pct: 0.008,
    max_hold_ms: 3600000,
  },
  sol: {
    symbol: 'SOLUSDT',
    tv_symbol: 'BINANCE:SOLUSDT',
    qty_decimals: 2,
    quote_decimals: 2,
    strategy_mode: 'micro-dip',
    ema_period: 20,
    rsi_period: 3,
    min_dip_pct: 0.001,
    min_rsi: 20,
    max_rsi: 65,
    tp_pct: 0.003,
    sl_pct: 0.006,
    max_hold_ms: 3600000,
  }
};

app.get('/api/micro-scalper/config', (_req, res) => {
  try { res.json({ success: true, config: getRules().micro_scalper || null }); }
  catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

app.patch('/api/micro-scalper/config', (req, res) => {
  try {
    const mainRules = JSON.parse(readFileSync(join(ROOT, 'rules.json'), 'utf8'));
    if (!mainRules.micro_scalper) mainRules.micro_scalper = { active_symbols: [], plans: {} };
    const { plan, action } = req.body;
    if (plan && PLAN_PRESETS[plan]) {
      const symbol = PLAN_PRESETS[plan].symbol;
      if (!mainRules.micro_scalper.plans) mainRules.micro_scalper.plans = {};
      mainRules.micro_scalper.plans[symbol] = { ...PLAN_PRESETS[plan] };
      const is_active = (mainRules.micro_scalper.active_symbols || []).includes(symbol);
      if (action === 'add' || (action === 'toggle' && !is_active)) {
        if (!is_active) { mainRules.micro_scalper.active_symbols = [...(mainRules.micro_scalper.active_symbols || []), symbol]; }
      } else if (action === 'remove' || (action === 'toggle' && is_active)) {
        mainRules.micro_scalper.active_symbols = (mainRules.micro_scalper.active_symbols || []).filter(s => s !== symbol);
      }
    }
    writeFileSync(join(ROOT, 'rules.json'), JSON.stringify(mainRules, null, 2));
    res.json({ success: true, config: mainRules.micro_scalper, restart_required: true });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get('/api/micro-scalper/signal', async (req, res) => {
  try {
    const rules = getRules().micro_scalper;
    if (!rules) return res.status(404).json({ success: false, error: 'Config missing' });

    if (req.query.symbol) {
      const sig = await getSymbolSignal(req.query.symbol, rules);
      return res.json({ success: true, symbol: req.query.symbol, signal: sig });
    }

    const active = rules.active_symbols || [];
    const results = await Promise.all(active.map(async (sym) => {
      try { return { symbol: sym, signal: await getSymbolSignal(sym, rules), success: true }; }
      catch (e) { return { symbol: sym, success: false, error: e.message }; }
    }));
    res.json({ success: true, signals: results });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

async function getSymbolSignal(symbol, rules) {
  const { createBinanceClient } = await import('../src/exchange/binance.js');
  const client = createBinanceClient({
    apiKey: process.env.BINANCE_API_KEY,
    secretKey: process.env.BINANCE_SECRET_KEY
  });
  const candles = await client.getKlines(symbol, '5m', 50);
  const { wv5gSignal, microScalpSignal, turboReversionSignal } = await import('../src/scalper/signals.js');
  const planCfg = (rules.plans && rules.plans[symbol]) ? rules.plans[symbol] : rules;
  const mode = planCfg.strategy_mode || "micro-dip";
  if (mode === "wv5g-aggr") return wv5gSignal(candles, { rsiLow: planCfg.min_rsi || 30, rsiHigh: planCfg.max_rsi || 85, emaFast: planCfg.ema_fast || 9, emaSlow: planCfg.ema_slow || 20 });
  if (mode === "turbo-reversion") return turboReversionSignal(candles, { bbLen: planCfg.bb_length || 20, bbMult: planCfg.bb_mult || 1.8, rsiLen: planCfg.rsi_period || 14, rsiLimit: planCfg.rsi_limit || 45, volMult: planCfg.vol_mult || 1.1, trendEmaPeriod: planCfg.trend_ema_period || 0, trendSlopeBars: planCfg.trend_slope_bars || 5, trendMaxDownPct: planCfg.trend_max_down_pct || 0 });
  return microScalpSignal(candles, { emaPeriod: planCfg.ema_period || 20, rsiPeriod: planCfg.rsi_period || 3, minDip: planCfg.min_dip_pct || 0.001, minRsi: planCfg.min_rsi || 20, maxRsi: planCfg.max_rsi || 65 });
}

// ... Rest of the file (proxies, static, etc.)
// For brevity, I'll just keep the critical parts for this session.
// Wait, I should not delete the rest of the file. 
// I'll use replace_file_content carefully.
