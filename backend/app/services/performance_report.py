"""Serviço puro de auditoria de performance (sem dependência de banco).

Motivação: a auditoria de junho (127 trades) foi feita manualmente via SQL.
Este módulo automatiza a mesma análise toda semana com os mesmos critérios.

Entrada: lista de posições fechadas (dicts).
Saída: relatório estruturado com estatísticas por estratégia + verdicts automáticos.

Verdicts:
  rr_invertido  — perda média > ganho médio (RR < 1 realizado)
  pf_baixo      — profit factor < 1 com ≥ 10 trades
  slippage_alto — slippage médio nas perdas > 0.3% (limiar calibrado na auditoria)
  semana_negativa / semana_positiva — resultado global
  win_rate_baixo — win rate < 40%
"""
from __future__ import annotations

from datetime import datetime
from typing import Any


def _parse_dt(val: Any) -> datetime | None:
    if val is None:
        return None
    if isinstance(val, datetime):
        return val
    try:
        return datetime.fromisoformat(str(val).replace("Z", "+00:00"))
    except Exception:
        return None


def _pf(profit: float, loss: float) -> float:
    if loss > 0:
        return round(profit / loss, 3)
    return 99.9 if profit > 0 else 0.0


def analyze_positions(
    closed_positions: list[dict],
    period_label: str = "",
    prev_report: dict | None = None,
) -> dict:
    """Analisa uma lista de posições fechadas e retorna o relatório.

    Cada dict de posição deve ter:
      pnl, strategy, plan, symbol, entry_price, exit_price, stop_price,
      opened_at (ISO str ou datetime), closed_at (idem), exit_reason.
    """
    if not closed_positions:
        return {
            "period_label": period_label,
            "total_trades": 0,
            "total_pnl": 0.0,
            "win_rate": None,
            "profit_factor": None,
            "strategies": [],
            "verdicts": ["sem_dados"],
            "summary": "Nenhum trade no período.",
        }

    total_pnl = round(sum(p.get("pnl") or 0 for p in closed_positions), 4)
    wins = [p for p in closed_positions if (p.get("pnl") or 0) > 0]
    losses = [p for p in closed_positions if (p.get("pnl") or 0) <= 0]
    gross_profit = sum(p["pnl"] for p in wins)
    gross_loss = abs(sum(p["pnl"] for p in losses))
    pf_global = _pf(gross_profit, gross_loss)
    win_rate = round(len(wins) / len(closed_positions) * 100, 1)

    # --- Agrupamento por estratégia ---
    by_strategy: dict[str, list[dict]] = {}
    for p in closed_positions:
        key = p.get("strategy") or p.get("plan") or "Sem estratégia"
        by_strategy.setdefault(key, []).append(p)

    strategy_stats = []
    for strat_name, strat_pos in by_strategy.items():
        s_wins = [p for p in strat_pos if (p.get("pnl") or 0) > 0]
        s_losses = [p for p in strat_pos if (p.get("pnl") or 0) <= 0]
        s_profit = sum(p["pnl"] for p in s_wins)
        s_loss = abs(sum(p["pnl"] for p in s_losses))
        s_pf = _pf(s_profit, s_loss)
        s_win_rate = round(len(s_wins) / len(strat_pos) * 100, 1)
        s_pnl = round(sum(p.get("pnl") or 0 for p in strat_pos), 4)

        avg_win = (s_profit / len(s_wins)) if s_wins else 0.0
        avg_loss = (s_loss / len(s_losses)) if s_losses else 0.0
        rr_realizado = round(avg_win / avg_loss, 2) if avg_loss > 0 else (99.9 if avg_win > 0 else 0.0)

        # Slippage nas perdas: |exit − stop| / stop
        slippages = []
        for p in s_losses:
            stop = p.get("stop_price") or 0
            exit_p = p.get("exit_price") or 0
            if stop and exit_p:
                slippages.append(abs(exit_p - stop) / stop)
        avg_slippage = round(sum(slippages) / len(slippages) * 100, 3) if slippages else 0.0

        # Duração média em minutos
        durations = []
        for p in strat_pos:
            opened = _parse_dt(p.get("opened_at"))
            closed = _parse_dt(p.get("closed_at"))
            if opened and closed:
                durations.append((closed - opened).total_seconds() / 60)
        avg_duration = round(sum(durations) / len(durations), 1) if durations else None

        # Distribuição de exitReason
        exit_reasons: dict[str, int] = {}
        for p in strat_pos:
            reason = p.get("exit_reason") or "unknown"
            exit_reasons[reason] = exit_reasons.get(reason, 0) + 1

        # Verdicts da estratégia
        verdicts: list[str] = []
        if len(strat_pos) >= 5:
            if avg_loss > 0 and avg_win < avg_loss:
                verdicts.append("rr_invertido")
            if s_pf < 1 and len(strat_pos) >= 10:
                verdicts.append("pf_baixo")
            if avg_slippage > 0.3:
                verdicts.append("slippage_alto")
        if not verdicts:
            verdicts.append("ok")

        # Delta vs relatório anterior
        delta = None
        if prev_report:
            prev_map = {s["name"]: s for s in prev_report.get("strategies", [])}
            if strat_name in prev_map:
                ps = prev_map[strat_name]
                delta = {
                    "pnl": round(s_pnl - ps.get("pnl", 0), 4),
                    "win_rate": round(s_win_rate - ps.get("win_rate", 0), 1),
                    "pf": round(s_pf - ps.get("profit_factor", 0), 3),
                }

        strategy_stats.append({
            "name": strat_name,
            "trades": len(strat_pos),
            "wins": len(s_wins),
            "losses": len(s_losses),
            "win_rate": s_win_rate,
            "pnl": s_pnl,
            "profit_factor": s_pf,
            "rr_realizado": rr_realizado,
            "avg_slippage_pct": avg_slippage,
            "avg_duration_min": avg_duration,
            "exit_reasons": exit_reasons,
            "verdicts": verdicts,
            "delta": delta,
        })

    strategy_stats.sort(key=lambda s: s["trades"], reverse=True)

    # --- Verdicts globais ---
    global_verdicts: list[str] = []
    if pf_global < 1 and len(closed_positions) >= 5:
        global_verdicts.append("pf_baixo")
    if win_rate < 40 and len(closed_positions) >= 5:
        global_verdicts.append("win_rate_baixo")
    if total_pnl < 0:
        global_verdicts.append("semana_negativa")
    else:
        global_verdicts.append("semana_positiva")

    # Resumo textual compacto (para notificação)
    rr_issues = [s["name"] for s in strategy_stats if "rr_invertido" in s["verdicts"]]
    pf_issues = [s["name"] for s in strategy_stats if "pf_baixo" in s["verdicts"]]
    sign = "+" if total_pnl >= 0 else ""
    parts = [f"{sign}{total_pnl:.2f} USD · {len(closed_positions)} trades · {win_rate:.0f}% win"]
    if rr_issues:
        parts.append(f"RR invertido: {', '.join(rr_issues)}")
    if pf_issues:
        parts.append(f"PF baixo: {', '.join(pf_issues)}")
    if not rr_issues and not pf_issues and total_pnl >= 0:
        parts.append("sem alertas críticos")

    return {
        "period_label": period_label,
        "total_trades": len(closed_positions),
        "total_pnl": total_pnl,
        "win_rate": win_rate,
        "profit_factor": pf_global,
        "strategies": strategy_stats,
        "verdicts": global_verdicts,
        "summary": " · ".join(parts),
    }
