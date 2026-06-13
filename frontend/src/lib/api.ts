/**
 * Cliente leve para a API legada do dashboard (server.js antigo).
 * Em produção, Next rewrites delega /api/legacy/* → http://127.0.0.1:3334
 * (o servidor antigo continua rodando atrás do scenes, mas em outra porta).
 *
 * Em dev local sem servidor: as funções devolvem dados vazios para a UI não quebrar.
 */

import { BACKEND_FLAGS } from "@/config/backend";
import { apiV2 } from "./apiV2";

const BASE = "/api/legacy";

export interface ScalperPlan {
  strategy_mode: "micro-dip" | "turbo-reversion";
  tp_pct?: number;
  sl_pct?: number;
  breakeven_pct?: number;
  // micro-dip
  ema_period?: number;
  rsi_period?: number;
  min_dip_pct?: number;
  min_rsi?: number;
  max_rsi?: number;
  // turbo-reversion
  bb_length?: number;
  bb_mult?: number;
  rsi_limit?: number;
  vol_mult?: number;
  // filtros compartilhados
  trend_ema_period?: number;
  trend_max_down_pct?: number;
  min_atr_pct?: number;
  qty_decimals?: number;
  quote_decimals?: number;
  [k: string]: unknown;
}

export interface BacktestStats {
  totalTrades: number;
  wins: number;
  losses: number;
  breakevens: number;
  winRate: number;
  profitFactor: number;
  netProfitPct: number;
  netProfitUsd: number;
  expectancyPct: number;
  avgWinPct: number;
  avgLossPct: number;
  maxDrawdownPct: number;
  avgHoldBars: number;
}

export interface BacktestTrade {
  entryTime: number;
  exitTime: number;
  side: "LONG" | "SHORT";
  entryPrice: number;
  exitPrice: number;
  returnPct: number;
  result: "win" | "loss" | "timeout";
  symbol?: string;
  timeframe?: string;
}

export interface SummaryTrade {
  symbol: string;
  side: string;
  pnl: number;
  openedAt: string;
  closedAt: string | null;
  status: string;
  strategy: string | null;
}

export interface AdaptiveParams {
  version: number;
  strategy: string;
  sl_pct: number;
  tp_pct: number;
  ema_period: number;
  rsi_period: number;
  min_rsi: number;
  max_rsi: number;
  min_dip_pct: number;
  cooldown_min: number;
}

export interface AdaptiveStatus {
  success: boolean;
  running: boolean;
  lastSeen?: string | null;
  paper: boolean;
  params: AdaptiveParams | null;
  openTrades: { id: number; symbol: string; openedAt: string; entry: number; stop: number; tp: number }[];
  stats30d: { trades: number; winRate: number; pnlPct: number };
  recentTrades: { id: number; result: string; returnPct: number; closedAt: string; version: number }[];
  lessons: string[];
  reviews: { at: string; applied: boolean; reason: string; analysis?: string | null; newVersion?: number | null }[];
  error?: string;
}

export interface BacktestResult {
  ranAt: number;
  combined: BacktestStats | null;
  equityCurve: { time: number; equity: number }[];
  winRateTarget: number | null;
  approved: boolean | null;
  feePctPerSide?: number;
  walkForward?: {
    splitTime: number;
    inSample: BacktestStats | null;
    outOfSample: BacktestStats | null;
  } | null;
  warnings: string[];
  results: {
    symbol: string;
    timeframe: string;
    periodStart?: number;
    periodEnd?: number;
    error?: string;
    stats: BacktestStats | null;
    trades: BacktestTrade[];
  }[];
  recentTrades: BacktestTrade[];
}

async function safeJson<T>(path: string, init?: RequestInit, fallback?: T): Promise<T> {
  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(init?.headers as Record<string, string> ?? {}),
    };

    if (typeof window !== "undefined") {
      const token = localStorage.getItem("token");
      if (token) {
        headers["Authorization"] = `Bearer ${token}`;
      }
    }

    const res = await fetch(`${BASE}${path}`, {
      ...init,
      headers,
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as T;
  } catch (err) {
    if (fallback !== undefined) return fallback;
    throw err;
  }
}

/**
 * Como safeJson, mas devolve o corpo JSON MESMO em respostas 4xx — usado em
 * endpoints onde a mensagem de erro do servidor (ex.: "script protegido, cole
 * o código") é importante para o usuário e não pode ser engolida pelo fallback.
 */
