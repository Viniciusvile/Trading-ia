// Cliente do backend Python (FastAPI :8000 via rewrite /api/v2).
// Cresce uma fatia da migração por vez. Reaproveita as interfaces de ./api.ts.
import { V2_BASE } from "@/config/backend";

export async function v2<T>(path: string, init?: RequestInit, fallback?: T): Promise<T> {
  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...((init?.headers as Record<string, string>) ?? {}),
    };
    if (typeof window !== "undefined") {
      const token = localStorage.getItem("token");
      if (token) headers["Authorization"] = `Bearer ${token}`;
    }
    const res = await fetch(`${V2_BASE}${path}`, { ...init, headers, cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as T;
  } catch (err) {
    if (fallback !== undefined) return fallback;
    throw err;
  }
}

// O legado usa timeframes como "1D"/"4H"; a Binance (backend Python) usa "1d"/"4h".
function toBinanceInterval(tf: string): string {
  return tf.toLowerCase();
}

type V2Ticker = {
  symbol: string;
  price: number;
  change_pct: number;
  volume_usdt: number;
  high: number;
  low: number;
};

type V2Candle = { time: number; open: number; high: number; low: number; close: number; volume: number };

export const apiV2 = {
  // ─── Fatia A: Market (cotações/candles) ───
  quote: async (symbol: string) => {
    const list = await v2<V2Ticker[]>(
      `/market/tickers?symbols=${encodeURIComponent(symbol)}`,
      undefined,
      [],
    );
    const t = list.find((x) => x.symbol === symbol) ?? list[0];
    if (!t) return null;
    return {
      symbol: t.symbol,
      last: t.price,
      change: 0, // backend só expõe percentual; valor absoluto não é usado pela UI
      changePct: t.change_pct,
      high: t.high,
      low: t.low,
      volume: t.volume_usdt,
    };
  },

  ohlcv: async (symbol: string, timeframe = "1D", count = 30) => {
    const bars = await v2<V2Candle[]>(
      `/market/candles?symbol=${encodeURIComponent(symbol)}&interval=${toBinanceInterval(timeframe)}&limit=${count}`,
      undefined,
      [],
    );
    return { bars };
  },

  // ─── Fatia D: Auth (login/registro/me) ───
  // O Python responde {access_token} / UserResponse; a UI espera {success, token, user, error}.
  login: async (params: { email: string; password?: string }) => {
    try {
      const r = await v2<{ access_token?: string }>("/auth/login", {
        method: "POST",
        body: JSON.stringify({ email: params.email, password: params.password ?? "" }),
      });
      if (!r.access_token) return { success: false, error: "Falha na autenticação" };
      return { success: true, token: r.access_token };
    } catch {
      return { success: false, error: "Falha na autenticação" };
    }
  },

  register: async (params: { email: string; password?: string }) => {
    try {
      const user = await v2<{ id: string; email: string }>("/auth/register", {
        method: "POST",
        body: JSON.stringify({ email: params.email, password: params.password ?? "" }),
      });
      return { success: true, user };
    } catch {
      return { success: false, error: "Falha no registro" };
    }
  },

  me: async () => {
    try {
      const user = await v2<{ id: string; email: string }>("/auth/me");
      return { success: true, user };
    } catch {
      return { success: false };
    }
  },

  // ─── Fatia F (parcial): Micro-Scalper (leitura de estado) ───
  microScalperStatus: () =>
    v2<{ success: boolean; running: boolean; activeSymbols?: string[] }>(
      "/micro-scalper/status",
      undefined,
      { success: false, running: false },
    ),

  microScalperConfig: () =>
    v2<{ success: boolean; config: unknown }>(
      "/micro-scalper/config",
      undefined,
      { success: false, config: null },
    ),

  botMasterStatus: () =>
    v2<{ success: boolean; isAlive: boolean }>(
      "/bot/master/status",
      undefined,
      { success: false, isAlive: false },
    ),

  adaptiveStatus: () =>
    v2<{ success: boolean; running: boolean }>(
      "/bot/adaptive/status",
      undefined,
      {
        success: false, running: false, paper: true, params: null,
        openTrades: [], stats30d: { trades: 0, winRate: 0, pnlPct: 0 },
        recentTrades: [], lessons: [], reviews: [],
      } as unknown as { success: boolean; running: boolean },
    ),

  // start/stop dos bots (alternam a flag *_enabled por usuario no Python)
  botMasterStart: () => v2<{ success: boolean }>("/bot/master/start", { method: "POST" }, { success: false }),
  botMasterStop: () => v2<{ success: boolean }>("/bot/master/stop", { method: "POST" }, { success: false }),
  microScalperStart: () => v2<{ success: boolean }>("/bot/micro/start", { method: "POST" }, { success: false }),
  microScalperStop: () => v2<{ success: boolean }>("/bot/micro/stop", { method: "POST" }, { success: false }),

  // log de trades do scalper (paper) e PATCH de config — substituem os fetch /api/legacy diretos
  microScalperLog: (limit = 25) =>
    v2<{ success: boolean; trades: unknown[] }>(
      `/micro-scalper/log?limit=${limit}`,
      undefined,
      { success: false, trades: [] },
    ),
  microScalperConfigSave: (patch: Record<string, unknown>) =>
    v2<{ success: boolean }>(
      "/micro-scalper/config",
      { method: "PATCH", body: JSON.stringify(patch) },
      { success: false },
    ),
  botConfigSave: (patch: Record<string, unknown>) =>
    v2<{ success: boolean }>(
      "/bot/config",
      { method: "PATCH", body: JSON.stringify(patch) },
      { success: false },
    ),

  // ─── Fatia H: Contas Binance (multi-conta) ───
  accountsList: () =>
    v2<{ success: boolean; accounts: unknown[] }>("/accounts", undefined, { success: false, accounts: [] }),
  accountCreate: (params: { name: string; apiKey: string; secretKey: string; isTestnet: boolean }) =>
    v2<{ success: boolean; id?: string }>("/accounts", { method: "POST", body: JSON.stringify(params) }, { success: false }),
  accountActivate: (id: string) =>
    v2<{ success: boolean }>(`/accounts/${encodeURIComponent(id)}/activate`, { method: "POST" }, { success: false }),
  accountDelete: (id: string) =>
    v2<{ success: boolean }>(`/accounts/${encodeURIComponent(id)}`, { method: "DELETE" }, { success: false }),

  // ─── Config do MasterBot (modal de configurações: groupPlans + activePlans) ───
  botConfig: () =>
    v2<{ success: boolean } | null>("/bot/config", undefined, null),
  botMasterRawLog: () =>
    v2<{ success: boolean; lines: string[]; message?: string }>(
      "/bot/master/raw-log",
      undefined,
      { success: false, lines: [] },
    ),

  // ─── Fatia F5: escrita de posições (PAPER) + saldo + futures stub + backtest stub ───
  botBalance: () =>
    v2<{ success: boolean; spot?: number; futures?: number }>(
      "/bot/balance",
      undefined,
      { success: false },
    ),
  botClosePosition: (id: string, markOnly?: boolean) =>
    v2<{ success: boolean; error?: string }>(
      `/bot/positions/${encodeURIComponent(id)}/close${markOnly ? "?markOnly=true" : ""}`,
      { method: "POST" },
      { success: false, error: "Falha na requisição" },
    ),
  botReconcile: () =>
    v2<{ success: boolean; error?: string }>(
      "/bot/reconcile",
      { method: "POST" },
      { success: false, error: "Falha ao reconciliar" },
    ),
  botEmergencySell: () =>
    v2<{ success: boolean; message?: string }>("/bot/emergency-sell", { method: "POST" }, { success: false }),
  botForceTrade: (params: { symbol: string; timeframe: string; side: string; amount?: number; mode: string }) =>
    v2<{ success: boolean; exitCode?: number; stdout?: string; stderr?: string; error?: string }>(
      "/bot/force-trade",
      { method: "POST", body: JSON.stringify(params) },
      { success: false, error: "Falha na requisição" },
    ),
  botFuturesStatus: () =>
    v2<{ success: boolean; isAlive: boolean; status?: string }>(
      "/bot/futures/status",
      undefined,
      { success: false, isAlive: false },
    ),
  botFuturesStart: () =>
    v2<{ success: boolean; error?: string }>("/bot/futures/start", { method: "POST" }, { success: false }),
  botFuturesStop: () =>
    v2<{ success: boolean }>("/bot/futures/stop", { method: "POST" }, { success: false }),
  botBacktest: (plan: Record<string, unknown>) =>
    v2<{ success: boolean; error?: string }>(
      "/bot/backtest",
      { method: "POST", body: JSON.stringify(plan) },
      { success: false, error: "Falha ao executar análise" },
    ),

  // ─── Fatia E: Estratégias do MasterBot (planos master_plans) ───
  botStrategies: () =>
    v2<{ success: boolean; strategies: unknown[] }>(
      "/bot/strategies",
      undefined,
      { success: false, strategies: [] },
    ),
  botStrategyCreate: (strat: Record<string, unknown>) =>
    v2<{ success: boolean; strategy?: unknown }>(
      "/bot/strategies",
      { method: "POST", body: JSON.stringify(strat) },
      { success: false },
    ),
  botStrategyActivate: (name: string) =>
    v2<{ success: boolean }>(`/bot/strategies/${encodeURIComponent(name)}/activate`, { method: "POST" }, { success: false }),
  botStrategyDeactivate: (name: string) =>
    v2<{ success: boolean }>(`/bot/strategies/${encodeURIComponent(name)}/deactivate`, { method: "POST" }, { success: false }),
  botStrategyDelete: (name: string) =>
    v2<{ success: boolean }>(`/bot/strategies/${encodeURIComponent(name)}`, { method: "DELETE" }, { success: false }),

  // ─── Fatia C: Posições (leitura) ───
  botPositions: () =>
    v2<{ success: boolean; positions: unknown[] }>(
      "/bot/positions",
      undefined,
      { success: false, positions: [] },
    ),

  // ─── Fatia B: Dashboard (resumo, calculado das posições reais) ───
  dashboardSummary: (tzOffset?: number) =>
    v2<{ success: boolean }>(
      typeof tzOffset === "number" ? `/dashboard/summary?tzOffset=${tzOffset}` : "/dashboard/summary",
      undefined,
      {
        success: false, pnlToday: 0, operationsToday: 0, winRate30d: null,
        totalTrades30d: 0, openPositions: 0, recentActivity: [],
      } as unknown as { success: boolean },
    ),
};
