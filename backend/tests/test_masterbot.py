"""Testes da orquestracao do MasterBot (decide_signal_for_plan + resolucao de plano)."""
from app.services import masterbot as m

UP = [100, 101, 102, 101, 100, 99, 100, 102, 103, 102, 101, 100, 99,
      98, 99, 101, 103, 104, 103, 102, 104, 105, 106, 105, 104]
UP_CANDLES = [
    {"open": c, "high": c + 1, "low": c - 1, "close": c, "volume": 1000 + i * 10,
     "time": 1700000000000 + i * 3600000}
    for i, c in enumerate(UP)
]


def test_warrior_plan_enters_long_on_uptrend():
    plan = {"strategy": "warrior", "mode": "spot", "sl": {"type": "pct", "value": 1.5}, "tp": {"type": "pct", "value": 3}}
    d = m.decide_signal_for_plan(plan, UP_CANDLES)
    assert d["action"] == "enter"
    assert d["side"] == "LONG"
    assert d["strategy"] == "warrior"
    # sl/tp pct a partir do close final (104)
    assert abs(d["stop"] - 104 * 0.985) < 1e-9
    assert abs(d["tp"] - 104 * 1.03) < 1e-9


def test_warrior_no_entry_on_downtrend():
    down = [{"open": c, "high": c + 1, "low": c - 1, "close": c, "volume": 1000, "time": 1700000000000 + i * 3600000}
            for i, c in enumerate(reversed(UP))]
    d = m.decide_signal_for_plan({"strategy": "warrior", "mode": "spot"}, down)
    assert d["action"] == "none"


def test_range_v2_no_setup_returns_none():
    d = m.decide_signal_for_plan({"strategy": "range-v2", "mode": "spot"}, UP_CANDLES)
    assert d["action"] == "none"
    assert d["strategy"] == "range-v2"


def test_get_active_plan_names_array_and_single():
    assert m.get_active_plan_names({"active_plans": ["A", "B"]}) == ["A", "B"]
    assert m.get_active_plan_names({"active_plan": "X"}) == ["X"]
    assert m.get_active_plan_names({}) == []


def test_get_plan_for_symbol_respects_active_and_mode():
    rules = {
        "active_plans": ["Spot1"],
        "group_plans": [
            {"name": "Spot1", "mode": "spot", "symbols": ["BTCUSDT"]},
            {"name": "Fut1", "mode": "futures", "symbols": ["BTCUSDT"]},
        ],
    }
    p = m.get_plan_for_symbol("BTCUSDT", rules, "master")
    assert p["name"] == "Spot1"
    # simbolo nao coberto pelos ativos -> None
    assert m.get_plan_for_symbol("ETHUSDT", rules, "master") is None


def test_get_plan_for_symbol_futures_mode():
    rules = {"group_plans": [
        {"name": "Fut1", "mode": "futures", "symbols": ["BTCUSDT"]},
        {"name": "Spot1", "mode": "spot", "symbols": ["BTCUSDT"]},
    ]}
    assert m.get_plan_for_symbol("BTCUSDT", rules, "futures")["name"] == "Fut1"
    assert m.get_plan_for_symbol("BTCUSDT", rules, "master")["name"] == "Spot1"
