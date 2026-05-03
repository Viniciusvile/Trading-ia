import { existsSync, readFileSync, writeFileSync, unlinkSync } from "fs";

// --- TRAVA DE SEGURANÇA: IMPEDIR MÚLTIPLAS INSTÂNCIAS ---
const PID_FILE = ".micro-scalper.pid";
if (existsSync(PID_FILE)) {
  const oldPid = parseInt(readFileSync(PID_FILE, "utf8"));
  if (oldPid && oldPid !== process.pid) {
    try {
      process.kill(oldPid, 0); // lança exceção se o processo não existe
      console.error(`❌ [ERRO] O robô já está rodando (PID: ${oldPid}). Encerrando esta nova instância.`);
      process.exit(1);
    } catch (e) {} // processo morto, pode continuar
  }
}
writeFileSync(PID_FILE, process.pid.toString());
process.on("exit", () => { try { if(parseInt(readFileSync(PID_FILE, "utf8")) === process.pid) unlinkSync(PID_FILE); } catch {} });
process.on("SIGINT", () => process.exit());
process.on("SIGTERM", () => process.exit());

import { createBinanceClient } from "./src/exchange/binance.js";
import { microScalpSignal, wv5gSignal, turboReversionSignal, calcBB } from "./src/scalper/signals.js";
import { createPosition, evaluateExit, pnlPct } from "./src/scalper/position.js";
import { createTvBridge } from "./src/scalper/tv-bridge.js";

// Carregar variáveis de ambiente
const envPath = new URL(".env", import.meta.url);
if (existsSync(envPath)) {
  readFileSync(envPath, "utf8").split("\n").forEach((line) => {
    const [k, ...v] = line.split("=");
    if (k && !k.startsWith("#") && v.length) process.env[k.trim()] = v.join("=").trim();
  });
}

const mainConfig = JSON.parse(readFileSync(new URL("rules.json", import.meta.url), "utf8")).micro_scalper;
if (!mainConfig) throw new Error("rules.json is missing 'micro_scalper' block");

const client = createBinanceClient({
  apiKey: process.env.USE_BINANCE_KEY || process.env.BINANCE_API_KEY,
  secretKey: process.env.USE_BINANCE_SECRET || process.env.BINANCE_SECRET_KEY,
});

async function sendTelegram(message) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: message, disable_web_page_preview: true }),
    });
  } catch (e) { console.warn(`  ⚠ Telegram erro: ${e.message}`); }
}

function fmtQty(symbol, n, config) {
  const decimals = config.qty_decimals !== undefined ? config.qty_decimals : 0;
  const f = Math.pow(10, decimals);
  return (Math.floor(n * f) / f).toFixed(decimals);
}
function fmtQuote(n, config) {
  const f = Math.pow(10, config.quote_decimals || 2);
  return (Math.floor(n * f) / f).toFixed(config.quote_decimals || 2);
}

async function openLong(symbol, quoteUsdt, config) {
  const res = await client.placeMarketBuyQuote(symbol, fmtQuote(quoteUsdt, config));
  if (!res.ok) return { ok: false, res };
  const qty = parseFloat(res.data.executedQty || 0);
  const quoteSpent = parseFloat(res.data.cummulativeQuoteQty || 0);
  const avgPrice = qty > 0 ? quoteSpent / qty : 0;
  return { ok: qty > 0, res, qty, avgPrice };
}

async function closeLong(symbol, qty, ocoId, config) {
  if (ocoId) {
    try { await client.cancelOCO(symbol, ocoId); } catch(e) {}
  }
  const res = await client.placeMarketSellQty(symbol, fmtQty(symbol, qty, config));
  if (!res.ok) return { ok: false, res };
  const filledQty = parseFloat(res.data.executedQty || 0);
  const filledQuote = parseFloat(res.data.cummulativeQuoteQty || 0);
  const exitPrice = filledQty > 0 ? filledQuote / filledQty : 0;
  return { ok: filledQty > 0, res, qty: filledQty, exitPrice };
}

