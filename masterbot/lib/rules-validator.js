export function validateRules(rules) {
  const warnings = [];
  const errors = [];
  const isAuto = rules?.strategy?.key === 'auto';
  const plans = Array.isArray(rules?.group_plans) ? rules.group_plans : [];
  const watchlist = Array.isArray(rules?.watchlist) ? rules.watchlist : [];

  if (isAuto && plans.length === 0) {
    errors.push('Modo Auto ativo mas group_plans está vazio ou ausente — bot não vai operar nada.');
  }

  for (const p of plans) {
    if (!Array.isArray(p.symbols) || p.symbols.length === 0) {
      warnings.push(`Plano "${p.name}" sem símbolos atribuídos (plano morto).`);
    }
    if (typeof p.breakeven_pct !== 'number' || p.breakeven_pct < 0 || p.breakeven_pct > 100) {
      errors.push(`Plano "${p.name}" com breakeven_pct inválido: ${p.breakeven_pct}`);
    }
  }

  const coverage = new Map();
  for (const p of plans) {
    for (const s of (p.symbols || [])) {
      if (!coverage.has(s)) coverage.set(s, []);
      coverage.get(s).push(p.name);
    }
  }

  if (isAuto) {
    for (const s of watchlist) {
      if (!coverage.has(s)) {
        warnings.push(`Símbolo "${s}" da watchlist não é coberto por nenhum plano — em Modo Auto será ignorado.`);
      }
    }
  }

  for (const [symbol, planNames] of coverage) {
    if (planNames.length > 1) {
      warnings.push(`Símbolo "${symbol}" coberto por múltiplos planos (${planNames.join(', ')}); o primeiro vence.`);
    }
  }

  return { warnings, errors };
}
