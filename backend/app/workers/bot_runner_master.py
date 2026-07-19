"""Task Celery do MasterBot (PAPER & REAL).

Para cada usuario com master_config:
  1. Gerencia as posições abertas do MasterBot (paper ou real).
  2. Avalia novos sinais para os planos ativos.
  3. Se houver sinal de entrada, abre a posição (paper ou real) e registra na tabela positions.
"""
from datetime import datetime, timezone
import math

from celery import shared_task
from binance.client import Client
from sqlalchemy.orm.attributes import flag_modified

from app.database import _get_session_factory
from app.models.user import User  # noqa: F401
from app.models.master import MasterPlan, MasterConfig
from app.models.bot_state import is_bot_enabled
from app.models.position import Position
from app.models.notification import Notification
from app.services import masterbot as mbot
from app.services import market_regime
from app.services import risk_guard
from app.services.exchange_client import get_adapter
from app.services.condition_evaluator import evaluate_candle_conditions

# Gate de qualidade: plano com backtest abaixo disso NÃO abre trade novo.
# Auditoria 11-30/jun: State-aware MA Cross ativada com PF 1,06 perdeu 13/13 no live.
# Subido para 1.3 após incluir slippage real no backtest (jun/2026 mediu ~0.18%/lado).
MIN_PROFIT_FACTOR = 1.3


def _plan_profit_factor(plan: dict) -> float | None:
    """pfAfterCosts do último backtest (com taxas+slippage). Fallback para profitFactor
    se o backtest ainda não tem a métrica nova (rodado antes da atualização do motor)."""
    bt = plan.get("lastBacktest") or {}
    # Tenta pfAfterCosts do combined primeiro (mais preciso)
    combined_pf = (bt.get("combined") or {}).get("pfAfterCosts")
    if isinstance(combined_pf, (int, float)):
        return combined_pf
    # Fallback: máximo dos resultados individuais (comportamento anterior)
    results = bt.get("results") or []
    pfs = []
    for r in results:
        stats = r.get("stats") or {}
        pf = stats.get("pfAfterCosts") or stats.get("profitFactor")
        if isinstance(pf, (int, float)):
            pfs.append(pf)
    return max(pfs) if pfs else None

TIMEFRAME_MAP = {
    "1m": Client.KLINE_INTERVAL_1MINUTE, "5m": Client.KLINE_INTERVAL_5MINUTE,
    "15m": Client.KLINE_INTERVAL_15MINUTE, "30m": Client.KLINE_INTERVAL_30MINUTE,
    "1h": Client.KLINE_INTERVAL_1HOUR, "1H": Client.KLINE_INTERVAL_1HOUR,
    "4h": Client.KLINE_INTERVAL_4HOUR, "4H": Client.KLINE_INTERVAL_4HOUR,
    "1d": Client.KLINE_INTERVAL_1DAY, "1D": Client.KLINE_INTERVAL_1DAY,
}
CANDLE_LIMIT = 250  # MasterBot precisa de warmup (EMA200 etc.)


def _fetch_candles(client: Client, symbol: str, tf: str) -> list[dict]:
    interval = TIMEFRAME_MAP.get(tf, Client.KLINE_INTERVAL_1HOUR)
    raw = client.get_klines(symbol=symbol, interval=interval, limit=CANDLE_LIMIT)
    return [
        {"open": float(k[1]), "high": float(k[2]), "low": float(k[3]),
         "close": float(k[4]), "volume": float(k[5]), "vol": float(k[5]), "time": int(k[0])}
        for k in raw
    ]


def _rules_for_user(db, user_id: str) -> dict:
    cfg = db.get(MasterConfig, user_id)
    data = (cfg.data if cfg else {}) or {}
    plans_objs = db.query(MasterPlan).filter(MasterPlan.user_id == user_id).all()
    plans = [p.data for p in plans_objs]
    active_plans = [p.name for p in plans_objs if p.is_active]
    return {
        "watchlist": data.get("watchlist", []),
        "active_plans": active_plans,
        "group_plans": plans,
    }


def _timeframe_to_minutes(tf: str) -> int:
    val = "".join(filter(str.isdigit, tf))
    unit = "".join(filter(str.isalpha, tf)).lower()
    if not val:
        val = "1"
    minutes = int(val)
    if unit == "h":
        minutes *= 60
    elif unit == "d":
        minutes *= 1440
    return minutes


