import { existsSync, readFileSync, writeFileSync, unlinkSync } from "fs";
import * as db from "./masterbot/db.js";

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

let rulesObj = {};
try {
  rulesObj = JSON.parse(readFileSync(new URL("rules.json", import.meta.url), "utf8"));
} catch (e) {}

let mainConfig = rulesObj.micro_scalper;
if (!mainConfig || !mainConfig.plans) {
  mainConfig = {
    active_symbols: ["XRPUSDT", "SOLUSDT"],
    max_trade_usdt: 30,
    min_trade_usdt: 5,
    max_session_ms: 86400000,
    cooldown_ms: 5000,
    cooldown_after_loss_ms: 10000,
    max_trades: 50,
    daily_profit_target_usdt: 0,
    btc_drop_block_pct: 0.015,
    plans: {
      XRPUSDT: {
        strategy_mode: "turbo-reversion",
        bb_length: 20, bb_mult: 2.0, rsi_period: 3, rsi_limit: 30, vol_mult: 1.5,
        tp_pct: 0.015, sl_pct: 0.005, qty_decimals: 1, quote_decimals: 4
      },
      SOLUSDT: {
        strategy_mode: "micro-dip",
        ema_period: 20, rsi_period: 3, min_dip_pct: 0.001, min_rsi: 20, max_rsi: 65,
        tp_pct: 0.010, sl_pct: 0.005, qty_decimals: 2, quote_decimals: 2
      }
    }
  };
  console.warn("⚠️ 'micro_scalper' block ausente ou vazio em rules.json. Utilizando fallback padrão de alta resiliência.");
}

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
  let decimals = config?.qty_decimals;
  if (decimals === undefined) {
    if (symbol.startsWith("BTC")) decimals = 5;
    else if (symbol.startsWith("ETH")) decimals = 4;
    else if (symbol.startsWith("SOL")) decimals = 2;
    else decimals = 0;
  }
  const f = Math.pow(10, decimals);
  return (Math.floor(n * f) / f).toFixed(decimals);
}
function fmtQuote(n, config) {
  const f = Math.pow(10, config?.quote_decimals || 2);
  return (Math.floor(n * f) / f).toFixed(config?.quote_decimals || 2);
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
  const baseAsset = symbol.replace("USDT", "");
  let sellQty = qty;
  try {
    const bals = await client.getBalances([baseAsset]);
    const actualFree = bals[baseAsset.toLowerCase()];
    if (actualFree !== undefined && actualFree < qty) {
      sellQty = actualFree;
    }
  } catch (e) {}

  const finalQtyStr = fmtQty(symbol, sellQty, config);
  if (parseFloat(finalQtyStr) <= 0) {
    console.error(`❌ [ERRO SELL] Quantidade muito baixa para fechar ${symbol}: ${finalQtyStr}`);
    return { ok: false, res: { data: { msg: "Qty rounded to zero based on precision" } } };
  }

  const res = await client.placeMarketSellQty(symbol, finalQtyStr);
  if (!res.ok) return { ok: false, res };
  const filledQty = parseFloat(res.data.executedQty || 0);
  const filledQuote = parseFloat(res.data.cummulativeQuoteQty || 0);
  const exitPrice = filledQty > 0 ? filledQuote / filledQty : 0;
  return { ok: filledQty > 0, res, qty: filledQty, exitPrice };
}

