// Parâmetros ajustáveis pelo ciclo de aprendizado, com limites rígidos.
// O Gemini só pode propor valores DENTRO destes bounds; qualquer coisa fora
// é clampada. A variação por ciclo é limitada a MAX_STEP_PCT para evitar
// saltos bruscos de comportamento.

export const STRATEGIES = ["micro-dip", "turbo-reversion"];
export const MAX_STEP_PCT = 0.25;

export const PARAM_BOUNDS = {
  ema_period:    { min: 5,     max: 100,  int: true },
  rsi_period:    { min: 5,     max: 30,   int: true },
  min_dip_pct:   { min: 0.001, max: 0.03 },
  min_rsi:       { min: 5,     max: 40 },
  max_rsi:       { min: 40,    max: 75 },
  sl_pct:        { min: 0.003, max: 0.03 },
  tp_pct:        { min: 0.004, max: 0.05 },
  min_atr_pct:   { min: 0,     max: 0.01 },
  trend_ema_period: { min: 0,  max: 200,  int: true }, // 0 = filtro desligado
  cooldown_min:  { min: 1,     max: 120,  int: true }, // espera após trade fechado
};

export const DEFAULT_PARAMS = {
  strategy: "micro-dip",
  ema_period: 20,
  rsi_period: 14,
  min_dip_pct: 0.004,
  min_rsi: 20,
  max_rsi: 45,
  sl_pct: 0.006,
  tp_pct: 0.01,
  min_atr_pct: 0.0,
  trend_ema_period: 50,
  cooldown_min: 15,
};

/** Lança erro se a proposta tiver chave desconhecida, tipo errado ou strategy inválida. */
export function validateProposal(proposal) {
  for (const key of Object.keys(proposal)) {
    if (key !== "strategy" && !(key in PARAM_BOUNDS)) {
      throw new Error(`Parâmetro desconhecido na proposta: ${key}`);
    }
  }
  if (proposal.strategy != null && !STRATEGIES.includes(proposal.strategy)) {
    throw new Error(`strategy inválida: ${proposal.strategy}`);
  }
  for (const key of Object.keys(PARAM_BOUNDS)) {
    const v = proposal[key];
    if (v == null) continue;
    if (typeof v !== "number" || !Number.isFinite(v)) {
      throw new Error(`Parâmetro ${key} deve ser numérico, recebido: ${v}`);
    }
  }
  return true;
}

/**
 * Clampa a proposta aos bounds absolutos E à variação máxima por ciclo
 * relativa aos parâmetros atuais. Retorna { params, changed[] }.
 */
export function clampParams(proposal, current) {
  const params = { strategy: STRATEGIES.includes(proposal.strategy) ? proposal.strategy : current.strategy };
  const changed = [];
  for (const [key, bound] of Object.entries(PARAM_BOUNDS)) {
    let v = proposal[key] ?? current[key];
    const cur = current[key];
    // limite de passo por ciclo (só quando o valor atual é > 0)
    if (typeof cur === "number" && cur > 0) {
      const lo = cur * (1 - MAX_STEP_PCT);
      const hi = cur * (1 + MAX_STEP_PCT);
      v = Math.min(hi, Math.max(lo, v));
    }
    v = Math.min(bound.max, Math.max(bound.min, v));
    if (bound.int) v = Math.round(v);
    if (v !== (proposal[key] ?? current[key])) changed.push(key);
    params[key] = v;
  }
  return { params, changed };
}