async function jsonAllowError<T>(path: string, init?: RequestInit, fallback?: T): Promise<T> {
  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(init?.headers as Record<string, string> ?? {}),
    };
    if (typeof window !== "undefined") {
      const token = localStorage.getItem("token");
      if (token) headers["Authorization"] = `Bearer ${token}`;
    }
    const res = await fetch(`${BASE}${path}`, { ...init, headers, cache: "no-store" });
    // Tenta sempre ler JSON; se a resposta não for JSON, cai no fallback.
    return (await res.json()) as T;
  } catch (err) {
    if (fallback !== undefined) return fallback;
    throw err;
  }
}

export const api = {
  health: () => safeJson<{ ok: boolean }>("/health", undefined, { ok: false }),

  quote: (symbol: string) =>
    BACKEND_FLAGS.market
      ? apiV2.quote(symbol)
      : safeJson<{
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
    BACKEND_FLAGS.market
      ? apiV2.ohlcv(symbol, timeframe, count)
      : safeJson<{
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
      success: boolean;
      strategyKey: string;
      symbol: string;
      timeframe: string;
      portfolio: number;
      maxTrade: number;
      paperTrading: boolean;
      dailyMaxLoss: number;
      activePlan: string | null;
      activePlans?: string[];
      loopInterval?: string;
      groupPlans: { name: string; description?: string; symbols: string[] }[];
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
    BACKEND_FLAGS.bots
      ? (apiV2.botMasterStatus() as Promise<{ success: boolean; isAlive: boolean }>)
      : safeJson<{
          success: boolean;
          isAlive: boolean;
          status?: string;
          lastRun?: string;
          nextRun?: string;
          watchlist?: string[];
          openPositions?: number;
          lastResults?: {
            symbol: string;
            timeframe: string;
            allPass: boolean;
            side?: string | null;
            signal: string;
            price?: number | null;
            strategy?: string | null;
            conditions?: {
              label: string;
              pass: boolean;
              required: string | number;
              actual: string | number;
            }[];
          }[];
        }>("/bot/master/status", undefined, { success: false, isAlive: false }),

  botMasterStart: () =>
    safeJson<{ success: boolean; error?: string }>("/bot/master/start", { method: "POST" }),

  botMasterStop: () =>
    safeJson<{ success: boolean; error?: string }>("/bot/master/stop", { method: "POST" }),

  microScalperStatus: () =>
    BACKEND_FLAGS.bots
      ? apiV2.microScalperStatus()
      : safeJson<{ success: boolean; running: boolean; activeSymbols?: string[] }>("/micro-scalper/status", undefined, { success: false, running: false }),

  adaptiveStatus: () =>
    BACKEND_FLAGS.bots
      ? (apiV2.adaptiveStatus() as Promise<AdaptiveStatus>)
      : safeJson<AdaptiveStatus>("/adaptive/status", undefined, {
          success: false,
          running: false,
          paper: true,
          params: null,
          openTrades: [],
          stats30d: { trades: 0, winRate: 0, pnlPct: 0 },
          recentTrades: [],
          lessons: [],
          reviews: [],
        }),

  dashboardSummary: (tzOffset?: number) =>
    safeJson<{
      success: boolean;
      pnlToday: number;
      operationsToday: number;
      winRate30d: number | null;
      totalTrades30d: number;
      openPositions: number;
      recentActivity: { time: string; kind: "open" | "win" | "loss"; symbol: string; title: string }[];
      todayTrades?: SummaryTrade[];
      todayOpened?: SummaryTrade[];
      stats30d?: {
        wins: number;
        losses: number;
        totalPnl: number;
        bestPnl: number;
        worstPnl: number;
        avgDurationMin?: number;
        timeoutCount?: number;
        tpCount?: number;
        slCount?: number;
        totalClosed?: number;
      } | null;
    }>(typeof tzOffset === "number" ? `/dashboard/summary?tzOffset=${tzOffset}` : "/dashboard/summary", undefined, {
      success: false,
      pnlToday: 0,
      operationsToday: 0,
      winRate30d: null,
      totalTrades30d: 0,
      openPositions: 0,
      recentActivity: [],
    }),

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

  microScalperConfig: () =>
    BACKEND_FLAGS.bots
      ? (apiV2.microScalperConfig() as Promise<{
          success: boolean;
          config: {
            active_symbols: string[];
            max_trade_usdt?: number;
            min_trade_usdt?: number;
            daily_profit_target_usdt?: number;
            loop_interval_ms?: number;
            plans: Record<string, ScalperPlan>;
          } | null;
        }>)
      : safeJson<{
          success: boolean;
          config: {
            active_symbols: string[];
            max_trade_usdt?: number;
            min_trade_usdt?: number;
            daily_profit_target_usdt?: number;
            loop_interval_ms?: number;
            plans: Record<string, ScalperPlan>;
          } | null;
        }>("/micro-scalper/config", undefined, { success: false, config: null }),

  microScalperStrategySave: (payload: {
    symbol: string;
    plan?: Partial<ScalperPlan>;
    active?: boolean;
    global?: Record<string, number>;
  }) =>
    safeJson<{ success: boolean; restarted?: boolean; error?: string }>("/micro-scalper/strategy", {
      method: "PATCH",
      body: JSON.stringify(payload),
    }, { success: false, error: "Falha ao salvar estratégia do scalper" }),

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
        statsSource: "real" | "backtest" | "sem-dados";
        realStats: { totalTrades: number; winRate: number; profitFactor: number; netProfit: number } | null;
        winRateTarget: number | null;
        lastBacktest: BacktestResult | null;
        lastBacktestAt?: number | null;
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

  // ─── Compartilhamento & Importação de estratégias ───
  botStrategyShare: (name: string) =>
    safeJson<{ success: boolean; code?: string; error?: string }>(
      `/bot/strategies/${encodeURIComponent(name)}/share`,
      { method: "POST" },
      { success: false, error: "Falha ao compartilhar estratégia" },
    ),

  botStrategySharedGet: (code: string) =>
    jsonAllowError<{ success: boolean; strategy?: ImportedStrategy & { code: string }; error?: string }>(
      `/bot/strategies/shared/${encodeURIComponent(code)}`,
      undefined,
      { success: false, error: "Código inválido" },
    ),

  botStrategyImportTradingView: (payload: { url?: string; rawPineScript?: string }) =>
    jsonAllowError<{ success: boolean; strategy?: ImportedStrategy; error?: string; reason?: string }>(
      "/bot/strategies/import-tradingview",
      { method: "POST", body: JSON.stringify(payload) },
      { success: false, error: "Falha ao analisar o script" },
    ),

  botBacktest: (plan: any) =>
    safeJson<{ success: boolean; error?: string } & Partial<BacktestResult>>("/bot/backtest", {
      method: "POST",
      body: JSON.stringify(plan),
    }, { success: false, error: "Falha ao executar análise" }),

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

  botReconcile: () =>
    safeJson<{
      success: boolean;
      error?: string;
      checked?: number;
      ghostsClosed?: string[];
      missingOco?: string[];
      ok?: string[];
      untracked?: { asset: string; qty: number; valueUsd: number }[];
    }>("/bot/reconcile", { method: "POST" }, { success: false, error: "Falha ao reconciliar" }),

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

  // ─── Authentication Endpoints ───
  login: (params: { email: string; password?: string }) =>
    BACKEND_FLAGS.auth
      ? apiV2.login(params)
      : safeJson<{ success: boolean; token?: string; user?: any; error?: string }>("/auth/login", {
          method: "POST",
          body: JSON.stringify(params),
        }, { success: false, error: "Falha na autenticação" }),

  register: (params: { email: string; password?: string }) =>
    BACKEND_FLAGS.auth
      ? apiV2.register(params)
      : safeJson<{ success: boolean; token?: string; user?: any; error?: string }>("/auth/register", {
          method: "POST",
          body: JSON.stringify(params),
        }, { success: false, error: "Falha no registro" }),

  me: () =>
    BACKEND_FLAGS.auth
      ? apiV2.me()
      : safeJson<{ success: boolean; user?: any }>("/auth/me", undefined, { success: false }),

  // ─── Notifications Endpoints ───
  notifications: (limit?: number) =>
    safeJson<{ success: boolean; notifications: SystemNotification[] }>(
      `/notifications${limit ? `?limit=${limit}` : ""}`,
      undefined,
      { success: false, notifications: [] }
    ),

  notificationsRead: (ids?: string[]) =>
    safeJson<{ success: boolean }>(
      "/notifications/read",
      {
        method: "POST",
        body: ids ? JSON.stringify({ ids }) : undefined,
      },
      { success: false }
    ),
};

/** Modelo de estratégia devolvido pelo importador (IA / código P2P). */
export interface ImportedStrategy {
  name: string;
  description: string;
  strategy: string;
  symbols: string[];
  timeframes: string[];
  mode: string;
  leverage?: number;
  filters: Record<string, any>;
  sl: any;
  tp: any;
  winRateTarget?: number | null;
}

export interface SystemNotification {
  id: string;
  title: string;
  message: string;
  type: 'info' | 'success' | 'warning' | 'error';
  isRead: boolean;
  createdAt: string;
}

export type Quote = NonNullable<Awaited<ReturnType<typeof api.quote>>>;
export type StrategyResults = NonNullable<Awaited<ReturnType<typeof api.strategyResults>>>;