def _register_exit(db, pos: Position, exit_price: float, reason: str) -> None:
    now = datetime.now(timezone.utc)
    pos.status = "closed"
    pos.exit_price = exit_price
    pos.closed_at = now
    pnl_val = 0.0
    if pos.entry_price and exit_price and pos.quantity:
        side_multiplier = 1.0 if pos.side == "LONG" else -1.0
        pnl_val = (exit_price - pos.entry_price) * side_multiplier * pos.quantity
        pos.pnl = pnl_val
    d = dict(pos.data or {})
    d.update({"status": "closed", "closedAt": now.isoformat(),
              "exitPrice": exit_price, "exitReason": reason})
    pos.data = d
    flag_modified(pos, "data")
    
    notif_type = "success" if pnl_val >= 0 else "error"
    db.add(Notification(
        user_id=pos.user_id,
        title=f"Fechou {pos.symbol}",
        message=f"PnL: {'+' if pnl_val >= 0 else ''}${pnl_val:.4f} | Saída: ${exit_price:.4f} ({reason})",
        type=notif_type,
    ))


def _manage_position(db, client, pos: Position, plan: dict, paper_trading: bool, ex=None) -> dict:
    """Gerencia uma posição aberta do MasterBot.

    paper: client é o Client() PÚBLICO da Binance (só dados).
    real:  ex é o adapter da exchange da conta ativa (Binance ou Coinbase);
           na Coinbase (sem OCO) o TP/SL é aplicado por SOFTWARE a cada ciclo.
    """
    symbol = pos.symbol
    d = pos.data or {}
    oco_id = d.get("ocoOrderListId")
    has_oco = (not paper_trading) and bool(oco_id) and bool(ex and ex.supports_oco)

    # 1) Se real com OCO, confere se a exchange já fechou (TP/SL bateu)
    if has_oco:
        try:
            st = ex.get_oco_status(symbol, oco_id)
            if st.get("ok") and st.get("status") == "ALL_DONE":
                _register_exit(db, pos, st.get("filled_price") or pos.take_profit_price or 0, "binance_oco_filled")
                return {"symbol": symbol, "result": "oco_filled"}
        except Exception as e:
            return {"symbol": symbol, "error": f"check_oco: {e}"}

    # 2) Busca preço atual
    try:
        if paper_trading:
            price = float(client.get_symbol_ticker(symbol=symbol)["price"])
        else:
            price = ex.price(symbol)
    except Exception as e:
        return {"symbol": symbol, "error": f"ticker: {e}"}

    # 2b) Proteção real/LONG:
    #  - com OCO: failsafe (preço furou o stop e a OCO não fechou) -> mercado;
    #  - sem OCO (Coinbase): TP/SL por SOFTWARE -> mercado quando batem.
    if not paper_trading and pos.side == "LONG":
        if has_oco:
            if pos.stop_price and price <= pos.stop_price * 0.997:
                sell = ex.close_long(symbol, pos.quantity or 0, oco_id=oco_id)
                _register_exit(db, pos, sell.get("exitPrice") or price, "stop_failsafe")
                return {"symbol": symbol, "result": "stop_failsafe", "sell_ok": sell.get("ok")}
        else:
            if pos.stop_price and price <= pos.stop_price:
                sell = ex.close_long(symbol, pos.quantity or 0)
                _register_exit(db, pos, sell.get("exitPrice") or price, "stop_loss")
                return {"symbol": symbol, "result": "stop_loss", "sell_ok": sell.get("ok")}
            if pos.take_profit_price and price >= pos.take_profit_price:
                sell = ex.close_long(symbol, pos.quantity or 0)
                _register_exit(db, pos, sell.get("exitPrice") or price, "take_profit")
                return {"symbol": symbol, "result": "take_profit", "sell_ok": sell.get("ok")}

    # 3) Trailing Stop
    sl = plan.get("sl") or {}
    sl_type = sl.get("type")
    if sl_type == "trail":
        trail_pct = sl.get("value") or sl.get("multiplier") or 1.5
        highest = d.get("highestPrice") or pos.entry_price or price
        if pos.side == "LONG":
            if price > highest:
                highest = price
                d["highestPrice"] = highest
                new_sl = highest * (1 - trail_pct / 100)
                pos.stop_price = new_sl
                flag_modified(pos, "data")

                # Se real com OCO, atualiza a OCO (cancela antiga e recoloca).
                # Sem OCO, subir pos.stop_price basta — o watchdog usa esse valor.
                if has_oco:
                    ex.cancel_oco(symbol, oco_id)
                    oco = ex.place_oco_sell(symbol, pos.quantity or 0, pos.take_profit_price, new_sl)
                    d["ocoOrderListId"] = oco.get("orderListId") if oco.get("ok") else None
                    pos.data = d
                    flag_modified(pos, "data")
        else:  # SHORT
            lowest = d.get("lowestPrice") or pos.entry_price or price
            if price < lowest:
                lowest = price
                d["lowestPrice"] = lowest
                new_sl = lowest * (1 + trail_pct / 100)
                pos.stop_price = new_sl
                flag_modified(pos, "data")
                # Sem OCO de Short em Spot real por enquanto.

    # 4) Saída por sinal (Exit Conditions)
    exit_conditions = plan.get("exit_conditions") or []
    if exit_conditions:
        try:
            if paper_trading:
                candles = _fetch_candles(client, symbol, pos.timeframe or "1H")
            else:
                candles = ex.get_candles(symbol, pos.timeframe or "1H", CANDLE_LIMIT)
            eval_res = evaluate_candle_conditions(exit_conditions, candles)
            if eval_res["allPass"]:
                if paper_trading:
                    _register_exit(db, pos, price, "exit_signal")
                    return {"symbol": symbol, "result": "exit_signal"}
                else:
                    sell = ex.close_long(symbol, pos.quantity or 0, oco_id=oco_id if has_oco else None)
                    _register_exit(db, pos, sell.get("exitPrice") or price, "exit_signal")
                    return {"symbol": symbol, "result": "exit_signal", "sell_ok": sell.get("ok")}
        except Exception as e:
            return {"symbol": symbol, "error": f"exit_conditions: {e}"}

    # 5) Watchdog de SL/TP para Paper Trading
    if paper_trading:
        if pos.side == "LONG":
            if price <= pos.stop_price:
                _register_exit(db, pos, pos.stop_price, "stop_loss")
                return {"symbol": symbol, "result": "stop_loss"}
            if price >= pos.take_profit_price:
                _register_exit(db, pos, pos.take_profit_price, "take_profit")
                return {"symbol": symbol, "result": "take_profit"}
        else:  # SHORT
            if price >= pos.stop_price:
                _register_exit(db, pos, pos.stop_price, "stop_loss")
                return {"symbol": symbol, "result": "stop_loss"}
            if price <= pos.take_profit_price:
                _register_exit(db, pos, pos.take_profit_price, "take_profit")
                return {"symbol": symbol, "result": "take_profit"}

    # 6) Timeout (max hold bars)
    max_hold = plan.get("max_hold") or plan.get("maxHold") or 96
    opened = pos.opened_at
    if opened:
        elapsed_min = (datetime.now(timezone.utc) - opened).total_seconds() / 60
        max_min = max_hold * _timeframe_to_minutes(pos.timeframe or "1H")
        if elapsed_min >= max_min:
            if paper_trading:
                _register_exit(db, pos, price, "timeout")
                return {"symbol": symbol, "result": "timeout"}
            else:
                sell = ex.close_long(symbol, pos.quantity or 0, oco_id=oco_id if has_oco else None)
                _register_exit(db, pos, sell.get("exitPrice") or price, "timeout")
                return {"symbol": symbol, "result": "timeout", "sell_ok": sell.get("ok")}

    return {"symbol": symbol, "result": "hold"}


@shared_task(name="run_masterbot")
def _interval_seconds(s: str) -> int:
    """'10m'->600, '1h'->3600, '5m'->300. Default 300 (5min)."""
    s = (str(s) if s is not None else "5m").strip().lower()
    try:
        if s.endswith("h"):
            return int(float(s[:-1]) * 3600)
        if s.endswith("m"):
            return int(float(s[:-1]) * 60)
        if s.endswith("s"):
            return int(float(s[:-1]))
        return int(float(s) * 60)  # número puro = minutos
    except (ValueError, TypeError):
        return 300


def _masterbot_throttled(cfg) -> bool:
    """True se ainda não passou o 'Intervalo de execução' escolhido pelo usuário.

    O beat dispara run_masterbot a cada 5min (fixo). Se o intervalo do usuário for
    maior (ex.: 10m/30m/1h), pulamos os ciclos intermediários — é o que faz o
    dropdown da UI realmente valer. Intervalos <= 5min rodam todo ciclo.
    """
    interval = _interval_seconds((cfg.data or {}).get("loopInterval", "5m"))
    if interval <= 300:
        return False
    last = ((cfg.data or {}).get("lastStatus") or {}).get("lastRun")
    if not last:
        return False
    try:
        last_dt = datetime.fromisoformat(last)
    except (ValueError, TypeError):
        return False
    elapsed = (datetime.now(timezone.utc) - last_dt).total_seconds()
    return elapsed < (interval - 30)  # tolerância de 30s p/ não perder o ciclo


