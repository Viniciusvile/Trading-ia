"""Testes do port dos guardrails do Adaptive-Bot (params.js -> adaptive_params.py).

Valores de referencia capturados do params.js legado.
"""
import pytest
from app.services import adaptive_params as ap


def test_clamp_caps_step_above():
    # sl_pct=0.5 e ema=999 muito acima -> limitados pelo step +25% do atual
    r = ap.clamp_params({"sl_pct": 0.5, "ema_period": 999}, ap.DEFAULT_PARAMS)
    assert abs(r["params"]["sl_pct"] - 0.0075) < 1e-9   # 0.006 * 1.25
    assert r["params"]["ema_period"] == 25               # round(20 * 1.25)
    assert set(r["changed"]) >= {"ema_period", "sl_pct"}


def test_clamp_keeps_value_within_step():
    r = ap.clamp_params({"sl_pct": 0.0065}, ap.DEFAULT_PARAMS)
    assert abs(r["params"]["sl_pct"] - 0.0065) < 1e-9
    assert "sl_pct" not in r["changed"]


def test_validate_rejects_unknown_key():
    with pytest.raises(ValueError):
        ap.validate_proposal({"foo": 1})


def test_validate_rejects_bad_strategy():
    with pytest.raises(ValueError):
        ap.validate_proposal({"strategy": "inexistente"})


def test_validate_rejects_non_numeric():
    with pytest.raises(ValueError):
        ap.validate_proposal({"sl_pct": "alto"})


def test_validate_accepts_empty():
    assert ap.validate_proposal({}) is True


def test_clamp_uses_current_strategy_when_invalid():
    r = ap.clamp_params({"strategy": "xpto"}, ap.DEFAULT_PARAMS)
    assert r["params"]["strategy"] == "micro-dip"