async function main() {
  const activeSymbols = mainConfig.active_symbols || [];
  console.log(`\n🤖 [MULTI-SCALPER] INICIADO — Símbolos: ${activeSymbols.join(", ")}`);
  
  await client.syncTime();
  

  const sessionStart = Date.now();
  const sessionData = {}; // Estado por símbolo
  
  activeSymbols.forEach(sym => {
    sessionData[sym] = {
      pos: null,
      trades: 0,
      wins: 0,
      cumPnlPct: 0,
      cooldownUntil: 0,
      log: [],
      config: mainConfig.plans[sym] || mainConfig.plans["DEFAULT"] || {}
    };
  });

  // --- SYNC POSITIONS AT STARTUP ---
  console.log(`\n🔄 [SYNC] Verificando posições abertas na Binance...`);
  for (const symbol of activeSymbols) {
    try {
      const asset = symbol.replace("USDT", "");
      const bals = await client.getBalances([asset]);
      let freeQty = bals[asset.toLowerCase()] || 0;
      const lastPrice = await client.getPrice(symbol);
      
      let isLogOpen = false;
      let logQty = 0;
      let logEntry = null;
      let logOcoId = null;

      try {
        const logPath = "micro-scalper-log.json";
        if (existsSync(logPath)) {
          const logs = JSON.parse(readFileSync(logPath, "utf8"));
          const allTrades = [];
          logs.forEach(s => { if(s.trades) allTrades.push(...s.trades); });
          
          const symbolTrades = allTrades.filter(t => t.symbol === symbol);
          if (symbolTrades.length > 0) {
            const last = symbolTrades[symbolTrades.length - 1];
            if (last.event === "entry") {
              isLogOpen = true;
              logQty = parseFloat(last.qty);
              logEntry = last;
              logOcoId = last.ocoId;
            }
          }
        }
      } catch (e) {}

      // Considera posição aberta se tiver saldo livre > $5 OU se estiver aberta no log (saldo bloqueado em OCO)
      if (freeQty * lastPrice > 5 || isLogOpen) {
        const cfg = sessionData[symbol].config;
        const finalQty = freeQty * lastPrice > 5 ? freeQty : logQty;
        const entryPriceToUse = isLogOpen ? logEntry.entryPrice : lastPrice;
        console.log(`  📦 [SYNC] Detectada posição de ${symbol} (${finalQty} unidades ~ $${(finalQty*lastPrice).toFixed(2)})`);
        
        const openedAt = isLogOpen ? new Date(logEntry.t).getTime() : Date.now();
        if (isLogOpen) {
          console.log(`  🕒 [SYNC] Horário de entrada recuperado para ${symbol}: ${new Date(openedAt).toLocaleString('pt-BR')}`);
        }

        const pos = createPosition({
          side: "buy", entryPrice: entryPriceToUse, qty: finalQty,
          tpPct: cfg.tp_pct || 0.015, slPct: cfg.sl_pct || 0.01,
          openedAt: openedAt, maxHoldMs: cfg.max_hold_ms || mainConfig.max_hold_ms || 3600000
        });
        
        if (logOcoId) {
          pos.ocoId = logOcoId;
          console.log(`  ✅ [SYNC-OCO] Recuperado OCO ID ativo: ${pos.ocoId}`);
        } else if (freeQty * lastPrice > 5) {
          // Tenta colocar OCO para posição sincronizada recém descoberta sem OCO
          try {
            const ocoQty = fmtQty(symbol, finalQty * 0.999, cfg);
            console.log(`  🕒 [SYNC-OCO] Tentando colocar TP/SL para ${symbol}: TP=${pos.tpPrice.toFixed(4)}, SL=${pos.slPrice.toFixed(4)}`);
            const oco = await client.placeOCO(symbol, "SELL", ocoQty, pos.tpPrice, pos.slPrice, pos.slPrice * 0.99, cfg.quote_decimals);
            if (oco.ok) {
              pos.ocoId = oco.data.orderListId;
              console.log(`  ✅ [SYNC-OCO] Ativo: ID ${pos.ocoId}`);
            }
          } catch(e) {}
        }
        
        sessionData[symbol].pos = pos;
      }
    } catch (e) {
      console.warn(`  ⚠️ Erro ao sincronizar ${symbol}: ${e.message}`);
    }
  }
  console.log(`✅ [SYNC] Sincronização concluída.\n`);

  while (Date.now() - sessionStart < mainConfig.max_session_ms) {
    const now = Date.now();
    let totalTrades = 0;
    
    for (const symbol of activeSymbols) {
      const s = sessionData[symbol];
      const cfg = s.config;
      totalTrades += s.trades;

      try {
        const lastPrice = await client.getPrice(symbol);

        if (s.pos) {
          // --- GESTÃO DE SAÍDA ---
          const exitStatus = evaluateExit(s.pos, { price: lastPrice, now });
          let shouldExit = exitStatus.shouldExit;
          let reason = exitStatus.reason;

          // --- DETECÇÃO DE SAÍDA MANUAL OU OCO EXTERNA ---
          // Só verifica saldo livre se não houver OCO ativa (pois a OCO trava o saldo e zera o free)
          if (!s.pos.ocoId && now % 10000 < 2000) { 
            const bals = await client.getBalances([symbol.replace("USDT","")]);
            const currentQty = bals[symbol.replace("USDT","").toLowerCase()] || 0;
            // Se o saldo atual for muito menor que o esperado na posição (menos de 10%)
            if (currentQty < s.pos.qty * 0.1) {
              shouldExit = true;
              reason = "external_exit_or_manual";
            }
          }

          if (s.pos.ocoId && !shouldExit) {
            try {
              const ocoRes = await client.getOCO(s.pos.ocoId);
              if (ocoRes.ok && (ocoRes.data.listOrderStatus === 'ALL_DONE' || ocoRes.data.listStatusType === 'ALL_DONE')) {
                const data = ocoRes.data;
                let filledOrder = (data.orderReports || []).find(o => o.status === 'FILLED');
                
                // Se não veio no report, busca cada ordem individualmente
                if (!filledOrder && data.orders) {
                  for (const ord of data.orders) {
                    const oRes = await client.getOrder(symbol, ord.orderId);
                    if (oRes.ok && oRes.data.status === 'FILLED') {
                      filledOrder = oRes.data;
                      break;
                    }
                  }
                }

                if (filledOrder) {
                  const execQty = parseFloat(filledOrder.executedQty || 0);
                  const quoteQty = parseFloat(filledOrder.cummulativeQuoteQty || 0);
                  s.pos.exitPrice = execQty > 0 ? quoteQty / execQty : parseFloat(filledOrder.price || filledOrder.stopPrice);
                  s.pos.updateTime = filledOrder.updateTime;
                }
                
                shouldExit = true;
                reason = "binance_oco_filled";
              }
            } catch (e) {
              console.warn(`  ⚠ Erro ao verificar OCO ${symbol}: ${e.message}`);
            }
          }

          if (shouldExit) {
            let r = { ok: false, exitPrice: lastPrice };
            
            // Se foi OCO preenchida, não tentamos vender de novo
            if (reason === "binance_oco_filled") {
              r.ok = true; // Consideramos OK pois a venda já ocorreu na Binance
              r.exitPrice = s.pos.exitPrice;
            } else {
              r = await closeLong(symbol, s.pos.qty, s.pos.ocoId, cfg);
            }

            const exitPx = s.pos.exitPrice || r.exitPrice || lastPrice;
            // Calculamos o PnL sempre que houver preço de saída, mesmo se r.ok for false (fallback)
            const realizedPct = pnlPct(s.pos, exitPx);
            s.cumPnlPct += realizedPct;
            if (realizedPct > 0) s.wins++;
            s.trades++;
            
            const pnlUsdt = (exitPx - s.pos.entryPrice) * s.pos.qty;
            s.log.push({ 
              t: new Date(now).toISOString(), 
              event: "exit", 
              reason, 
              pnlPct: realizedPct, 
              pnlUsdt: parseFloat(pnlUsdt.toFixed(8)), 
              qty: s.pos.qty, 
              ok: r.ok, 
              entryPrice: s.pos.entryPrice, // Adicionado para facilitar o Dashboard
              exitPrice: exitPx 
            });
            
            saveGlobalLog(sessionStart, symbol, s.log);
            console.log(`  🚀 [EXIT] ${symbol} | ${reason} @ ${exitPx.toFixed(4)} | PnL: ${(realizedPct * 100).toFixed(2)}%`);
            sendTelegram(`🔴 [SCALPER] VENDA ${symbol}\nMotivo: ${reason}\nPnL: ${(realizedPct * 100).toFixed(2)}%\nTotal ${symbol}: ${(s.cumPnlPct * 100).toFixed(2)}%`);
            
            s.pos = null;
            // Cooldown maior após loss para evitar revenge trade no mesmo movimento
            const baseCooldown = mainConfig.cooldown_ms || 5000;
            const lossCooldown = mainConfig.cooldown_after_loss_ms || baseCooldown;
            s.cooldownUntil = now + (realizedPct < 0 ? lossCooldown : baseCooldown);
          }
        } else if (now >= s.cooldownUntil && s.trades < mainConfig.max_trades) {
          // --- BUSCA DE SINAL ---
          const candles = await client.getKlines(symbol, "5m", 50);
          let sig;
          
          if (cfg.strategy_mode === "turbo-reversion") {
            sig = turboReversionSignal(candles, {
              bbLen: cfg.bb_length, bbMult: cfg.bb_mult,
              rsiLen: cfg.rsi_period, rsiLimit: cfg.rsi_limit, volMult: cfg.vol_mult,
              trendEmaPeriod: cfg.trend_ema_period || 0,
              trendSlopeBars: cfg.trend_slope_bars || 5,
              trendMaxDownPct: cfg.trend_max_down_pct || 0,
              minAtrPct: cfg.min_atr_pct || 0,
            });
          } else {
            sig = microScalpSignal(candles, {
              emaPeriod: cfg.ema_period, rsiPeriod: cfg.rsi_period,
              minDip: cfg.min_dip_pct, minRsi: cfg.min_rsi, maxRsi: cfg.max_rsi,
              trendEmaPeriod: cfg.trend_ema_period || 0,
              trendSlopeBars: cfg.trend_slope_bars || 5,
              trendMaxDownPct: cfg.trend_max_down_pct || 0,
              minAtrPct: cfg.min_atr_pct || 0,
            });
          }

          if (sig.signal === "buy") {
            const bals = await client.getBalances([symbol.replace("USDT",""), "USDT"]);
            const tradeUsdt = Math.min(bals.usdt * 0.95, mainConfig.max_trade_usdt);
            
            if (bals.usdt >= mainConfig.min_trade_usdt) {
              console.log(`  🎯 [SIGNAL] ${symbol} | ${sig.reason} detectado!`);
              const open = await openLong(symbol, tradeUsdt, cfg);
              if (open.ok) {
                const entryPrice = open.avgPrice || lastPrice;
                s.pos = createPosition({
                  side: "buy", entryPrice, qty: open.qty,
                  tpPct: cfg.tp_pct || 0.015, slPct: cfg.sl_pct || 0.01,
                  openedAt: now, maxHoldMs: cfg.max_hold_ms || mainConfig.max_hold_ms || 3600000,
                });
                
                try {
                  const ocoQty = fmtQty(symbol, open.qty * 0.999, cfg);
                  console.log(`  🕒 [OCO] Tentando colocar TP/SL para ${symbol}: TP=${s.pos.tpPrice.toFixed(4)}, SL=${s.pos.slPrice.toFixed(4)}`);
                  const oco = await client.placeOCO(symbol, "SELL", ocoQty, s.pos.tpPrice, s.pos.slPrice, s.pos.slPrice * 0.99, cfg.quote_decimals);
                  if (oco.ok) {
                    s.pos.ocoId = oco.data.orderListId;
                    console.log(`  ✅ [OCO] Ativo: ID ${s.pos.ocoId}`);
                  } else {
                    console.error(`  ❌ [OCO] Falha da API Binance: ${JSON.stringify(oco.data)}`);
                    sendTelegram(`⚠️ [SCALPER] Erro OCO ${symbol}: ${oco.data.msg || "Erro desconhecido"}`);
                  }
                } catch(e) {
                  console.error(`  ❌ [OCO] Erro de rede/sintaxe: ${e.message}`);
                }

                s.log.push({ 
                  t: new Date(now).toISOString(), 
                  event: "entry", 
                  side: "buy", 
                  entryPrice, 
                  qty: open.qty, 
                  signal: sig.reason, 
                  ocoId: s.pos.ocoId || null,
                  tpPrice: s.pos.tpPrice,
                  slPrice: s.pos.slPrice
                });
                saveGlobalLog(sessionStart, symbol, s.log);
                
                console.log(`  🟢 [ENTRY] ${symbol} COMPRADO @ ${entryPrice.toFixed(4)}`);
                sendTelegram(`🟢 [SCALPER] COMPRA ${symbol}\nPreço: $${entryPrice.toFixed(4)}\nSinal: ${sig.reason}`);
              }
            }
          }
        }
      } catch (e) {
        console.error(`  ⚠️ [${symbol}] Loop error: ${e.message}`);
      }
    }
    
    if (totalTrades >= mainConfig.max_trades * activeSymbols.length) break;
    await new Promise((r) => setTimeout(r, mainConfig.loop_interval_ms));
  }
}

function saveGlobalLog(sessionStart, symbol, trades) {
  try {
    const logPath = "micro-scalper-log.json";
    const existing = existsSync(logPath) ? JSON.parse(readFileSync(logPath, "utf8")) : [];
    const sessionKey = new Date(sessionStart).toISOString();
    let session = existing.find(s => s.sessionStart === sessionKey);
    if (!session) {
      session = { sessionStart: sessionKey, trades: [] };
      existing.push(session);
    }
    // Adiciona o símbolo no log para o dashboard filtrar
    const formattedTrades = trades.map(t => ({ ...t, symbol }));
    // Mescla mantendo apenas os mais recentes por evento/timestamp
    session.trades = [...session.trades.filter(t => t.symbol !== symbol), ...formattedTrades];
    writeFileSync(logPath, JSON.stringify(existing, null, 2));
  } catch(e) {}
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });
