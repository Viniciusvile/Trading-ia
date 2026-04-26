import { execSync } from "child_process";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "fs";

// --- TRAVA DE SEGURANÇA: IMPEDIR MÚLTIPLAS INSTÂNCIAS ---
const PID_FILE = ".micro-scalper.pid";
if (existsSync(PID_FILE)) {
  const oldPid = parseInt(readFileSync(PID_FILE, "utf8"));
  if (oldPid && oldPid !== process.pid) {
    try {
      // No Windows, tasklist verifica se o processo existe
      const stdout = execSync(`tasklist /FI "PID eq ${oldPid}" /NH`).toString();
      if (stdout.includes(oldPid.toString())) {
        console.error(`❌ [ERRO] O robô já está rodando (PID: ${oldPid}). Encerrando esta nova instância.`);
        process.exit(1);
      }
    } catch (e) {
      // Se o PID não existe ou tasklist falhou, ignoramos
    }
  }
}
// Registra o PID atual
writeFileSync(PID_FILE, process.pid.toString());
// Remove o PID ao sair
process.on("exit", () => { try { if(parseInt(readFileSync(PID_FILE, "utf8")) === process.pid) unlinkSync(PID_FILE); } catch {} });
process.on("SIGINT", () => process.exit());
process.on("SIGTERM", () => process.exit());
// -------------------------------------------------------
import { createBinanceClient } from "./src/exchange/binance.js";
import { microScalpSignal, wv5gSignal, turboReversionSignal, calcBB } from "./src/scalper/signals.js";
import { createPosition, evaluateExit, pnlPct } from "./src/scalper/position.js";
import { createTvBridge } from "./src/scalper/tv-bridge.js";
import { setSymbol } from "./src/core/chart.js";

// Carregar variáveis de ambiente manualmente
const envPath = new URL(".env", import.meta.url);
if (existsSync(envPath)) {
  readFileSync(envPath, "utf8")
    .split("\n")
    .forEach((line) => {
      const [k, ...v] = line.split("=");
      if (k && !k.startsWith("#") && v.length) process.env[k.trim()] = v.join("=").trim();
    });
}

const cfg = JSON.parse(readFileSync(new URL("rules.json", import.meta.url), "utf8")).micro_scalper;
if (!cfg) throw new Error("rules.json is missing 'micro_scalper' block");

const client = createBinanceClient({
  apiKey: process.env.BINANCE_API_KEY,
  secretKey: process.env.BINANCE_SECRET_KEY,
});

const SYMBOL = cfg.symbol;
const BASE_ASSET = SYMBOL.replace("USDT", "");
const tvBridge = cfg.draw_on_tradingview ? createTvBridge() : null;

// ─── Telegram Notifications ─────────────────────────────────────────────────
async function sendTelegram(message) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: message, disable_web_page_preview: true }),
    });
    if (!res.ok) console.warn(`  ⚠ Telegram falhou: HTTP ${res.status}`);
  } catch (e) {
    console.warn(`  ⚠ Telegram erro: ${e.message}`);
  }
}

function fmtQty(n) {
  const decimals = cfg.qty_decimals !== undefined ? cfg.qty_decimals : 0;
  const f = Math.pow(10, decimals);
  return (Math.floor(n * f) / f).toFixed(decimals);
}
function fmtQuote(n) {
  const f = Math.pow(10, cfg.quote_decimals || 2);
  return (Math.floor(n * f) / f).toFixed(cfg.quote_decimals || 2);
}

