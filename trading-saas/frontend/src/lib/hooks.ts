"use client";

/**
 * Hooks SWR compartilhados — camada única de dados do painel.
 *
 * Substitui os useState+setInterval espalhados pelas páginas: o cache é
 * compartilhado (Topbar e Dashboard leem o MESMO saldo sem requisição dupla),
 * keepPreviousData evita flash/pulo de números durante o refresh e habilita
 * o AnimatedNumber a interpolar entre valor antigo e novo.
 */

import useSWR from "swr";
import { api } from "./api";
import type { SummaryTrade } from "./api";

const REFRESH_MS = 15_000;

export interface DashboardSummaryData {
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
}

export interface PositionsData {
  success?: boolean;
  positions?: any[];
}

export interface StrategiesData {
  success?: boolean;
  strategies?: any[];
}

const opts = {
  refreshInterval: REFRESH_MS,
  keepPreviousData: true,
  revalidateOnFocus: true,
  dedupingInterval: 5_000,
};

export function useBalance() {
  return useSWR("bot-balance", () => api.botBalance(), opts);
}

export function useDashboardSummary() {
  return useSWR<DashboardSummaryData>(
    "dashboard-summary",
    async () => (await api.dashboardSummary(new Date().getTimezoneOffset())) as DashboardSummaryData,
    opts,
  );
}

/** Status dos três bots numa chamada agrupada (conta quantos estão ativos). */
export function useBotStatuses() {
  return useSWR(
    "bot-statuses",
    async () => {
      const [master, scalper, futures] = await Promise.all([
        api.botMasterStatus().catch(() => null),
        api.microScalperStatus().catch(() => null),
        api.botFuturesStatus().catch(() => null),
      ]);
      let activeCount = 0;
      if (master?.isAlive) activeCount++;
      if (scalper?.running) activeCount++;
      if (futures?.isAlive) activeCount++;
      return { master, scalper, futures, activeCount };
    },
    opts,
  );
}

export function usePositions() {
  return useSWR<PositionsData>(
    "bot-positions",
    async () => (await api.botPositions()) as PositionsData,
    opts,
  );
}

/** Cotações 24h de vários símbolos (página Mercado) — refresh 5s. */
export function useQuotes(symbols: string[]) {
  return useSWR(
    symbols.length ? `quotes-${symbols.join(",")}` : null,
    async () => {
      const res = await Promise.all(
        symbols.map((s) => api.quote(s).catch(() => null)),
      );
      const map: Record<string, NonNullable<Awaited<ReturnType<typeof api.quote>>>> = {};
      symbols.forEach((s, i) => {
        const q = res[i];
        if (q) map[s] = q;
      });
      return map;
    },
    { ...opts, refreshInterval: 5_000 },
  );
}

/** Contexto do painel de ordem manual: saldos, preço, regime e posições do símbolo. */
export function useTradeContext(symbol: string) {
  return useSWR(
    symbol ? `trade-context-${symbol}` : null,
    () => api.tradeContext(symbol),
    { ...opts, refreshInterval: 10_000 },
  );
}

export function useStrategies() {
  return useSWR<StrategiesData>(
    "bot-strategies",
    async () => (await api.botStrategies()) as StrategiesData,
    {
      ...opts,
      refreshInterval: 60_000,
    },
  );
}

export interface PriceAlert {
  id: string;
  symbol: string;
  condition: "above" | "below";
  target_price: number;
  recurring: boolean;
  is_active: boolean;
  triggered_at: string | null;
  created_at: string;
}

export function useAlerts() {
  return useSWR<{ success: boolean; alerts: PriceAlert[] }>(
    "price-alerts",
    async () => {
      const token = typeof window !== "undefined" ? localStorage.getItem("token") : null;
      const res = await fetch("/api/alerts", {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) return { success: false, alerts: [] };
      return res.json();
    },
    { ...opts, refreshInterval: 30_000 },
  );
}

export interface SystemStatus {
  success: boolean;
  database: "ok" | "down";
  worker: "ok" | "down";
  beat: "ok" | "down";
  redis: "ok" | "down";
  backend: "ok" | "down";
}

export function useSystemStatus() {
  return useSWR<SystemStatus>(
    "system-status",
    async () => {
      const res = await fetch("/api/status");
      if (!res.ok) return null;
      return res.json();
    },
    { refreshInterval: 60_000, keepPreviousData: true, dedupingInterval: 30_000 },
  );
}

export interface RegimeData {
  regime: "bull" | "bear" | "neutral";
  close?: number;
  ema200?: number;
  ema50?: number;
  slope_pct?: number;
  reason?: string;
}

export function useMarketRegime(symbols = "BTCUSDT,ETHUSDT,SOLUSDT") {
  return useSWR<{ success: boolean; regimes: Record<string, RegimeData> }>(
    `market-regime-${symbols}`,
    async () => {
      const res = await fetch(`/api/market/regime?symbols=${encodeURIComponent(symbols)}`);
      if (!res.ok) return { success: false, regimes: {} };
      return res.json();
    },
    { refreshInterval: 900_000, keepPreviousData: true, dedupingInterval: 300_000 },
  );
}

export interface LatestReportStrategy {
  name: string;
  trades: number;
  wins: number;
  losses: number;
  win_rate: number;
  pnl: number;
  profit_factor: number;
  rr_realizado: number;
  avg_slippage_pct: number;
  avg_duration_min: number | null;
  exit_reasons: Record<string, number>;
  verdicts: string[];
  delta: { pnl: number; win_rate: number; pf: number } | null;
}

export interface LatestReport {
  id: string;
  period_label: string;
  period_start: string;
  period_end: string;
  created_at: string;
  total_trades: number;
  total_pnl: number;
  win_rate: number | null;
  profit_factor: number | null;
  strategies: LatestReportStrategy[];
  verdicts: string[];
  summary: string;
}

export interface EquityPoint {
  date: string;
  pnl: number;
  cumulative: number;
}

export function useEquityData(days = 70) {
  return useSWR<{ success: boolean; equity: EquityPoint[]; max_drawdown: number; total_pnl: number }>(
    `equity-${days}`,
    async () => {
      const token = typeof window !== "undefined" ? localStorage.getItem("token") : null;
      const res = await fetch(`/api/dashboard/equity?days=${days}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) return { success: false, equity: [], max_drawdown: 0, total_pnl: 0 };
      return res.json();
    },
    { refreshInterval: 300_000, keepPreviousData: true },
  );
}

export function useLatestReport() {
  return useSWR<{ success: boolean; report: LatestReport | null }>(
    "latest-report",
    async () => {
      const token = typeof window !== "undefined" ? localStorage.getItem("token") : null;
      const res = await fetch("/api/dashboard/reports/latest", {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) return { success: false, report: null };
      return res.json();
    },
    { refreshInterval: 300_000, keepPreviousData: true },
  );
}
