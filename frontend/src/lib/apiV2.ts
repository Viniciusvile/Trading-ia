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
};
