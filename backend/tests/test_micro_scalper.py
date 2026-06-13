"""Testes da camada de decisao do Micro-Scalper (parte pura, sem I/O)."""
from app.services import micro_scalper as m


def _mk(closes):
    return [{"open": c, "high": c + 0.3, "low": c - 0.3, "close": c, "volume": 1000, "vol": 1000} for c in closes]


UP = [100, 100.5, 101, 101.5, 102, 102.5, 103, 103.5, 104, 104.5,
      105, 105.5, 106, 106.5, 107, 107.5, 108, 108.5, 109, 108.6]


def test_decide_buy_micro_dip_sets_sl_tp():
    plan = {"strategy_mode": "micro-dip", "ema_period": 8, "rsi_period": 3,
            "min_dip_pct": 0.001, "min_rsi": 20, "max_rsi": 90,
            "sl_pct": 0.005, "tp_pct": 0.01}
    d = m.decide_signal_for_symbol(plan, _mk(UP))
    assert d["action"] == "buy"
    assert d["entryPrice"] == 108.6
    assert abs(d["slPrice"] - 108.6 * 0.995) < 1e-9
    assert abs(d["tpPrice"] - 108.6 * 1.01) < 1e-9


def test_decide_none_on_flat():
    plan = {"strategy_mode": "micro-dip", "min_dip_pct": 0.001, "sl_pct": 0.005, "tp_pct": 0.01}
    d = m.decide_signal_for_symbol(plan, _mk([100] * 20))
    assert d["action"] == "none"


def test_decide_turbo_reversion_flat():
    plan = {"strategy_mode": "turbo-reversion", "sl_pct": 0.003, "tp_pct": 0.006}
    d = m.decide_signal_for_symbol(plan, _mk([100] * 20))
    assert d["action"] == "none"


def test_active_symbols_from_active_list():
    assert m.active_symbols({"active_symbols": ["BTCUSDT", "ETHUSDT"]}) == ["BTCUSDT", "ETHUSDT"]


def test_active_symbols_fallback_to_plans():
    assert set(m.active_symbols({"plans": {"BTCUSDT": {}, "SOLUSDT": {}}})) == {"BTCUSDT", "SOLUSDT"}


def test_turbo_reversion_parity_with_legacy_xrp_entry():
    """Paridade de execucao: reproduz um entry real do legado (XRPUSDT migrado).

    O legado registrou entry=1.1304, sl=1.1190959..., tp=1.1524428 com o plano
    turbo-reversion sl_pct=0.01/tp_pct=0.0195. O port deve disparar o mesmo sinal
    e calcular o mesmo sl/tp a partir do entryPrice.
    """
    plan = {"strategy_mode": "turbo-reversion", "sl_pct": 0.01, "tp_pct": 0.0195,
            "bb_length": 20, "bb_mult": 1.8, "rsi_period": 14, "rsi_limit": 35, "vol_mult": 1.3}
    closes = [1.20] * 20 + [1.19, 1.17, 1.15, 1.135, 1.1304]
    candles = [{"open": c, "high": c + 0.001, "low": c - 0.001, "close": c, "volume": 1000, "vol": 1000} for c in closes]
    candles[-1]["vol"] = 5000
    candles[-1]["volume"] = 5000
    d = m.decide_signal_for_symbol(plan, candles)
    assert d["action"] == "buy"
    assert d["reason"] == "turbo-reversion-bottom"
    assert abs(d["slPrice"] - 1.1304 * 0.99) < 1e-9
    assert abs(d["tpPrice"] - 1.1304 * 1.0195) < 1e-9
