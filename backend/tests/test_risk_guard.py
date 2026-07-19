"""Testes da guarda de risco (parte PURA, sem banco)."""
from datetime import datetime, timezone, timedelta

from app.services.risk_guard import evaluate_entry

NOW = datetime(2026, 7, 1, 12, 0, 0, tzinfo=timezone.utc)


def test_allows_clean_state():
    r = evaluate_entry(NOW, pnl_today=0.0, losses_today=0, last_loss_closed_at=None)
    assert r["allowed"]


def test_circuit_breaker_blocks_all_entries():
    r = evaluate_entry(NOW, pnl_today=-6.0, losses_today=0, last_loss_closed_at=None,
                       daily_max_loss_usdt=5.0)
    assert not r["allowed"]
    assert "circuit_breaker" in r["reason"]


def test_circuit_breaker_disabled_when_zero():
    r = evaluate_entry(NOW, pnl_today=-100.0, losses_today=0, last_loss_closed_at=None,
                       daily_max_loss_usdt=0)
    assert r["allowed"]


def test_max_losses_per_day_blocks():
    old_loss = NOW - timedelta(hours=5)  # fora do cooldown
    r = evaluate_entry(NOW, pnl_today=-1.0, losses_today=2, last_loss_closed_at=old_loss)
    assert not r["allowed"]
    assert "max_losses_per_day" in r["reason"]


def test_cooldown_blocks_recent_loss_5m():
    # 3 barras de 5m = 15min; perda há 10min ainda bloqueia
    r = evaluate_entry(NOW, pnl_today=-1.0, losses_today=1,
                       last_loss_closed_at=NOW - timedelta(minutes=10), timeframe="5m")
    assert not r["allowed"]
    assert "cooldown" in r["reason"]


def test_cooldown_expires_5m():
    r = evaluate_entry(NOW, pnl_today=-1.0, losses_today=1,
                       last_loss_closed_at=NOW - timedelta(minutes=20), timeframe="5m")
    assert r["allowed"]


def test_cooldown_scales_with_timeframe_4h():
    # 3 barras de 4H = 12h; perda há 5h ainda bloqueia (evita o 23/06:
    # 4 stops da MA Cross re-entrando em sequência no mesmo dia)
    r = evaluate_entry(NOW, pnl_today=-1.0, losses_today=1,
                       last_loss_closed_at=NOW - timedelta(hours=5), timeframe="4H")
    assert not r["allowed"]


def test_naive_datetime_is_treated_as_utc():
    naive = (NOW - timedelta(minutes=10)).replace(tzinfo=None)
    r = evaluate_entry(NOW, pnl_today=0.0, losses_today=1,
                       last_loss_closed_at=naive, timeframe="5m")
    assert not r["allowed"]