async function ensureTvSymbol() {
  if (!cfg.auto_set_tv_symbol) return;
  try {
    await setSymbol({ symbol: cfg.tv_symbol });
    console.log(`📺 TradingView symbol set to ${cfg.tv_symbol}`);
  } catch (e) {
    console.warn(`📺 Could not set TV symbol: ${e.message}`);
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

async function closeLong(qty, ocoId = null) {
  if (ocoId) {
    console.log(`  🛡️ [LIMPEZA] Cancelando ordem OCO #${ocoId} antes de vender...`);
    try { await client.cancelOCO(SYMBOL, ocoId); } catch(e) { console.warn(`  ⚠️ Falha ao cancelar OCO: ${e.message}`); }
  }
  const res = await client.placeMarketSellQty(SYMBOL, fmtQty(qty));
  if (!res.ok) return { ok: false, res };
  const filledQty = parseFloat(res.data.executedQty || 0);
  const filledQuote = parseFloat(res.data.cummulativeQuoteQty || 0);
  const exitPrice = filledQty > 0 ? filledQuote / filledQty : 0;
  return { ok: filledQty > 0, res, qty: filledQty, exitPrice };
}

async function main() {
  console.log(`\n🤖 [MASTERBOT] AUTO-PILOT ON — ${SYMBOL}`);
  console.log(`   MODE: ${cfg.strategy_mode} | TP ${cfg.tp_pct * 100}% | SL ${cfg.sl_pct * 100}%`);

  await client.syncTime(); // Sincroniza o relógio com a Binance para evitar erro -1021
  await ensureTvSymbol();

  const sessionStart = Date.now();
  const log = [];
  let pos = null;
  let trades = 0;
  let wins = 0;
  let cumPnlPct = 0;
  let cooldownUntil = 0;

  while (trades < cfg.max_trades && Date.now() - sessionStart < cfg.max_session_ms) {
    const now = Date.now();
    try {
      const lastPrice = await client.getPrice(SYMBOL);

      if (pos) {
        // --- GESTÃO DE SAÍDA AUTOMÁTICA ---
        const exitStatus = evaluateExit(pos, { price: lastPrice, now });
        
        // Melhoria: Se modo Turbo, verifica se tocou a banda superior (Saída MasterBot)
        let shouldExit = exitStatus.shouldExit;
        let reason = exitStatus.reason;

        // --- NOVO: VERIFICAÇÃO DE STATUS OCO NA BINANCE ---
        if (pos.ocoId) {
          try {
            const ocoStatus = await client.getOCO(pos.ocoId);
            if (ocoStatus.ok && (ocoStatus.data.listOrderStatus === 'ALL_DONE' || ocoStatus.data.listStatusType === 'ALL_DONE')) {
              shouldExit = true;
              reason = "binance_oco_filled";
              console.log(`  🎯 [BINANCE] Ordem OCO preenchida na exchange! Fechando log...`);
            }
          } catch (e) {
            console.warn(`  ⚠️ Erro ao checar OCO: ${e.message}`);
          }
        }

        if (!shouldExit && cfg.strategy_mode === "turbo-reversion") {
          const candles = await client.getKlines(SYMBOL, cfg.candles_interval, cfg.candles_limit);
          const bb = calcBB(candles.map(c => c.close), cfg.bb_length, cfg.bb_mult);
          if (lastPrice >= bb.upper) {
            shouldExit = true;
            reason = "turbo_profit_target";
          }
        }

        if (shouldExit) {
          const r = await closeLong(pos.qty, pos.ocoId);
          const exitPx = r.exitPrice || lastPrice;
          const realizedPct = r.ok ? pnlPct(pos, exitPx) : 0;
          cumPnlPct += realizedPct;
          if (realizedPct > 0) wins++;
          trades++;
          
          const pnlUsdt = r.ok ? (exitPx - pos.entryPrice) * pos.qty : 0;
          log.push({
            t: new Date(now).toISOString(),
            event: "exit",
            reason,
            pnlPct: realizedPct,
            pnlUsdt: pnlUsdt,
            qty: pos.qty,
            ok: r.ok,
            exitPrice: exitPx
          });
          
          // --- SALVA LOG IMEDIATAMENTE PARA O DASHBOARD LER ---
          const existing = existsSync("micro-scalper-log.json") ? JSON.parse(readFileSync("micro-scalper-log.json", "utf8")) : [];
          // Atualiza a última sessão ou cria uma nova se não existir
          if (existing.length > 0 && existing[existing.length-1].sessionStart === new Date(sessionStart).toISOString()) {
              existing[existing.length-1].trades = log;
          } else {
              existing.push({ sessionStart: new Date(sessionStart).toISOString(), trades: log });
          }
          writeFileSync("micro-scalper-log.json", JSON.stringify(existing, null, 2));
          // ----------------------------------------------------

          console.log(`  🚀 [EXIT] ${reason} @ ${exitPx.toFixed(4)} PnL: ${(realizedPct * 100).toFixed(2)}%`);
          sendTelegram(`🔴 [SCALPER] VENDA ${SYMBOL}\nMotivo: ${reason}\nEntrada: $${pos.entryPrice.toFixed(4)} → Saída: $${exitPx.toFixed(4)}\nPnL: ${(realizedPct * 100).toFixed(2)}%\nTrade ${trades}/${cfg.max_trades} | Wins ${wins} | Cum ${(cumPnlPct * 100).toFixed(2)}%`);
          if (tvBridge) await tvBridge.clearEntry();
          pos = null;
          cooldownUntil = now + cfg.cooldown_ms;

          if (cumPnlPct <= -cfg.daily_loss_stop_pct) break;
        }
      } else if (now >= cooldownUntil) {
        // --- BUSCA DE SINAL AUTOMÁTICO ---
        const candles = await client.getKlines(SYMBOL, cfg.candles_interval, cfg.candles_limit);
        const strategyMode = cfg.strategy_mode || "micro-dip";
        let sig;
        
        if (strategyMode === "turbo-reversion") {
          sig = turboReversionSignal(candles, { 
            bbLen: cfg.bb_length, 
            bbMult: cfg.bb_mult, 
            rsiLen: cfg.rsi_period, 
            rsiLimit: cfg.rsi_limit, 
            volMult: cfg.vol_mult 
          });
        } else if (strategyMode === "wv5g-aggr") {
          sig = wv5gSignal(candles, { rsiLow: cfg.min_rsi || 30, rsiHigh: cfg.max_rsi || 85, emaFast: cfg.ema_fast || 9, emaSlow: cfg.ema_slow || 20 });
        } else {
          sig = microScalpSignal(candles, { emaPeriod: cfg.ema_period, rsiPeriod: cfg.rsi_period, minDip: cfg.min_dip_pct, minRsi: cfg.min_rsi, maxRsi: cfg.max_rsi });
        }

        // --- GATILHO DE TESTE ---
        const forceBuyPath = new URL(".force-buy", import.meta.url);
        let forceBuy = false;
        if (existsSync(forceBuyPath)) {
          forceBuy = true;
          const { unlinkSync } = await import("fs");
          try { unlinkSync(forceBuyPath); } catch {}
          sig = { signal: "buy", reason: "TESTE FORÇADO PELO USUÁRIO" };
        }
        // -------------------------

        if (sig.signal === "buy") {
          const bals = await client.getBalances([BASE_ASSET, "USDT"]);
          // Usa o valor fixo máximo (ex: 10 USDT), mas garante que não ultrapasse 95% do saldo disponível
          const tradeUsdt = Math.min(bals.usdt * 0.95, cfg.max_trade_usdt);
          
          if (bals.usdt >= cfg.min_trade_usdt) {
            console.log(`  🎯 [SIGNAL] ${sig.reason} detectado! Comprando...`);
            const open = await openLong(tradeUsdt);
            if (open.ok) {
              const entryPrice = open.avgPrice || lastPrice;
              pos = createPosition({
                side: "buy", entryPrice, qty: open.qty,
                tpPct: cfg.tp_pct, slPct: cfg.sl_pct,
                openedAt: now, maxHoldMs: cfg.max_hold_ms,
              });
              console.log(`  🟢 [ENTRY] COMPRADO @ ${entryPrice.toFixed(4)} | TP: ${pos.tpPrice.toFixed(4)} | SL: ${pos.slPrice.toFixed(4)}`);
              sendTelegram(`🟢 [SCALPER] COMPRA ${SYMBOL}\nPreço: $${entryPrice.toFixed(4)}\nQtd: ${open.qty}\nTP: $${pos.tpPrice.toFixed(4)} | SL: $${pos.slPrice.toFixed(4)}\nSinal: ${sig.reason}\nModo: ${cfg.strategy_mode}`);
              
              // --- SEGURANÇA MÁXIMA: ENVIO DE OCO PARA BINANCE ---
              try {
                const ocoQty = fmtQty(open.qty * 0.999);
                const oco = await client.placeOCO(
                  SYMBOL, "SELL", ocoQty, 
                  pos.tpPrice, pos.slPrice, pos.slPrice * 0.999
                );
                if (oco.ok) {
                  pos.ocoId = oco.data.orderListId;
                  console.log(`  🛡️ [PROTEÇÃO] Ordem OCO enviada com sucesso: #${pos.ocoId}`);
                } else {
                  console.warn(`  ⚠️ [AVISO] Falha ao enviar OCO (Operação manual necessária): ${JSON.stringify(oco.data)}`);
                }
              } catch(e) { 
                console.error(`  ❌ [ERRO] Falha crítica no OCO: ${e.message}`);
                try { writeFileSync("oco-error.log", `${new Date().toISOString()} - ${e.message}\n`, { flag: 'a' }); } catch {}
              }
              // --------------------------------------------------

              // --- SALVA LOG DA ENTRADA NO DISCO ---
              log.push({
                t: new Date(pos.openedAt).toISOString(),
                event: "entry",
                side: "buy",
                entryPrice: pos.entryPrice,
                qty: pos.qty,
                signal: sig.reason,
                ocoId: pos.ocoId || null
              });
              const existingEntry = existsSync("micro-scalper-log.json") ? JSON.parse(readFileSync("micro-scalper-log.json", "utf8")) : [];
              if (existingEntry.length > 0 && existingEntry[existingEntry.length-1].sessionStart === new Date(sessionStart).toISOString()) {
                  existingEntry[existingEntry.length-1].trades = log;
              } else {
                  existingEntry.push({ sessionStart: new Date(sessionStart).toISOString(), trades: log });
              }
              writeFileSync("micro-scalper-log.json", JSON.stringify(existingEntry, null, 2));
              // -------------------------------------

              if (tvBridge) await tvBridge.drawEntry({ entryPrice, tpPrice: pos.tpPrice, slPrice: pos.slPrice, qty: open.qty, ts: now, label: "TURBO AUTO" });
            }

          }
        }
      }
    } catch (e) {
      console.error(`  ⚠️ Loop error: ${e.message}`);
      cooldownUntil = Date.now() + cfg.cooldown_ms;
    }
    await new Promise((r) => setTimeout(r, cfg.loop_interval_ms));
  }

  // Encerramento
  console.log(`\n📊 [SESSION SUMMARY] Trades: ${trades} | Wins: ${wins} | PnL: ${(cumPnlPct * 100).toFixed(2)}%`);
  const existing = existsSync("micro-scalper-log.json") ? JSON.parse(readFileSync("micro-scalper-log.json", "utf8")) : [];
  writeFileSync("micro-scalper-log.json", JSON.stringify([...existing, { sessionStart: new Date(sessionStart).toISOString(), trades: log }], null, 2));
}

main().catch((e) => { 
  console.error("Fatal:", e); 
  import('fs').then(fs => fs.writeFileSync("fatal-error.log", String(e.stack || e)));
  process.exit(1); 
});
