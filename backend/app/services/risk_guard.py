"""Guarda de risco dos bots — cooldown pós-stop, limite de perdas/dia e
circuit breaker diário.

Motivação (auditoria do diário 11-30/jun): 79% do prejuízo veio de 4 dias; no
23/06 a State-aware MA Cross tomou 4 stops seguidos re-entrando logo após cada
um. Nada interrompia a sequência.

Regras (todas lidas da tabela positions — sem estado novo em banco):
  1. COOLDOWN pós-perda: depois de fechar no prejuízo, a mesma estratégia+símbolo
     só re-entra após N barras do timeframe (default 3 barras).
  2. MÁX. PERDAS/DIA: 2 fechamentos no prejuízo no dia (UTC) por estratégia+símbolo
     bloqueiam novas entradas daquele par até o dia virar.
  3. CIRCUIT BREAKER diário: PnL realizado do usuário no dia (todas as
     estratégias) abaixo de -daily_max_loss_usdt bloqueia TODAS as novas
     entradas do usuário até o dia virar. Gestão de posição aberta segue normal.

`evaluate_entry` é PURA (testável sem banco); `check_entry_allowed` coleta os
insumos no banco e é a única função que os runners precisam chamar.
"""
from __future__ import annotations

from datetime import datetime, timezone, timedelta

from sqlalchemy import func

from app.models.position import Position

DEFAULT_COOLDOWN_BARS = 3
DEFAULT_MAX_LOSSES_PER_DAY = 2
DEFAULT_DAILY_MAX_LOSS_USDT = 5.0

_TF_MINUTES = {"1m": 1, "5m": 5, "15m": 15, "30m": 30,
               "1h": 60, "1H": 60, "4h": 240, "4H": 240,
               "1d": 1440, "1D": 1440}


def _tf_minutes(tf: str | None) -> int:
    return _TF_MINUTES.get(tf or "5m", 5)


def _today_utc_start() -> datetime:
    now = datetime.now(timezone.utc)
    return now.replace(hour=0, minute=0, second=0, microsecond=0)


def evaluate_entry(now: datetime, pnl_today: float, losses_today: int,
                   last_loss_closed_at: datetime | None,
                   timeframe: str | None = None,
                   cooldown_bars: int = DEFAULT_COOLDOWN_BARS,
                   max_losses_per_day: int = DEFAULT_MAX_LOSSES_PER_DAY,
                   daily_max_loss_usdt: float = DEFAULT_DAILY_MAX_LOSS_USDT) -> dict:
    """PURA: decide se uma entrada nova é permitida. Retorna {allowed, reason}."""
    # 3) circuit breaker diário (vale para o usuário inteiro)
    if daily_max_loss_usdt and daily_max_loss_usdt > 0:
        if pnl_today <= -abs(daily_max_loss_usdt):
            return {"allowed": False,
                    "reason": f"circuit_breaker: PnL do dia {pnl_today:.2f} <= -{abs(daily_max_loss_usdt):.2f} USDT"}

    # 2) máx. perdas no dia por estratégia+símbolo
    if max_losses_per_day and losses_today >= max_losses_per_day:
        return {"allowed": False,
                "reason": f"max_losses_per_day: {losses_today} perdas hoje"}

    # 1) cooldown pós-perda
    cooldown_min = cooldown_bars * _tf_minutes(timeframe)
    if last_loss_closed_at is not None:
        if last_loss_closed_at.tzinfo is None:
            last_loss_closed_at = last_loss_closed_at.replace(tzinfo=timezone.utc)
        if (now - last_loss_closed_at) < timedelta(minutes=cooldown_min):
            return {"allowed": False,
                    "reason": f"cooldown: perda recente (aguarda {cooldown_min}min)"}

    return {"allowed": True, "reason": "ok"}


def daily_realized_pnl(db, user_id: str) -> float:
    """PnL realizado (fechados) do usuário no dia UTC corrente."""
    total = (
        db.query(func.coalesce(func.sum(Position.pnl), 0.0))
        .filter(Position.user_id == user_id,
                Position.status == "closed",
                Position.closed_at >= _today_utc_start())
        .scalar()
    )
    return float(total or 0.0)


def check_entry_allowed(db, user_id: str, strategy: str, symbol: str,
                        timeframe: str | None = None,
                        cooldown_bars: int = DEFAULT_COOLDOWN_BARS,
                        max_losses_per_day: int = DEFAULT_MAX_LOSSES_PER_DAY,
                        daily_max_loss_usdt: float = DEFAULT_DAILY_MAX_LOSS_USDT) -> dict:
    """Coleta os insumos no banco e delega a decisão a evaluate_entry."""
    now = datetime.now(timezone.utc)
    day_start = _today_utc_start()

    pnl_today = daily_realized_pnl(db, user_id) if daily_max_loss_usdt else 0.0

    losses_today = (
        db.query(func.count(Position.id))
        .filter(Position.user_id == user_id,
                Position.status == "closed",
                Position.strategy == strategy,
                Position.symbol == symbol,
                Position.pnl < 0,
                Position.closed_at >= day_start)
        .scalar()
    ) or 0

    last_loss_closed_at = (
        db.query(func.max(Position.closed_at))
        .filter(Position.user_id == user_id,
                Position.status == "closed",
                Position.strategy == strategy,
                Position.symbol == symbol,
                Position.pnl < 0)
        .scalar()
    )

    return evaluate_entry(now, pnl_today, int(losses_today), last_loss_closed_at,
                          timeframe=timeframe, cooldown_bars=cooldown_bars,
                          max_losses_per_day=max_losses_per_day,
                          daily_max_loss_usdt=daily_max_loss_usdt)