def _daily_max_loss(cfg_data: dict) -> float:
    """Kill switch de perda diária (USDT). Lê 'dailyMaxLossUsdt' OU 'dailyMaxLoss'
    (o campo que a UI salva). Preserva 0 = desligado; só cai no default quando
    NENHUM dos dois foi definido (antes a UI ficava desconectada do guard)."""
    v = cfg_data.get("dailyMaxLossUsdt")
    if v is None:
        v = cfg_data.get("dailyMaxLoss")
    if v is None:
        return float(risk_guard.DEFAULT_DAILY_MAX_LOSS_USDT)
    try:
        return float(v)
    except (ValueError, TypeError):
        return float(risk_guard.DEFAULT_DAILY_MAX_LOSS_USDT)


def run_masterbot():
    db = _get_session_factory()()
    decisions = []
    try:
        configs = db.query(MasterConfig).all()
        for cfg in configs:
            if not is_bot_enabled(db, cfg.user_id, "master_enabled"):
                continue  # so opera para quem ligou o MasterBot
            if _masterbot_throttled(cfg):
                continue  # respeita o intervalo configurado (ex.: 10m)

            rules = _rules_for_user(db, cfg.user_id)
            user_results = []
            
            plans = rules.get("group_plans") or []
            active_names = rules.get("active_plans") or []
            paper_trading = cfg.data.get("paperTrading", True)
            
            # Map of name -> plan dict for fast lookup
            plan_map = {p.get("name"): p for p in plans if p.get("name")}
            
            # paper: Client() público (só dados). real: adapter da conta ativa
            # (Binance ou Coinbase) — dados E ordens passam pelo adapter.
            client = Client()
            ex = None
            if not paper_trading:
                try:
                    ex = get_adapter(db, cfg.user_id)
                except Exception:
                    # Sem API configurada ou erro ao descriptografar -> pula
                    continue
            
            # 1) Gerenciar posições abertas deste usuário
            open_positions = (
                db.query(Position)
                .filter(Position.user_id == cfg.user_id, Position.status == "open",
                        Position.plan != "Micro-Scalper")
                .all()
            )
            open_by_key = {}
            for pos in open_positions:
                # chave inclui timeframe: 1H e 4H do mesmo par são posições distintas
                open_by_key[(pos.plan, pos.symbol, pos.timeframe)] = pos
                p_dict = plan_map.get(pos.plan) or {}
                try:
                    _manage_position(db, client, pos, p_dict, paper_trading, ex=ex)
                except Exception as e:
                    user_results.append({"symbol": pos.symbol, "plan": pos.plan, "error": f"manage: {e}"})
            db.commit()

            # Keep track of already evaluated (plan_name, symbol) pairs to avoid double runs
            evaluated = set()
            
            # 2) Checar novos sinais
            for name in active_names:
                plan = plan_map.get(name)
                if not plan:
                    continue
                # Skip futures plans in run_masterbot
                if plan.get("mode") == "futures":
                    continue
                # Gate de qualidade: backtest fraco não abre posição nova
                # (posições já abertas seguem sendo gerenciadas normalmente).
                pf = _plan_profit_factor(plan)
                if pf is not None and pf < MIN_PROFIT_FACTOR:
                    user_results.append({"symbol": (plan.get("symbols") or [""])[0],
                                         "plan": name, "action": "blocked",
                                         "reason": f"quality_gate: profit factor {pf:.2f} < {MIN_PROFIT_FACTOR}"})
                    continue
                plan_symbols = plan.get("symbols") or []
                plan_tfs = plan.get("timeframes") or ["1H"]
                # Roda TODOS os timeframes do plano (antes só o primeiro): cada
                # (símbolo, timeframe) é um sinal independente, igual ao backtest.
                for symbol, tf in [(s, t) for s in plan_symbols for t in plan_tfs]:
                    if symbol not in rules["watchlist"]:
                        continue
                    key = (name, symbol, tf)
                    if key in evaluated:
                        continue
                    evaluated.add(key)
                    
                    # Evita abrir duplicata se já tem posição aberta para o plano/símbolo
                    if key in open_by_key:
                        user_results.append({"symbol": symbol, "plan": name, "strategy": plan.get("strategy"),
                                             "action": "hold", "reason": "posicao_aberta"})
                        continue
                    
                    try:
                        # real: candles da exchange que vai executar (adapter);
                        # paper: Client() público da Binance.
                        candles = ex.get_candles(symbol, tf, CANDLE_LIMIT) if ex else _fetch_candles(client, symbol, tf)
                        d = mbot.decide_signal_for_plan(plan, candles)
                    except Exception as e:
                        user_results.append({"symbol": symbol, "plan": name, "error": str(e)})
                        continue
                    
                    rec = {"symbol": symbol, "timeframe": tf, "plan": name, "strategy": plan.get("strategy"),
                           "action": d["action"], "side": d.get("side"), "reason": d.get("reason"),
                           "conditions": d.get("conditions", [])}
                    user_results.append(rec)
                    decisions.append({"user": cfg.user_id, **rec})
                    
                    # Abertura de Posição
                    if d["action"] == "enter":
                        side = d.get("side", "LONG")

                        # Guarda de risco: cooldown pós-stop, máx. perdas/dia e
                        # circuit breaker diário do usuário.
                        guard = risk_guard.check_entry_allowed(
                            db, cfg.user_id, plan.get("strategy"), symbol, timeframe=tf,
                            daily_max_loss_usdt=_daily_max_loss(cfg.data),
                        )
                        if not guard["allowed"]:
                            user_results[-1].update({"action": "blocked", "reason": guard["reason"]})
                            continue

                        # Regime de mercado: LONG bloqueado em bear (símbolo ou BTC macro).
                        regime = market_regime.entry_allowed(client, symbol, side)
                        if not regime["allowed"]:
                            user_results[-1].update({"action": "blocked", "reason": regime["reason"]})
                            continue

                        stop_price = d.get("stop")
                        tp_price = d.get("tp")
                        max_trade = float(cfg.data.get("maxTrade") or 20)
                        
                        now = datetime.now(timezone.utc)
                        pos_id = f"POS-MASTER-{int(now.timestamp() * 1000)}"
                        
                        if paper_trading:
                            entry_price = candles[-1]["close"]
                            qty = max_trade / entry_price
                            
                            db.add(Position(
                                id=pos_id, user_id=cfg.user_id, symbol=symbol, side=side,
                                status="open", strategy=plan.get("strategy"),
                                plan=name, timeframe=tf, quantity=qty,
                                entry_price=entry_price, stop_price=stop_price, take_profit_price=tp_price,
                                opened_at=now,
                                data={"openedAt": now.isoformat(), "side": side,
                                      "entryPrice": entry_price, "stopPrice": stop_price,
                                      "takeProfitPrice": tp_price, "strategy": plan.get("strategy"),
                                      "conditions": d.get("conditions", [])},
                                account_id="paper"
                            ))
                            db.add(Notification(
                                user_id=cfg.user_id,
                                title=f"Abriu {side} (Paper) {symbol}",
                                message=f"Estratégia: {name} | Entrada: ${entry_price:.4f}",
                                type="info",
                            ))
                        else:
                            try:
                                if side == "LONG":
                                    buy = ex.market_buy_quote(symbol, max_trade)
                                    if not buy.get("ok"):
                                        user_results[-1]["error"] = f"buy failed: {buy.get('error')}"
                                        continue
                                    entry = buy["avgPrice"]
                                    qty = buy["qty"]

                                    # Binance: OCO real. Coinbase (sem OCO): o TP/SL fica
                                    # gravado na Position e o watchdog por software fecha.
                                    oco = None
                                    if ex.supports_oco and tp_price and stop_price:
                                        oco = ex.place_oco_sell(symbol, qty, tp_price, stop_price)

                                    raw = buy.get("raw") or {}
                                    db.add(Position(
                                        id=pos_id, user_id=cfg.user_id, symbol=symbol, side=side,
                                        status="open", strategy=plan.get("strategy"),
                                        plan=name, timeframe=tf, quantity=qty,
                                        entry_price=entry, stop_price=stop_price, take_profit_price=tp_price,
                                        opened_at=now,
                                        data={"orderId": str(raw.get("orderId") or raw.get("id") or pos_id),
                                              "ocoOrderListId": oco.get("orderListId") if oco and oco.get("ok") else None,
                                              "openedAt": now.isoformat(), "side": side,
                                              "entryPrice": entry, "stopPrice": stop_price,
                                              "takeProfitPrice": tp_price, "strategy": plan.get("strategy"),
                                              "exchange": ex.exchange,
                                              "conditions": d.get("conditions", [])},
                                        account_id="default"
                                    ))
                                    db.add(Notification(
                                        user_id=cfg.user_id,
                                        title=f"Abriu {side} (Real · {ex.exchange}) {symbol}",
                                        message=f"Estratégia: {name} | Entrada: ${entry:.4f}",
                                        type="info",
                                    ))
                                else:
                                    user_results[-1]["error"] = "Short real não suportado em Spot"
                            except Exception as err:
                                db.rollback()
                                user_results[-1]["error"] = f"live order failed: {err}"
                                continue
            
            # grava o ultimo status (paper/real) no master_config.data.lastStatus do usuario
            now = datetime.now(timezone.utc).isoformat()
            new_data = dict(cfg.data or {})
            new_data["lastStatus"] = {"status": "waiting", "lastRun": now, "results": user_results}
            cfg.data = new_data
            flag_modified(cfg, "data")
        db.commit()
        return {"status": "ok", "ts": datetime.now(timezone.utc).isoformat(), "decisions": decisions}
    finally:
        db.close()