async function main() {
  try {
    await db.initDb();
  } catch (e) {
    console.error("⚠️ PostgreSQL indisponível na inicialização do Micro-Scalper:", e.message);
    console.warn("   O robô prosseguirá operando com alta resiliência em fallback local.");
  }
  await db.writeMicroHeartbeat(process.pid).catch(() => {});
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
      consecutiveLosses: 0,
      log: [],
      config: mainConfig.plans[sym] || mainConfig.plans["DEFAULT"] || {}
    };
  });

  // PnL diário acumulado (zera à meia-noite UTC)
  let dailyPnlUsdt = 0;
  let dailyDate = new Date().toISOString().slice(0, 10);

  // Referência de preço do BTC para filtro de queda brusca
  let btcPriceRef = null;
  let btcPriceRefTime = 0;

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
        const symbolTrades = await db.loadMicroSymbolTrades(symbol);
        if (symbolTrades.length > 0) {
          const last = symbolTrades[symbolTrades.length - 1];
          if (last.event === "entry") {
            isLogOpen = true;
            logQty = parseFloat(last.qty);
            logEntry = last;
            logOcoId = last.ocoId;
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
        
        const dbId = logEntry?.id || `POS-SCALPER-${openedAt}`;
        pos.dbId = dbId;

        const dbPos = {
          id: dbId,
          symbol,
          status: "open",
          plan: "Micro-Scalper",
          side: "LONG",
          orderId: logEntry?.orderId || `MS-RECOVERY-${openedAt}`,
          openedAt: new Date(openedAt).toISOString(),
          quantity: finalQty,
          strategy: cfg.strategy_mode || "micro-dip",
          stopPrice: pos.slPrice,
          takeProfitPrice: pos.tpPrice,
          entryPrice: entryPriceToUse,
          ocoOrderListId: pos.ocoId ? Number(pos.ocoId) : null,
          timeframe: "5m"
        };
        await db.savePosition(dbPos).catch(() => {});
        
        if (logOcoId) {
          pos.ocoId = logOcoId;
          console.log(`  ✅ [SYNC-OCO] Recuperado OCO ID ativo: ${pos.ocoId}`);
          dbPos.ocoOrderListId = Number(pos.ocoId);
          await db.savePosition(dbPos).catch(() => {});
        } else if (freeQty * lastPrice > 5) {
          // Tenta colocar OCO para posição sincronizada recém descoberta sem OCO
          try {
            const ocoQty = fmtQty(symbol, finalQty * 0.999, cfg);
            if (parseFloat(ocoQty) <= 0) {
              console.error(`  ❌ [SYNC-OCO] ${symbol}: qty_decimals=${cfg.qty_decimals ?? 0} arredondou ${finalQty} para ${ocoQty}. Ajuste rules.json.`);
            } else {
              console.log(`  🕒 [SYNC-OCO] Tentando colocar TP/SL para ${symbol}: qty=${ocoQty}, TP=${pos.tpPrice.toFixed(4)}, SL=${pos.slPrice.toFixed(4)}`);
              const oco = await client.placeOCO(symbol, "SELL", ocoQty, pos.tpPrice, pos.slPrice, pos.slPrice * 0.99, cfg.quote_decimals);
              if (oco.ok) {
                pos.ocoId = oco.data.orderListId;
                console.log(`  ✅ [SYNC-OCO] Ativo: ID ${pos.ocoId}`);
                dbPos.ocoOrderListId = Number(pos.ocoId);
                await db.savePosition(dbPos).catch(() => {});
              } else {
                console.error(`  ❌ [SYNC-OCO] Falha: ${oco.data?.msg || JSON.stringify(oco.data)}`);
              }
            }
          } catch(e) { console.error(`  ❌ [SYNC-OCO] Exception: ${e.message}`); }
        }
        
        sessionData[symbol].pos = pos;
        sessionData[symbol].log.push(isLogOpen ? logEntry : {
          t: new Date(openedAt).toISOString(),
          event: "entry",
          side: "buy",
          entryPrice: entryPriceToUse,
          qty: finalQty,
          signal: "sync-recovery",
          ocoId: pos.ocoId || null,
          tpPrice: pos.tpPrice,
          slPrice: pos.slPrice
        });
      }
    } catch (e) {
      console.warn(`  ⚠️ Erro ao sincronizar ${symbol}: ${e.message}`);
    }
  }
  console.log(`✅ [SYNC] Sincronização concluída.\n`);

  while (Date.now() - sessionStart < mainConfig.max_session_ms) {
    const now = Date.now();
    let totalTrades = 0;

    // --- RESET DIÁRIO (meia-noite UTC) ---
    const todayUtc = new Date().toISOString().slice(0, 10);
    if (todayUtc !== dailyDate) {
      console.log(`🌅 [DIÁRIO] Novo dia UTC — PnL ontem: ${dailyPnlUsdt >= 0 ? '+' : ''}${dailyPnlUsdt.toFixed(4)} USDT. Resetando contadores.`);
      dailyPnlUsdt = 0;
      dailyDate = todayUtc;
      activeSymbols.forEach(sym => { sessionData[sym].consecutiveLosses = 0; });
    }

    // --- FILTRO DE HORÁRIO UTC (evitar horas ruins) ---
    const utcHour = new Date().getUTCHours();
    const blockedHours = mainConfig.blocked_hours_utc || [];
    const inBlockedHour = blockedHours.includes(utcHour);
    if (inBlockedHour) {
      console.log(`🌙 [HORA] ${utcHour}h UTC bloqueado — mercado fraco nesse horário. Aguardando...`);
      await new Promise(r => setTimeout(r, 60000));
      continue;
    }

    // --- FILTRO BTC: evitar entrar durante queda brusca ---
    let btcDroppingFast = false;
    try {
      const btcNow = await client.getPrice("BTCUSDT");
      const btcDropThreshold = mainConfig.btc_drop_block_pct || 0.015;
      const btcRefAgeMs = mainConfig.btc_ref_age_ms || 900000; // 15 min
      if (!btcPriceRef || (now - btcPriceRefTime) > btcRefAgeMs) {
        btcPriceRef = btcNow;
        btcPriceRefTime = now;
      }
      const btcChange = (btcNow - btcPriceRef) / btcPriceRef;
      if (btcChange < -btcDropThreshold) {
        btcDroppingFast = true;
        console.log(`⚠️ [BTC] Queda de ${(btcChange*100).toFixed(2)}% em 15min — bloqueando novas entradas`);
      }
    } catch (e) {}

    // --- META DIÁRIA DE LUCRO ---
    const dailyProfitTarget = mainConfig.daily_profit_target_usdt || 0;
    if (dailyProfitTarget > 0 && dailyPnlUsdt >= dailyProfitTarget) {
      console.log(`🎯 [META] Meta diária atingida (+${dailyPnlUsdt.toFixed(4)} USDT) — sem novas entradas hoje!`);
      await new Promise(r => setTimeout(r, 300000));
      continue;
    }

    for (const symbol of activeSymbols) {
      const s = sessionData[symbol];
      const cfg = s.config;
      totalTrades += s.trades;

      try {
        const lastPrice = await client.getPrice(symbol);

        if (s.pos) {
          // --- BREAKEVEN TRAILING STOP ---
          // Quando o preço sobe X% (breakeven_pct), move o SL para a entrada + 0.05%
          // Evita que trade vencedor vire perdedor por timeout ou reversão
          if (!s.pos.breakevenTriggered && cfg.breakeven_pct) {
            const breakevenThreshold = s.pos.entryPrice * (1 + cfg.breakeven_pct);
            if (lastPrice >= breakevenThreshold) {
              const newSl = s.pos.entryPrice * 1.0005;
              s.pos.slPrice = newSl;
              s.pos.breakevenTriggered = true;
              console.log(`  🔒 [BREAKEVEN] ${symbol} @ $${lastPrice.toFixed(4)} — SL travado em $${newSl.toFixed(4)} (+0.05%)`);
            }
          }

          // --- GESTÃO DE SAÍDA ---
          const exitStatus = evaluateExit(s.pos, { price: lastPrice, now });
          let shouldExit = exitStatus.shouldExit;
          let reason = exitStatus.reason;

          // --- DETECÇÃO DE SAÍDA MANUAL OU OCO EXTERNA ---
          // Se não houver OCO, verifica se o saldo sumiu (manual)
          if (!s.pos.ocoId && now % 5000 < 1000) { 
            const asset = symbol.replace("USDT","");
            const bals = await client.getBalances([asset]);
            const currentQty = bals[asset.toLowerCase()] || 0;
            if (currentQty < s.pos.qty * 0.1) {
              shouldExit = true;
              reason = "external_exit_or_manual";
            }
          }

          // Se houver OCO, verifica se foi preenchida ou cancelada
          if (s.pos.ocoId && !shouldExit) {
            try {
              const ocoRes = await client.getOCO(s.pos.ocoId);
              if (ocoRes.ok) {
                const data = ocoRes.data;
                const isAllDone = (data.listOrderStatus === 'ALL_DONE' || data.listStatusType === 'ALL_DONE');
                const isRejected = (data.listOrderStatus === 'REJECTED');

                if (isAllDone) {
                  let filledOrder = (data.orderReports || []).find(o => o.status === 'FILLED');
                  if (!filledOrder && data.orders) {
                    for (const ord of data.orders) {
                      const oRes = await client.getOrder(symbol, ord.orderId);
                      if (oRes.ok && oRes.data.status === 'FILLED') { filledOrder = oRes.data; break; }
                    }
                  }
                  if (filledOrder) {
                    const execQty = parseFloat(filledOrder.executedQty || 0);
                    const quoteQty = parseFloat(filledOrder.cummulativeQuoteQty || 0);
                    s.pos.exitPrice = execQty > 0 ? quoteQty / execQty : parseFloat(filledOrder.price || filledOrder.stopPrice);
                  }
                  shouldExit = true;
                  reason = "binance_oco_filled";
                } else if (isRejected) {
                  // OCO cancelada — verifica se o saldo ainda existe
                  const asset = symbol.replace("USDT","");
                  const bals = await client.getBalances([asset]);
                  if ((bals[asset.toLowerCase()] || 0) < s.pos.qty * 0.1) {
                    shouldExit = true;
                    reason = "external_exit_or_manual";
                  }
                }
              } else {
                // Erro ao buscar OCO (ex: ID inválido ou ordem removida da Binance)
                // Se a OCO sumiu e o saldo é zero, então fechou por fora.
                const asset = symbol.replace("USDT","");
                const bals = await client.getBalances([asset]);
                if ((bals[asset.toLowerCase()] || 0) < s.pos.qty * 0.1) {
                  shouldExit = true;
                  reason = "external_exit_or_manual";
                }
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
            if (realizedPct > 0) { s.wins++; s.consecutiveLosses = 0; }
            else if (realizedPct < -0.0001) { s.consecutiveLosses++; }
            s.trades++;

            const pnlUsdt = (exitPx - s.pos.entryPrice) * s.pos.qty;
            dailyPnlUsdt += pnlUsdt;
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
            
            await saveGlobalLog(sessionStart, symbol, s.log);
            console.log(`  🚀 [EXIT] ${symbol} | ${reason} @ ${exitPx.toFixed(4)} | PnL: ${(realizedPct * 100).toFixed(2)}%`);
            const usdBrl = 5.7;
            const pnlBrl = (pnlUsdt * usdBrl).toFixed(2);
            const resultado = pnlUsdt >= 0 ? '✅ LUCRO' : '❌ PREJUÍZO';
            const duracao = s.pos.openedAt ? Math.round((now - s.pos.openedAt) / 60000) : '?';
            const exitLabel = reason === 'tp' || reason === 'binance_oco_filled' && exitPx >= s.pos.tpPrice * 0.999 ? 'Take Profit ✅' : reason === 'sl' ? 'Stop Loss 🛑' : reason === 'timeout' ? 'Timeout ⏰' : reason;
            sendTelegram(
              `${resultado} — ${symbol} [SCALPER]\n\n📋 Resumo do Trade\n` +
              `Entrada: $${s.pos.entryPrice.toFixed(6)}\n` +
              `Saída:   $${exitPx.toFixed(6)}\n` +
              `Motivo:  ${exitLabel}\n\n` +
              `💰 PnL: ${pnlUsdt >= 0 ? '+' : ''}${pnlUsdt.toFixed(4)} USD\n` +
              `💵 Em BRL: R$ ${pnlUsdt >= 0 ? '+' : ''}${pnlBrl}\n` +
              `📊 Variação: ${(realizedPct * 100) >= 0 ? '+' : ''}${(realizedPct * 100).toFixed(2)}%\n` +
              `⏱ Duração: ${duracao} minutos\n` +
              `📊 Sessão ${symbol}: ${(s.cumPnlPct * 100) >= 0 ? '+' : ''}${(s.cumPnlPct * 100).toFixed(2)}%`
            );
            
            if (s.pos && s.pos.dbId) {
              try {
                const dbPos = {
                  id: s.pos.dbId,
                  symbol,
                  status: "closed",
                  plan: "Micro-Scalper",
                  side: "LONG",
                  orderId: s.pos.orderId || `MS-${s.pos.openedAt}`,
                  openedAt: new Date(s.pos.openedAt).toISOString(),
                  quantity: s.pos.qty,
                  strategy: cfg.strategy_mode || "micro-dip",
                  stopPrice: s.pos.slPrice,
                  takeProfitPrice: s.pos.tpPrice,
                  entryPrice: s.pos.entryPrice,
                  exitPrice: exitPx,
                  pnl: pnlUsdt,
                  ocoOrderListId: s.pos.ocoId ? Number(s.pos.ocoId) : null,
                  timeframe: "5m",
                  closedAt: new Date(now).toISOString()
                };
                await db.savePosition(dbPos);
              } catch (e) {
                console.error("  ❌ Erro ao fechar posição do scalper no banco:", e.message);
              }
            }
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
            // --- CIRCUIT BREAKER: perdas consecutivas ---
            const maxConsec = mainConfig.max_consecutive_losses || 3;
            const consecCooldownMs = mainConfig.cooldown_consecutive_loss_ms || 1800000; // 30 min
            if (s.consecutiveLosses >= maxConsec) {
              const elapsed = now - s.cooldownUntil + consecCooldownMs;
              console.log(`  🛑 [CIRCUIT] ${symbol}: ${s.consecutiveLosses} perdas seguidas — pausado por ${(consecCooldownMs/60000).toFixed(0)} min`);
              s.cooldownUntil = now + consecCooldownMs;
              s.consecutiveLosses = 0;
              continue;
            }

            // --- FILTRO BTC: não entrar se BTC caindo rápido ---
            if (btcDroppingFast) {
              console.log(`  🚫 [BTC] ${symbol}: entrada bloqueada por queda do BTC`);
              continue;
            }

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
                
                const dbId = `POS-SCALPER-${now}`;
                s.pos.dbId = dbId;
                const dbPos = {
                  id: dbId,
                  symbol,
                  status: "open",
                  plan: "Micro-Scalper",
                  side: "LONG",
                  orderId: open.res?.data?.orderId ? String(open.res.data.orderId) : `MS-${now}`,
                  openedAt: new Date(now).toISOString(),
                  quantity: open.qty,
                  strategy: cfg.strategy_mode || "micro-dip",
                  stopPrice: s.pos.slPrice,
                  takeProfitPrice: s.pos.tpPrice,
                  entryPrice: entryPrice,
                  ocoOrderListId: null,
                  timeframe: "5m"
                };
                await db.savePosition(dbPos).catch(err => {
                  console.error("  ❌ Erro ao salvar posição no banco:", err.message);
                });
                
                try {
                  const ocoQty = fmtQty(symbol, open.qty * 0.999, cfg);
                  // Validação: se a quantidade ficou zerada, qty_decimals está errado para esse ativo
                  if (parseFloat(ocoQty) <= 0) {
                    const msg = `qty_decimals=${cfg.qty_decimals ?? 0} arredondou ${open.qty} para ${ocoQty}. Ajuste rules.json.`;
                    console.error(`  ❌ [OCO] ${symbol}: ${msg}`);
                    sendTelegram(`🚨 [SCALPER] OCO BLOQUEADO ${symbol}\n${msg}`);
                  } else {
                    console.log(`  🕒 [OCO] Tentando colocar TP/SL para ${symbol}: qty=${ocoQty}, TP=${s.pos.tpPrice.toFixed(4)}, SL=${s.pos.slPrice.toFixed(4)}`);
                    const oco = await client.placeOCO(symbol, "SELL", ocoQty, s.pos.tpPrice, s.pos.slPrice, s.pos.slPrice * 0.99, cfg.quote_decimals);
                    if (oco.ok) {
                      s.pos.ocoId = oco.data.orderListId;
                      console.log(`  ✅ [OCO] Ativo: ID ${s.pos.ocoId}`);
                      dbPos.ocoOrderListId = Number(s.pos.ocoId);
                      await db.savePosition(dbPos).catch(() => {});
                    } else {
                      const errMsg = oco.data?.msg || JSON.stringify(oco.data);
                      console.error(`  ❌ [OCO] Falha da API Binance: ${errMsg}`);
                      sendTelegram(`⚠️ [SCALPER] Erro OCO ${symbol}: ${errMsg}`);
                    }
                  }
                } catch(e) {
                  console.error(`  ❌ [OCO] Erro de rede/sintaxe: ${e.message}`);
                  sendTelegram(`⚠️ [SCALPER] Exception OCO ${symbol}: ${e.message}`);
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
                await saveGlobalLog(sessionStart, symbol, s.log);
                
                console.log(`  🟢 [ENTRY] ${symbol} COMPRADO @ ${entryPrice.toFixed(4)}`);
                // Sem notificação de abertura — apenas resumo ao fechar
              }
            } else {
              console.log(`  ⚠️ [SALDO] ${symbol}: Sinal de compra (${sig.reason}) ignorado! Saldo livre na Binance (${bals.usdt.toFixed(2)} USDT) é menor que o mínimo exigido (${mainConfig.min_trade_usdt} USDT).`);
            }
          }
        }
      } catch (e) {
        console.error(`  ⚠️ [${symbol}] Loop error: ${e.message}`);
      }
    }
    
    if (totalTrades >= mainConfig.max_trades * activeSymbols.length) break;
    await db.writeMicroHeartbeat(process.pid).catch(() => {});
    await new Promise((r) => setTimeout(r, mainConfig.loop_interval_ms));
  }
}

async function saveGlobalLog(sessionStart, symbol, trades) {
  try {
    await db.saveMicroSession(new Date(sessionStart).toISOString(), symbol, trades);
  } catch(e) { console.error(`  ⚠ [LOG] Falha ao salvar sessão no banco: ${e.message}`); }
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });
