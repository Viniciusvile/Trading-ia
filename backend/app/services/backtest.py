"""Motor de backtest — port de masterbot/lib/backtest-engine.js + strategy-signals.js.

Reusa decide_signal_for_plan (masterbot.py) como signalFn: a MESMA lógica que o
bot usa ao vivo (warrior/range-v2 + filtros + stop/tp), garantindo paridade.

Simulação candle-a-candle: após warmup, em cada candle chama o sinal sobre a
janela [0..i]; se entrar, procura SL/TP nos candles seguintes (high/low), com
saída forçada no close após maxHold candles. Custo de 0.1%/lado descontado.
"""
from __future__ import annotations

from binance.client import Client

from app.services import masterbot as mbot
from app.services import scalper_signals as scalp

TIMEFRAME_MAP = {
    "1m": Client.KLINE_INTERVAL_1MINUTE, "5m": Client.KLINE_INTERVAL_5MINUTE,
    "15m": Client.KLINE_INTERVAL_15MINUTE, "30m": Client.KLINE_INTERVAL_30MINUTE,
    "1h": Client.KLINE_INTERVAL_1HOUR, "1H": Client.KLINE_INTERVAL_1HOUR,
    "4h": Client.KLINE_INTERVAL_4HOUR, "4H": Client.KLINE_INTERVAL_4HOUR,
    "1d": Client.KLINE_INTERVAL_1DAY, "1D": Client.KLINE_INTERVAL_1DAY,
}
BACKTEST_LIMIT = 1400  # igual ao legado (fetchHistoricalCandles total=1400)
# Máx. de combinações ativo×timeframe por análise. A máquina tem só ~1GB de RAM:
# 6 combos 'custom' rodam de forma estável (~30s, backtest otimizado). As demais
# estratégias (warrior/range-v2/state-ma-cross) recomputam indicadores por barra
# (O(n²), sem o fast-path) e 6 combos levam ~99s — estoura o timeout do navegador.
# Por isso o limite é MENOR para as pesadas.
MAX_COMBOS = 6        # custom (rápido)
MAX_COMBOS_HEAVY = 4  # warrior / range-v2 / state-ma-cross (lento)


def fetch_historical_candles(client: Client, symbol: str, tf: str, limit: int = BACKTEST_LIMIT) -> list[dict]:
    """Busca candles paginando para trás (Binance limita 1000/request), igual ao legado."""
    interval = TIMEFRAME_MAP.get(tf, Client.KLINE_INTERVAL_1HOUR)
    out: list[list] = []
    end_time = None
    while len(out) < limit:
        batch = min(1000, limit - len(out))
        kwargs = {"symbol": symbol, "interval": interval, "limit": batch}
        if end_time is not None:
            kwargs["endTime"] = end_time
        raw = client.get_klines(**kwargs)
        if not raw:
            break
        out = raw + out  # prepende (estamos indo para tras no tempo)
        end_time = raw[0][0] - 1  # antes do primeiro candle deste lote
        if len(raw) < batch:
            break  # nao ha mais historico
    return [
        {"open": float(k[1]), "high": float(k[2]), "low": float(k[3]),
         "close": float(k[4]), "volume": float(k[5]), "time": int(k[0])}
        for k in out
    ]


def _signal_for_window(plan: dict, window: list[dict]) -> dict | None:
    """Adapta decide_signal_for_plan (+ scalper) ao formato {side, stop, tp} do engine."""
    strategy = plan.get("strategy", "warrior")

    # Modos do scalper: long-only com SL/TP percentuais.
    if strategy in ("micro-dip", "turbo-reversion"):
        p = plan.get("scalper") or plan.get("filters") or {}
        tp_pct = p.get("tp_pct", 0.01)
        sl_pct = p.get("sl_pct", 0.005)
        shared = {
            "trendEmaPeriod": p.get("trend_ema_period", 0),
            "trendSlopeBars": p.get("trend_slope_bars", 5),
            "trendMaxDownPct": p.get("trend_max_down_pct", 0),
            "minAtrPct": p.get("min_atr_pct", 0),
        }
        if strategy == "turbo-reversion":
            sig = scalp.turbo_reversion_signal(window, {
                "bbLen": p.get("bb_length"), "bbMult": p.get("bb_mult"),
                "rsiLen": p.get("rsi_period"), "rsiLimit": p.get("rsi_limit"),
                "volMult": p.get("vol_mult"), **shared,
            })
        else:
            sig = scalp.micro_scalp_signal(window, {
                "emaPeriod": p.get("ema_period"), "rsiPeriod": p.get("rsi_period"),
                "minDip": p.get("min_dip_pct"), "minRsi": p.get("min_rsi"),
                "maxRsi": p.get("max_rsi"), **shared,
            })
        if sig.get("signal") != "buy":
            return None
        price = window[-1]["close"]
        return {"side": "LONG", "stop": price * (1 - sl_pct), "tp": price * (1 + tp_pct)}

    # warrior / range-v2 (mesma lógica do bot ao vivo)
    decision = mbot.decide_signal_for_plan(plan, window)
    if decision.get("action") != "enter":
        return None
    return {"side": decision["side"], "stop": decision["stop"], "tp": decision["tp"]}


def simulate_trades(candles: list[dict], plan: dict, warmup: int = 250, max_hold: int = 96,
                    fee_pct_per_side: float = 0.1, slippage_pct: float = 0.05) -> list[dict]:
    """Simula trades candle-a-candle.

    fee_pct_per_side: taxa de corretagem por perna (%).
    slippage_pct: derrapagem por perna (~0.05%, conservador p/ ordens ~$100 em pares líquidos;
        recalibrado de 0.18% em 18/07/2026 — ver run_plan_backtest).
    """
    trades: list[dict] = []
    n = len(candles)
    i = warmup
    total_cost_per_trade = (fee_pct_per_side + slippage_pct) * 2  # entrada + saída

    # Caminho rápido para estratégias "custom": pré-computa os sinais de entrada e
    # saída UMA vez (série de indicadores), em vez de recomputar por barra (O(n²)).
    # Resultado idêntico ao caminho por janela (indicadores causais).
    custom_fast = plan.get("strategy") == "custom"
    entry_ok: list[bool] = []
    exit_ok: list[bool] = []
    if custom_fast:
        from app.services.condition_evaluator import evaluate_conditions_series
        entry_ok = evaluate_conditions_series(plan.get("entry_conditions") or [], candles)
        exit_ok = evaluate_conditions_series(plan.get("exit_conditions") or [], candles)

    while i < n - 1:
        if custom_fast:
            # só chama o decisor (stop/tp/side exatos) nas barras que disparam entrada
            if not (i < len(entry_ok) and entry_ok[i]):
                i += 1
                continue
            try:
                signal = _signal_for_window(plan, candles[: i + 1])
            except Exception:
                signal = None
        else:
            window = candles[: i + 1]
            try:
                signal = _signal_for_window(plan, window)
            except Exception:
                signal = None
        if not signal or signal.get("stop") is None or signal.get("tp") is None:
            i += 1
            continue

        bar = candles[i]
        entry_price = bar["close"]
        side, stop, tp = signal["side"], signal["stop"], signal["tp"]
        exit_price = None
        exit_idx = None
        result = "timeout"
        last_idx = min(n - 1, i + max_hold)

        # Configurações de Trailing Stop
        sl = plan.get("sl") or {}
        sl_type = sl.get("type")
        trail_pct = sl.get("value") or sl.get("multiplier") or 1.5
        highest_price = entry_price
        lowest_price = entry_price

        # Configurações de Saída por Sinal (Exit Conditions)
        exit_conditions = plan.get("exit_conditions") or []

        for j in range(i + 1, last_idx + 1):
            b = candles[j]

            # Atualiza Trailing Stop
            if sl_type == "trail":
                if side == "LONG":
                    highest_price = max(highest_price, b["high"])
                    stop = highest_price * (1 - trail_pct / 100)
                else:
                    lowest_price = min(lowest_price, b["low"])
                    stop = lowest_price * (1 + trail_pct / 100)

            # Verifica SL / TP
            if side == "LONG":
                if b["low"] <= stop:
                    exit_price, exit_idx, result = stop, j, "loss" if sl_type != "trail" else "trail"
                    break
                if b["high"] >= tp:
                    exit_price, exit_idx, result = tp, j, "win"
                    break
            else:
                if b["high"] >= stop:
                    exit_price, exit_idx, result = stop, j, "loss" if sl_type != "trail" else "trail"
                    break
                if b["low"] <= tp:
                    exit_price, exit_idx, result = tp, j, "win"
                    break

            # Verifica Saída por Sinal
            if exit_conditions:
                if custom_fast:
                    # sinal de saída pré-computado (mesmo resultado, sem recomputar)
                    if j < len(exit_ok) and exit_ok[j]:
                        exit_price, exit_idx, result = b["close"], j, "exit_signal"
                        break
                else:
                    try:
                        from app.services.condition_evaluator import evaluate_candle_conditions
                        window_at_j = candles[: j + 1]
                        eval_res = evaluate_candle_conditions(exit_conditions, window_at_j)
                        if eval_res["allPass"]:
                            exit_price, exit_idx, result = b["close"], j, "exit_signal"
                            break
                    except Exception:
                        pass

        if exit_price is None:
            exit_idx = last_idx
            exit_price = candles[exit_idx]["close"]
            result = "timeout"

        if side == "LONG":
            gross_pct = ((exit_price - entry_price) / entry_price) * 100
        else:
            gross_pct = ((entry_price - exit_price) / entry_price) * 100
        return_pct = gross_pct - total_cost_per_trade

        trades.append({
            "entryTime": bar["time"],
            "exitTime": candles[exit_idx]["time"],
            "side": side,
            "entryPrice": entry_price,
            "exitPrice": exit_price,
            "stop": stop,
            "tp": tp,
            "result": result,
            "grossReturnPct": round(gross_pct, 4),
            "returnPct": round(return_pct, 4),
            "holdBars": exit_idx - i,
        })
        i = exit_idx + 1

    return trades


def compute_stats(trades: list[dict], initial_capital: float = 10000) -> dict | None:
    if not trades:
        return None
    wins = [t for t in trades if t["returnPct"] > 0]
    losses = [t for t in trades if t["returnPct"] < 0]
    total_gains = sum(t["returnPct"] for t in wins)
    total_losses = abs(sum(t["returnPct"] for t in losses))

    equity = initial_capital
    peak = initial_capital
    max_dd = 0.0
    for t in trades:
        equity *= 1 + t["returnPct"] / 100
        if equity > peak:
            peak = equity
        dd = ((peak - equity) / peak) * 100
        if dd > max_dd:
            max_dd = dd

    n = len(trades)
    avg_win = (total_gains / len(wins)) if wins else 0
    avg_loss = (-total_losses / len(losses)) if losses else 0
    total_pct = sum(t["returnPct"] for t in trades)

    # Métricas brutas (sem custos) — para evidenciar o peso de taxas+slippage
    has_gross = all("grossReturnPct" in t for t in trades)
    if has_gross:
        gross_wins = [t for t in trades if t["grossReturnPct"] > 0]
        gross_losses = [t for t in trades if t["grossReturnPct"] < 0]
        g_gains = sum(t["grossReturnPct"] for t in gross_wins)
        g_losses = abs(sum(t["grossReturnPct"] for t in gross_losses))
        pf_gross = (g_gains / g_losses) if g_losses > 0 else (99 if g_gains > 0 else 0)
        gross_total_pct = sum(t["grossReturnPct"] for t in trades)
        cost_drag_pct = round((gross_total_pct - total_pct) / n, 4) if n > 0 else 0
    else:
        pf_gross = None
        cost_drag_pct = None

    pf_after_costs = (total_gains / total_losses) if total_losses > 0 else (99 if total_gains > 0 else 0)

    return {
        "totalTrades": n,
        "wins": len(wins),
        "losses": len(losses),
        "breakevens": n - len(wins) - len(losses),
        "winRate": len(wins) / n,
        "profitFactor": pf_after_costs,
        "pfAfterCosts": round(pf_after_costs, 4),
        "pfGross": round(pf_gross, 4) if pf_gross is not None else None,
        "costDragPct": cost_drag_pct,
        "netProfitPct": total_pct,
        "netProfitUsd": equity - initial_capital,
        "expectancyPct": total_pct / n,
        "avgWinPct": avg_win,
        "avgLossPct": avg_loss,
        "maxDrawdownPct": max_dd,
        "avgHoldBars": sum(t.get("holdBars", 0) for t in trades) / n,
    }


def build_equity_curve(trades: list[dict], initial_capital: float = 10000) -> list[dict]:
    sorted_t = sorted(trades, key=lambda t: t.get("exitTime") or 0)
    equity = initial_capital
    start = (sorted_t[0].get("entryTime") or sorted_t[0].get("exitTime")) if sorted_t else 0
    curve = [{"time": start, "equity": equity}]
    for t in sorted_t:
        equity *= 1 + t["returnPct"] / 100
        curve.append({"time": t["exitTime"], "equity": round(equity * 100) / 100})
    return curve


def get_plan_warnings(plan: dict) -> list[str]:
    warnings: list[str] = []
    filters = plan.get("filters") or {}
    if filters.get("adx_4h_max") is not None:
        warnings.append("O filtro de ADX 4H (adx_4h_max) é ignorado no backtest — resultado pode ser mais otimista que o bot ao vivo.")
    if plan.get("mode") != "futures" and plan.get("strategy") == "range-v2":
        warnings.append("Modo spot: sinais SHORT do Range v2 são descartados (sem venda a descoberto), igual ao bot ao vivo.")
    if plan.get("mode") != "futures" and plan.get("strategy") == "volatility-envelope":
        warnings.append("Modo spot: só as viradas de momentum para CIMA (compra) operam; viradas para baixo são descartadas (sem venda a descoberto).")
    if plan.get("strategy") == "state-ma-cross":
        warnings.append("Saída por cruzamento inverso de médias não é nativa — o robô fecha por Stop/Take/tempo máximo. Os resultados podem diferir do script original do TradingView.")
    if plan.get("strategy") in ("micro-dip", "turbo-reversion"):
        warnings.append("O backtest do scalper avalia candles fechados; o robô ao vivo reage em tempo real — os resultados são uma aproximação.")
    return warnings


MIN_PF_AFTER_COSTS = 1.3  # limiar de aprovação pós-taxas+slippage


def run_plan_backtest(plan: dict, fee_pct_per_side: float = 0.1,
                      slippage_pct: float = 0.05) -> dict:
    """Roda o backtest de um plano em todas as combinações symbol×timeframe (máx 6).

    fee_pct_per_side: taxa de corretagem por perna (padrão 0.1% = Binance, sem desconto BNB).
    slippage_pct: derrapagem por perna. Recalibrado 18/07/2026 de 0.18% -> 0.05%: os 0.18%
        de jun/2026 foram medidos em STOPS durante volatilidade e superestimavam o custo de
        ENTRADAS de ~$100 em pares LÍQUIDOS (BTC/ETH/SOL/XRP), onde a derrapagem real é ~0.02-0.05%.
        0.05% é conservador para o tamanho de ordem informado pelo usuário.
    """
    import time as _time

    symbols = plan.get("symbols") or []
    timeframes = plan.get("timeframes") or []
    if not symbols or not timeframes:
        raise ValueError("symbols e timeframes são obrigatórios")

    combos = [(s, tf) for s in symbols for tf in timeframes]
    # 'custom' tem backtest otimizado; as demais são pesadas → limite menor.
    is_heavy = plan.get("strategy", "warrior") != "custom"
    max_combos = MAX_COMBOS_HEAVY if is_heavy else MAX_COMBOS
    if len(combos) > max_combos:
        extra = (" Esta estratégia é mais pesada e suporta menos combinações por análise."
                 if is_heavy else "")
        raise ValueError(
            f"Máximo de {max_combos} combinações ativo×timeframe por análise "
            f"(você selecionou {len(combos)}: {len(symbols)} ativo(s) × {len(timeframes)} timeframe(s))."
            f"{extra} Reduza os ativos ou os timeframes."
        )

    client = Client()
    results = []
    all_trades: list[dict] = []

    for symbol, timeframe in combos:
        try:
            candles = fetch_historical_candles(client, symbol, timeframe)
            if len(candles) < 300:
                results.append({"symbol": symbol, "timeframe": timeframe,
                                "error": "Histórico insuficiente", "stats": None, "trades": []})
                continue
            trades = [{**t, "symbol": symbol, "timeframe": timeframe}
                      for t in simulate_trades(candles, plan,
                                               fee_pct_per_side=fee_pct_per_side,
                                               slippage_pct=slippage_pct)]
            all_trades.extend(trades)
            results.append({
                "symbol": symbol,
                "timeframe": timeframe,
                "periodStart": candles[0]["time"],
                "periodEnd": candles[-1]["time"],
                "stats": compute_stats(trades),
                "trades": trades[-10:],
            })
        except Exception as e:  # noqa: BLE001
            results.append({"symbol": symbol, "timeframe": timeframe,
                            "error": str(e), "stats": None, "trades": []})

    all_trades.sort(key=lambda t: t["entryTime"])
    combined = compute_stats(all_trades)
    equity_curve = build_equity_curve(all_trades)
    win_rate_target = float(plan["winRateTarget"]) if plan.get("winRateTarget") is not None else None

    # Aprovação baseada em pfAfterCosts (> win rate target E > limiar pós-custos)
    pf_after = combined.get("pfAfterCosts") if combined else None
    approved_pf = (pf_after >= MIN_PF_AFTER_COSTS) if pf_after is not None else None
    approved_wr = (combined["winRate"] * 100 >= win_rate_target) if (combined and win_rate_target is not None) else None
    approved = (approved_pf and (approved_wr is not False)) if approved_pf is not None else approved_wr

    # Walk-forward 70/30
    walk_forward = None
    periods = [r for r in results if r.get("periodStart") and r.get("periodEnd")]
    if len(all_trades) >= 8 and periods:
        t0 = min(r["periodStart"] for r in periods)
        t1 = max(r["periodEnd"] for r in periods)
        split = t0 + (t1 - t0) * 0.7
        walk_forward = {
            "splitTime": split,
            "inSample": compute_stats([t for t in all_trades if t["entryTime"] < split]),
            "outOfSample": compute_stats([t for t in all_trades if t["entryTime"] >= split]),
        }

    return {
        "ranAt": int(_time.time() * 1000),
        "combined": combined,
        "equityCurve": equity_curve,
        "winRateTarget": win_rate_target,
        "approved": approved,
        "feePctPerSide": fee_pct_per_side,
        "slippagePct": slippage_pct,
        "minPfAfterCosts": MIN_PF_AFTER_COSTS,
        "walkForward": walk_forward,
        "warnings": get_plan_warnings(plan),
        "results": results,
        "recentTrades": all_trades[-20:],
    }