@shared_task(name="reanalyze_all_strategies")
def reanalyze_all_strategies():
    from app.database import _get_session_factory
    from app.models.master import MasterPlan
    from app.services import backtest as bt
    from sqlalchemy.orm.attributes import flag_modified
    import time
    
    db = _get_session_factory()()
    try:
        plans = db.query(MasterPlan).all()
        updated_count = 0
        for mp in plans:
            plan = dict(mp.data or {})
            if not plan.get("name") or not plan.get("symbols") or not plan.get("timeframes"):
                continue
            
            # Prepara os dados para o backtest
            plan_data = {
                "name": mp.name,
                "strategy": plan.get("strategy", "warrior"),
                "symbols": plan.get("symbols", []),
                "timeframes": plan.get("timeframes", []),
                "mode": plan.get("mode", "spot"),
                "sl": plan.get("sl", {}),
                "tp": plan.get("tp", {}),
                "filters": plan.get("filters", {}),
                "winRateTarget": plan.get("winRateTarget"),
                "entry_conditions": plan.get("entry_conditions", []),
                "entry_side": plan.get("entry_side", "LONG"),
                "exit_conditions": plan.get("exit_conditions", []),
            }
            
            try:
                result = bt.run_plan_backtest(plan_data)
                
                # Salva o resultado
                data = dict(mp.data or {})
                data["lastBacktest"] = result
                mp.data = data
                flag_modified(mp, "data")
                db.commit()
                updated_count += 1
                
                # Sleep de 0.5s para evitar rate limits da API da Binance
                time.sleep(0.5)
            except Exception as e:
                db.rollback()
                continue
        return {"status": "ok", "total_plans": len(plans), "updated_plans": updated_count}
    finally:
        db.close()

