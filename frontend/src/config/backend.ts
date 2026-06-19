// Roteamento por-fatia da migração legado→Python.
// Cada flag decide se um grupo de chamadas vai ao backend Python (/api/v2)
// ou continua no legado (/api/legacy). Permite rollback instantâneo por área.
export const BACKEND_FLAGS = {
  market: true,    // Fatia A — cotações/candles
  dashboard: true, // Fatia B — resumo do dashboard (leitura)
  trades: true,    // Fatia B — histórico de trades (leitura)
  positions: true, // Fatia C — posições (leitura + escrita PAPER)
  auth: true,      // Fatia D — login/registro/me (JWT Python)
  strategies: true,// Fatia E — estratégias (master_plans) + backtest stub
  bots: true,      // Fatia F — status/start/stop bots + balance + futures stub
  backtest: true,  // Fatia G — backtest (STUB; motor real é Fase 7)
  accounts: true,  // Fatia H — contas Binance (multi-conta)
  notifications: true, // Notificações dos trades
} as const;
// VIRADA DO AUTH 2026-06-13: todas as fatias ligadas juntas (JWT Python). Login
// passa a emitir token Python; todas as chamadas autenticadas vão ao :8000.
// Rollback instantâneo: voltar qualquer flag para false e redeploy do frontend.

export type BackendFlag = keyof typeof BACKEND_FLAGS;

export const LEGACY_BASE = "/api/legacy";
export const V2_BASE = "/api/v2";
