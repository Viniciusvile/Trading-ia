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
    // Token expirado/invalido: em vez de mostrar telas vazias (fallback) silenciosamente,
    // limpa a sessao e manda pro login. Nao redireciona se ja estiver no /login (evita loop)
    // nem na propria chamada de login.
    if ((res.status === 401 || res.status === 403) && typeof window !== "undefined" && !path.startsWith("/auth/login")) {
      localStorage.removeItem("token");
      if (!window.location.pathname.startsWith("/login")) {
        window.location.href = "/login";
      }
    }
    if (!res.ok) {
      let errorMessage = `HTTP ${res.status}`;
      try {
        const errJson = await res.json();
        if (errJson && errJson.detail) {
          if (typeof errJson.detail === "string") {
            errorMessage = errJson.detail;
          } else if (Array.isArray(errJson.detail)) {
            errorMessage = errJson.detail.map((err: any) => err.msg || JSON.stringify(err)).join(", ");
          } else if (typeof errJson.detail === "object") {
            errorMessage = errJson.detail.message || JSON.stringify(errJson.detail);
          }
        }
      } catch {}
      throw new Error(errorMessage);
    }
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

  loginGoogle: async (credential: string) => {
    try {
      const r = await v2<{ access_token?: string }>("/auth/google", {
        method: "POST",
        body: JSON.stringify({ credential }),
      });
      if (!r.access_token) return { success: false, error: "Falha na autenticação com Google" };
      return { success: true, token: r.access_token };
    } catch {
      return { success: false, error: "Falha na autenticação com Google" };
    }
  },

  register: async (params: { email: string; password?: string }) => {
    try {
      const user = await v2<{ id: string; email: string }>("/auth/register", {
        method: "POST",
        body: JSON.stringify({ email: params.email, password: params.password ?? "" }),
      });
      const loginRes = await apiV2.login({ email: params.email, password: params.password });
      if (loginRes.success && loginRes.token) {
        return { success: true, token: loginRes.token, user };
      }
      return { success: true, user };
    } catch (err: any) {
      return { success: false, error: err.message || "Falha no registro" };
    }
  },

  me: async () => {
    try {
      const user = await v2<{ id: string; email: string; name?: string; picture?: string }>("/auth/me");
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
  microScalperStrategySave: (payload: {
    symbol: string;
    plan?: Partial<any>;
    active?: boolean;
    global?: Record<string, number>;
  }) =>
    v2<{ success: boolean; restarted?: boolean; error?: string }>(
      "/micro-scalper/strategy",
      { method: "PATCH", body: JSON.stringify(payload) },
      { success: false, error: "Falha ao salvar estratégia" },
    ),
  microScalperOptimize: (payload: { symbol: string }) =>
    v2<{ success: boolean; restarted?: boolean; mode?: string; plan?: any; stats?: any; error?: string }>(
      "/micro-scalper/optimize",
      { method: "POST", body: JSON.stringify(payload) },
      { success: false, error: "Falha ao otimizar estratégia" },
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
  // Sem fallback: erro de validação de credencial (HTTP 400) precisa chegar à
  // UI com a mensagem real, não virar um { success: false } genérico.
  accountCreate: (params: { name: string; apiKey: string; secretKey: string; isTestnet: boolean; exchange?: string }) =>
    v2<{ success: boolean; id?: string }>("/accounts", { method: "POST", body: JSON.stringify(params) }),
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
  // ─── Trading manual (página Mercado — ordens REAIS na conta ativa) ───
  tradeContext: (symbol: string) =>
    v2<{
      success: boolean;
      symbol: string;
      price: number;
      exchange?: string;
      quoteAsset?: string;
      supportsTpSl?: boolean;
      usdtFree: number;
      baseAsset: string;
      baseFree: number;
      baseFreeUsdt: number;
      regime: { allowed: boolean; reason: string; symbolRegime?: string; macroRegime?: string };
      openPositions: {
        id: string; plan?: string; side?: string; quantity?: number;
        entryPrice?: number; stopPrice?: number | null; takeProfitPrice?: number | null;
        openedAt?: string | null; unrealizedPnl?: number;
      }[];
      error?: string;
    } | null>(`/trade/context?symbol=${encodeURIComponent(symbol)}`, undefined, null),

  tradeOrder: (params: {
    symbol: string;
    side: "buy" | "sell";
    amount_usdt?: number;
    quantity?: number;
    tp_pct?: number;
    sl_pct?: number;
    tp1_pct?: number;
    tp1_size_pct?: number;
    trailing_pct?: number;
  }) =>
    v2<{
      success: boolean;
      positionId?: string;
      entryPrice?: number;
      exitPrice?: number;
      quantity?: number;
      totalUsdt?: number;
      tpPrice?: number | null;
      slPrice?: number | null;
      ocoOk?: boolean;
      ocoError?: string;
      advanced?: boolean;
      error?: string;
      detail?: string;
    }>("/trade/order", { method: "POST", body: JSON.stringify(params) }),

  tradeClose: (positionId: string) =>
    v2<{ success: boolean; exitPrice?: number; pnl?: number; error?: string; detail?: string }>(
      `/trade/close/${encodeURIComponent(positionId)}`,
      { method: "POST" },
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
  botStrategyShare: (name: string) =>
    v2<{ success: boolean; code?: string; error?: string }>(
      `/bot/strategies/${encodeURIComponent(name)}/share`,
      { method: "POST" },
      { success: false, error: "Falha ao compartilhar estratégia" },
    ),
  botStrategySharedGet: (code: string) =>
    v2<{ success: boolean; strategy?: unknown; error?: string }>(
      `/bot/strategies/shared/${encodeURIComponent(code)}`,
      undefined,
      { success: false, error: "Código inválido" },
    ),
  botStrategyImportTradingView: (payload: { url?: string; rawPineScript?: string }) =>
    v2<{ success: boolean; strategy?: unknown; error?: string; reason?: string }>(
      "/bot/strategies/import-tradingview",
      { method: "POST", body: JSON.stringify(payload) },
      { success: false, error: "Falha ao analisar o script" },
    ),

  // ─── Fatia C: Posições (leitura) ───
  botPositions: () =>
    v2<{ success: boolean; positions: unknown[] }>(
      "/bot/positions",
      undefined,
      { success: false, positions: [] },
    ),

  botSavePositionNote: (id: string, note: string) =>
    v2<{ success: boolean }>(
      `/bot/positions/${encodeURIComponent(id)}/note`,
      {
        method: "POST",
        body: JSON.stringify({ note }),
      },
      { success: false }
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

  // ─── Fatia I: Notifications ───
  notifications: (limit?: number) =>
    v2<{ success: boolean; notifications: any[] }>(
      `/notifications${limit ? `?limit=${limit}` : ""}`,
      undefined,
      { success: false, notifications: [] }
    ),

  notificationsRead: (ids?: string[]) =>
    v2<{ success: boolean }>(
      "/notifications/read",
      {
        method: "POST",
        body: ids ? JSON.stringify({ ids }) : undefined,
      },
      { success: false }
    ),

  systemStatus: () =>
    v2<{ success: boolean; database: string; worker: string; beat: string; redis: string; backend: string }>(
      "/status",
      undefined,
      { success: false, database: "down", worker: "down", beat: "down", redis: "down", backend: "down" }
    ),

  billingPlans: () =>
    v2<{ id: string; name: string; price_brl: number; max_bots: number; max_strategies: number; features: string[] }[]>(
      "/billing/plans",
      undefined,
      [],
    ),

  billingCheckout: (plan: string) =>
    v2<{ checkout_url: string }>(
      `/billing/checkout/${encodeURIComponent(plan)}`,
      { method: "POST" },
    ),

  billingPortal: () =>
    v2<{ portal_url: string }>(
      "/billing/portal",
      { method: "POST" },
    ),
};
