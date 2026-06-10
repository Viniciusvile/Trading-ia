/**
 * Cliente leve para a API legada do dashboard (server.js antigo).
 * Em produção, Next rewrites delega /api/legacy/* → http://127.0.0.1:3334
 * (o servidor antigo continua rodando atrás do scenes, mas em outra porta).
 *
 * Em dev local sem servidor: as funções devolvem dados vazios para a UI não quebrar.
 */

const BASE = "/api/legacy";

async function safeJson<T>(path: string, init?: RequestInit, fallback?: T): Promise<T> {
  try {
    const res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as T;
  } catch (err) {
    if (fallback !== undefined) return fallback;
    throw err;
  }
}

export const api = {
  health: () => safeJson<{ ok: boolean }>("/health", undefined, { ok: false }),

  quote: (symbol: string) =>
    safeJson<{
      symbol: string;
      last: number;
      change: number;
      changePct: number;
      high: number;
      low: number;
      volume: number;
    } | null>(`/quote?symbol=${encodeURIComponent(symbol)}`, undefined, null),

  state: () =>
    safeJson<{
      symbol: string;
      timeframe: string;
      indicators: { id: string; name: string }[];
    } | null>("/state", undefined, null),

  ohlcv: (symbol: string, timeframe = "1D", count = 30) =>
    safeJson<{
      bars: { time: number; open: number; high: number; low: number; close: number; volume: number }[];
    } | null>(
      `/ohlcv?symbol=${encodeURIComponent(symbol)}&timeframe=${timeframe}&count=${count}`,
      undefined,
      null,
    ),

  indicators: () =>
    safeJson<Record<string, number | string>>("/indicators", undefined, {}),

  journalList: () =>
    safeJson<{ entries: { id: string; date: string; title: string; body: string }[] }>(
      "/journal",
      undefined,
      { entries: [] },
    ),

  journalAdd: (entry: { title: string; body: string }) =>
    safeJson("/journal", { method: "POST", body: JSON.stringify(entry) }),

  journalDelete: (id: string) =>
    safeJson(`/journal/${id}`, { method: "DELETE" }),

  alertList: () =>
    safeJson<{ alerts: { id: string; symbol: string; price: number; condition: string }[] }>(
      "/alerts",
      undefined,
      { alerts: [] },
    ),

  alertCreate: (a: { symbol: string; price: number; condition: string }) =>
    safeJson("/alerts", { method: "POST", body: JSON.stringify(a) }),

  alertDelete: () => safeJson("/alerts", { method: "DELETE" }),

  botConfig: () =>
    safeJson<{
      mode: string;
      symbol: string;
      timeframe: string;
      paperTrading: boolean;
      maxTradeSize: number;
    } | null>("/bot/config", undefined, null),

  botLog: () =>
    safeJson<{ success: boolean; trades?: any[] }>("/bot/log", undefined, { success: false }),

  botMasterRawLog: () =>
    safeJson<{ success: boolean; lines: string[]; message?: string }>("/bot/master/raw-log", undefined, { success: false, lines: [] }),

  botEmergencySell: () =>
    safeJson<{ success: boolean; message?: string }>("/bot/emergency-sell", { method: "POST" }),

  botBalance: () =>
    safeJson<{ success: boolean; spot?: number; futures?: number }>("/bot/balance", undefined, { success: false }),

  botMasterStatus: () =>
    safeJson<{ success: boolean; isAlive: boolean; status?: string }>("/bot/master/status", undefined, { success: false, isAlive: false }),

  botMasterStart: () =>
    safeJson<{ success: boolean; error?: string }>("/bot/master/start", { method: "POST" }),

  botMasterStop: () =>
    safeJson<{ success: boolean; error?: string }>("/bot/master/stop", { method: "POST" }),

  microScalperStatus: () =>
    safeJson<{ success: boolean; running: boolean }>("/micro-scalper/status", undefined, { success: false, running: false }),

  microScalperStart: () =>
    safeJson<{ success: boolean; error?: string }>("/micro-scalper/start", { method: "POST" }),

  microScalperStop: () =>
    safeJson<{ success: boolean; error?: string }>("/micro-scalper/stop", { method: "POST" }),

  botFuturesStatus: () =>
    safeJson<{ success: boolean; isAlive: boolean; status?: string }>("/bot/futures/status", undefined, { success: false, isAlive: false }),

  botFuturesStart: () =>
    safeJson<{ success: boolean; error?: string }>("/bot/futures/start", { method: "POST" }),

  botFuturesStop: () =>
    safeJson<{ success: boolean; error?: string }>("/bot/futures/stop", { method: "POST" }),

  microScalperSignal: (symbol: string) =>
    safeJson<{ action: string; confidence: number; reason: string } | null>(
      `/micro-scalper/signal?symbol=${encodeURIComponent(symbol)}`,
      undefined,
      null,
    ),

  strategyResults: () =>
    safeJson<{
      totalTrades: number;
      winRate: number;
      profitFactor: number;
      netProfit: number;
    } | null>("/strategy", undefined, null),

  strategyTrades: () =>
    safeJson<{ trades: { id: string; date: string; side: string; pnl: number }[] }>(
      "/strategy/trades",
      undefined,
      { trades: [] },
    ),

  watchlist: () =>
    safeJson<{ items: { symbol: string; description?: string }[] }>(
      "/watchlist",
      undefined,
      { items: [] },
    ),

  symbolSearch: (q: string) =>
    safeJson<{ results: { symbol: string; description: string }[] }>(
      `/symbol-search?q=${encodeURIComponent(q)}`,
      undefined,
      { results: [] },
    ),

  botStrategies: () =>
    safeJson<{
      success: boolean;
      strategies: {
        name: string;
        description: string;
        symbols: string[];
        timeframes: string[];
        strategy: string;
        mode: string;
        leverage: number;
        active: boolean;
        winRate: number;
        profitFactor: number;
        netProfit: number;
        totalTrades: number;
        filters: any;
        sl: any;
        tp: any;
      }[];
    }>("/bot/strategies", undefined, { success: false, strategies: [] }),

  botStrategyCreate: (strat: any) =>
    safeJson<{ success: boolean; strategy?: any }>("/bot/strategies", {
      method: "POST",
      body: JSON.stringify(strat),
    }, { success: false }),

  botStrategyActivate: (name: string) =>
    safeJson<{ success: boolean }>(`/bot/strategies/${encodeURIComponent(name)}/activate`, {
      method: "POST",
    }, { success: false }),

  botStrategyDeactivate: (name: string) =>
    safeJson<{ success: boolean }>(`/bot/strategies/${encodeURIComponent(name)}/deactivate`, {
      method: "POST",
    }, { success: false }),

  botStrategyDelete: (name: string) =>
    safeJson<{ success: boolean }>(`/bot/strategies/${encodeURIComponent(name)}`, {
      method: "DELETE",
    }, { success: false }),

  botForceTrade: (params: { symbol: string; timeframe: string; side: string; amount?: number; mode: string }) =>
    safeJson<{ success: boolean; exitCode?: number; stdout?: string; stderr?: string; error?: string }>("/bot/force-trade", {
      method: "POST",
      body: JSON.stringify(params),
    }, { success: false, error: "Falha na requisição" }),

  botPositions: () =>
    safeJson<{
      success: boolean;
      positions: {
        id: string;
        symbol: string;
        timeframe: string;
        side: string;
        entryPrice: number;
        quantity: number;
        stopPrice: number;
        takeProfitPrice: number;
        orderId: string;
        ocoOrderListId: string | null;
        openedAt: string;
        status: string;
        strategy?: string;
        plan?: string;
      }[];
    }>("/bot/positions", undefined, { success: false, positions: [] }),

  botClosePosition: (id: string, markOnly?: boolean) =>
    safeJson<{ success: boolean; error?: string }>(`/bot/positions/${encodeURIComponent(id)}/close${markOnly ? "?markOnly=true" : ""}`, {
      method: "POST",
    }, { success: false, error: "Falha na requisição" }),

  // ─── Multi-Account API Endpoints ───
  accountsList: () =>
    safeJson<{
      success: boolean;
      accounts: {
        id: string;
        name: string;
        apiKey: string;
        isActive: boolean;
        isTestnet: boolean;
        createdAt: string;
      }[];
    }>("/accounts", undefined, { success: false, accounts: [] }),

  accountCreate: (params: { name: string; apiKey: string; secretKey: string; isTestnet: boolean }) =>
    safeJson<{ success: boolean; id?: string; error?: string }>("/accounts", {
      method: "POST",
      body: JSON.stringify(params),
    }, { success: false, error: "Falha ao criar conta" }),

  accountActivate: (id: string) =>
    safeJson<{ success: boolean; error?: string }>(`/accounts/${encodeURIComponent(id)}/activate`, {
      method: "POST",
    }, { success: false, error: "Falha ao ativar conta" }),

  accountDelete: (id: string) =>
    safeJson<{ success: boolean; error?: string }>(`/accounts/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }, { success: false, error: "Falha ao deletar conta" }),
};

export type Quote = NonNullable<Awaited<ReturnType<typeof api.quote>>>;
export type StrategyResults = NonNullable<Awaited<ReturnType<typeof api.strategyResults>>>;
