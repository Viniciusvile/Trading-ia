// micro-scalper.js
import { existsSync, readFileSync, writeFileSync } from "fs";
import { createBinanceClient } from "./src/exchange/binance.js";
import { microScalpSignal } from "./src/scalper/signals.js";
import { createPosition, evaluateExit, pnlPct } from "./src/scalper/position.js";
import { createTvBridge } from "./src/scalper/tv-bridge.js";
import { setSymbol } from "./src/core/chart.js";

readFileSync(new URL(".env", import.meta.url), "utf8")
  .split("\n")
  .forEach((line) => {
    const [k, ...v] = line.split("=");
    if (k && !k.startsWith("#") && v.length) process.env[k.trim()] = v.join("=").trim();
  });

const cfg = JSON.parse(readFileSync(new URL("rules.json", import.meta.url), "utf8")).micro_scalper;
if (!cfg) throw new Error("rules.json is missing 'micro_scalper' block");

const client = createBinanceClient({
  apiKey: process.env.BINANCE_API_KEY,
  secretKey: process.env.BINANCE_SECRET_KEY,
});

const SYMBOL = cfg.symbol;
const BASE_ASSET = SYMBOL.replace("USDT", "");

const tvBridge = cfg.draw_on_tradingview ? createTvBridge() : null;

function fmtQty(n) {
  const f = Math.pow(10, cfg.qty_decimals);
  return (Math.floor(n * f) / f).toFixed(cfg.qty_decimals);
}
function fmtQuote(n) {
  const f = Math.pow(10, cfg.quote_decimals);
  return (Math.floor(n * f) / f).toFixed(cfg.quote_decimals);
}

async function ensureTvSymbol() {
  if (!cfg.auto_set_tv_symbol) return;
  try {
    await setSymbol({ symbol: cfg.tv_symbol });
    console.log(`📺 TradingView symbol set to ${cfg.tv_symbol}`);
  } catch (e) {
    console.warn(`📺 Could not set TV symbol: ${e.message} (continuing without auto-set)`);
  }
}

async function openLong(quoteUsdt) {
  const res = await client.placeMarketBuyQuote(SYMBOL, fmtQuote(quoteUsdt));
  if (!res.ok) return { ok: false, res };
  const qty = parseFloat(res.data.executedQty || 0);
  const quoteSpent = parseFloat(res.data.cummulativeQuoteQty || 0);
  const avgPrice = qty > 0 ? quoteSpent / qty : 0;
  return { ok: qty > 0, res, qty, avgPrice };
}

async function closeLong(qty) {
  const res = await client.placeMarketSellQty(SYMBOL, fmtQty(qty));
  if (!res.ok) return { ok: false, res };
  const filledQty = parseFloat(res.data.executedQty || 0);
  const filledQuote = parseFloat(res.data.cummulativeQuoteQty || 0);
  const exitPrice = filledQty > 0 ? filledQuote / filledQty : 0;
  return { ok: filledQty > 0, res, qty: filledQty, exitPrice };
}

