// Roteamento por-fatia da migração legado→Python.
// Cada flag decide se um grupo de chamadas vai ao backend Python (/api/v2)
// ou continua no legado (/api/legacy). Permite rollback instantâneo por área.
export const BACKEND_FLAGS = {
  market: true,    // Fatia A — cotações/candles
  dashboard: false, // Fatia B — resumo do dashboard (leitura)
  trades: false,    // Fatia B — histórico de trades (leitura)
  positions: false, // Fatia C — posições (leitura, depois escrita)
  auth: false,      // Fatia D — login/registro/me
  strategies: false,// Fatia E — CRUD de estratégias
  bots: false,      // Fatia F — status/start/stop bots
  backtest: false,  // Fatia G — backtest
  accounts: false,  // Fatia H — contas Binance (multi-conta). Liga junto com auth (JWT Python).
} as const;

export type BackendFlag = keyof typeof BACKEND_FLAGS;

export const LEGACY_BASE = "/api/legacy";
export const V2_BASE = "/api/v2";