async function main() {
  console.log(`\n⚡ MICRO-SCALPER (Binance) — ${SYMBOL}`);
  console.log(`   TP ${cfg.tp_pct * 100}% / SL ${cfg.sl_pct * 100}% / hold≤${cfg.max_hold_ms / 60000}min / loop ${cfg.loop_interval_ms}ms`);

  await ensureTvSymbol();

  const sessionStart = Date.now();
  const log = [];
  let pos = null;
  let trades = 0;
  let wins = 0;
  let cumPnlPct = 0;
  let cooldownUntil = 0;

  const startBals = await client.getBalances([BASE_ASSET, "USDT"]);
  const startEquityUsdt = startBals.usdt + startBals[BASE_ASSET.toLowerCase()] * (await client.getPrice(SYMBOL));

  while (trades < cfg.max_trades && Date.now() - sessionStart < cfg.max_session_ms) {
    const now = Date.now();
    try {
      const lastPrice = await client.getPrice(SYMBOL);

      if (pos) {
        const exit = evaluateExit(pos, { price: lastPrice, now });
        if (exit.shouldExit) {
          const r = await closeLong(pos.qty);
          const exitPx = r.exitPrice || lastPrice;
          const realizedPct = r.ok ? pnlPct(pos, exitPx) : 0;
          cumPnlPct += realizedPct;
          if (realizedPct > 0) wins++;
          trades++;
          log.push({
            t: new Date(now).toISOString(),
            event: "exit",
            reason: exit.reason,
            entryPrice: pos.entryPrice,
            exitPrice: exitPx,
            qty: pos.qty,
            pnlPct: realizedPct,
            ok: r.ok,
            msg: r.res?.data,
          });
          console.log(`  [${trades}/${cfg.max_trades}] EXIT ${exit.reason} @ ${exitPx.toFixed(4)} pnl=${(realizedPct * 100).toFixed(3)}% cum=${(cumPnlPct * 100).toFixed(3)}%`);

          if (tvBridge) await tvBridge.clearEntry();

          pos = null;
          cooldownUntil = now + cfg.cooldown_ms;

          if (cumPnlPct <= -cfg.daily_loss_stop_pct) {
            console.log(`  🛑 Loss limit ${(cumPnlPct * 100).toFixed(2)}%. Stopping session.`);
            break;
          }
        }
      } else if (now >= cooldownUntil) {
        const candles = await client.getKlines(SYMBOL, cfg.candles_interval, cfg.candles_limit);
        const sig = microScalpSignal(candles, {
          emaPeriod: cfg.ema_period,
          rsiPeriod: cfg.rsi_period,
          minDip: cfg.min_dip_pct,
          minRsi: cfg.min_rsi,
          maxRsi: cfg.max_rsi,
        });

        if (sig.signal === "buy") {
          const bals = await client.getBalances([BASE_ASSET, "USDT"]);
          const tradeUsdt = Math.min(Math.max(bals.usdt * cfg.trade_size_pct, cfg.min_trade_usdt), cfg.max_trade_usdt);
          if (bals.usdt < cfg.min_trade_usdt) {
            console.log(`  💤 Insufficient USDT: ${bals.usdt.toFixed(4)}`);
          } else {
            const open = await openLong(tradeUsdt);
            if (open.ok) {
              const entryPrice = open.avgPrice || lastPrice;
              pos = createPosition({
                side: "buy",
                entryPrice,
                qty: open.qty,
                tpPct: cfg.tp_pct,
                slPct: cfg.sl_pct,
                openedAt: now,
                maxHoldMs: cfg.max_hold_ms,
              });
              log.push({
                t: new Date(now).toISOString(),
                event: "entry",
                side: "buy",
                entryPrice,
                qty: open.qty,
                tpPrice: pos.tpPrice,
                slPrice: pos.slPrice,
                signal: sig.reason,
              });
              console.log(`  🟢 ENTRY @ ${entryPrice.toFixed(4)} qty=${open.qty.toFixed(4)} TP=${pos.tpPrice.toFixed(4)} SL=${pos.slPrice.toFixed(4)}`);

              if (tvBridge) {
                await tvBridge.drawEntry({
                  entryPrice,
                  tpPrice: pos.tpPrice,
                  slPrice: pos.slPrice,
                  qty: open.qty,
                  ts: now,
                  label: `MICRO ${open.qty.toFixed(2)} ${BASE_ASSET}`,
                });
              }
            } else {
              console.log(`  ❌ Entry rejected: ${JSON.stringify(open.res?.data).slice(0, 200)}`);
              cooldownUntil = now + cfg.cooldown_ms;
            }
          }
        }
      }
    } catch (e) {
      console.error(`  ⚠️  Loop error: ${e.message}`);
      cooldownUntil = Date.now() + cfg.cooldown_ms;
    }

    await new Promise((r) => setTimeout(r, cfg.loop_interval_ms));
  }

  if (pos) {
    const px = await client.getPrice(SYMBOL);
    const r = await closeLong(pos.qty);
    const exitPx = r.exitPrice || px;
    const realizedPct = r.ok ? pnlPct(pos, exitPx) : 0;
    cumPnlPct += realizedPct;
    trades++;
    log.push({ t: new Date().toISOString(), event: "exit", reason: "session_end", exitPrice: exitPx, pnlPct: realizedPct });
    if (tvBridge) await tvBridge.clearEntry();
  }

  const endBals = await client.getBalances([BASE_ASSET, "USDT"]);
  const endPrice = await client.getPrice(SYMBOL);
  const endEquityUsdt = endBals.usdt + endBals[BASE_ASSET.toLowerCase()] * endPrice;

  console.log(`\n📊 Session done — ${trades} trades, ${wins} wins (${trades ? ((wins / trades) * 100).toFixed(1) : 0}%)`);
  console.log(`   Cumulative pnl%: ${(cumPnlPct * 100).toFixed(3)}%`);
  console.log(`   Equity: $${startEquityUsdt.toFixed(4)} → $${endEquityUsdt.toFixed(4)} (Δ $${(endEquityUsdt - startEquityUsdt).toFixed(4)})`);

  const existing = existsSync("micro-scalper-log.json")
    ? JSON.parse(readFileSync("micro-scalper-log.json", "utf8"))
    : [];
  writeFileSync(
    "micro-scalper-log.json",
    JSON.stringify([...existing, { sessionStart: new Date(sessionStart).toISOString(), trades: log }], null, 2),
  );
}

main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
