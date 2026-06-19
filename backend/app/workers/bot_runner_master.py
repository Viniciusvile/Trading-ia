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
from app.services import order_real as o
from app.services.order_executor import get_binance_client
from app.services.condition_evaluator import evaluate_candle_conditions

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


def _manage_position(db, client, pos: Position, plan: dict, paper_trading: bool) -> dict:
    """Gerencia uma posição aberta do MasterBot."""
    symbol = pos.symbol
    d = pos.data or {}
    
    # 1) Se real, confere OCO primeiro
    if not paper_trading:
        oco_id = d.get("ocoOrderListId")
        if oco_id:
            try:
                st = o.get_oco(client, oco_id)
                if st.get("ok") and st.get("status") == "ALL_DONE":
                    _register_exit(db, pos, st.get("filled_price") or pos.take_profit_price or 0, "binance_oco_filled")
                    return {"symbol": symbol, "result": "oco_filled"}
            except Exception as e:
                return {"symbol": symbol, "error": f"check_oco: {e}"}

    # 2) Busca preço atual
    try:
        ticker = client.get_symbol_ticker(symbol=symbol)
        price = float(ticker["price"])
    except Exception as e:
        return {"symbol": symbol, "error": f"ticker: {e}"}

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
                
                # Se real, atualiza OCO (cancela antiga e recoloca)
                if not paper_trading:
                    oco_id = d.get("ocoOrderListId")
                    if oco_id:
                        o.cancel_oco(client, symbol, oco_id)
                    oco_qty = o.fmt_qty(symbol, pos.quantity * 0.999, plan)
                    oco = o.place_oco_sell(client, symbol, oco_qty, pos.take_profit_price, new_sl, new_sl * 0.99)
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
            candles = _fetch_candles(client, symbol, pos.timeframe or "1H")
            eval_res = evaluate_candle_conditions(exit_conditions, candles)
            if eval_res["allPass"]:
                if paper_trading:
                    _register_exit(db, pos, price, "exit_signal")
                    return {"symbol": symbol, "result": "exit_signal"}
                else:
                    sell = o.close_long(client, symbol, pos.quantity or 0, plan, oco_id=d.get("ocoOrderListId"))
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
                sell = o.close_long(client, symbol, pos.quantity or 0, plan, oco_id=d.get("ocoOrderListId"))
                _register_exit(db, pos, sell.get("exitPrice") or price, "timeout")
                return {"symbol": symbol, "result": "timeout", "sell_ok": sell.get("ok")}

    return {"symbol": symbol, "result": "hold"}


@shared_task(name="run_masterbot")
def run_masterbot():
    db = _get_session_factory()()
    decisions = []
    try:
        configs = db.query(MasterConfig).all()
        for cfg in configs:
            if not is_bot_enabled(db, cfg.user_id, "master_enabled"):
                continue  # so opera para quem ligou o MasterBot
            
            rules = _rules_for_user(db, cfg.user_id)
            user_results = []
            
            plans = rules.get("group_plans") or []
            active_names = rules.get("active_plans") or []
            paper_trading = cfg.data.get("paperTrading", True)
            
            # Map of name -> plan dict for fast lookup
            plan_map = {p.get("name"): p for p in plans if p.get("name")}
            
            # Client para chamadas (autenticado se real, público se paper)
            if paper_trading:
                client = Client()
            else:
                try:
                    client = get_binance_client(db, cfg.user_id)
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
                open_by_key[(pos.plan, pos.symbol)] = pos
                p_dict = plan_map.get(pos.plan) or {}
                try:
                    _manage_position(db, client, pos, p_dict, paper_trading)
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
                plan_symbols = plan.get("symbols") or []
                for symbol in plan_symbols:
                    if symbol not in rules["watchlist"]:
                        continue
                    key = (name, symbol)
                    if key in evaluated:
                        continue
                    evaluated.add(key)
                    
                    # Evita abrir duplicata se já tem posição aberta para o plano/símbolo
                    if key in open_by_key:
                        user_results.append({"symbol": symbol, "plan": name, "strategy": plan.get("strategy"),
                                             "action": "hold", "reason": "posicao_aberta"})
                        continue
                    
                    tf = (plan.get("timeframes") or ["1H"])[0]
                    try:
                        candles = _fetch_candles(client, symbol, tf)
                        d = mbot.decide_signal_for_plan(plan, candles)
                    except Exception as e:
                        user_results.append({"symbol": symbol, "plan": name, "error": str(e)})
                        continue
                    
                    rec = {"symbol": symbol, "plan": name, "strategy": plan.get("strategy"),
                           "action": d["action"], "side": d.get("side"), "reason": d.get("reason"),
                           "conditions": d.get("conditions", [])}
                    user_results.append(rec)
                    decisions.append({"user": cfg.user_id, **rec})
                    
                    # Abertura de Posição
                    if d["action"] == "enter":
                        side = d.get("side", "LONG")
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
                                    buy = o.open_long(client, symbol, max_trade, plan)
                                    if not buy["ok"]:
                                        user_results[-1]["error"] = f"buy failed: {buy.get('error')}"
                                        continue
                                    entry = buy["avgPrice"]
                                    qty = buy["qty"]
                                    
                                    oco_qty = o.fmt_qty(symbol, qty * 0.999, plan)
                                    oco = o.place_oco_sell(client, symbol, oco_qty, tp_price, stop_price, stop_price * 0.99)
                                    
                                    db.add(Position(
                                        id=pos_id, user_id=cfg.user_id, symbol=symbol, side=side,
                                        status="open", strategy=plan.get("strategy"),
                                        plan=name, timeframe=tf, quantity=qty,
                                        entry_price=entry, stop_price=stop_price, take_profit_price=tp_price,
                                        opened_at=now,
                                        data={"orderId": str(buy["raw"].get("orderId", pos_id)),
                                              "ocoOrderListId": oco.get("orderListId") if oco.get("ok") else None,
                                              "openedAt": now.isoformat(), "side": side,
                                              "entryPrice": entry, "stopPrice": stop_price,
                                              "takeProfitPrice": tp_price, "strategy": plan.get("strategy"),
                                              "conditions": d.get("conditions", [])},
                                        account_id="default"
                                    ))
                                    db.add(Notification(
                                        user_id=cfg.user_id,
                                        title=f"Abriu {side} (Real) {symbol}",
                                        message=f"Estratégia: {name} | Entrada: ${entry:.4f}",
                                        type="info",
                                    ))
                                else:
                                    user_results[-1]["error"] = "Short real não suportado em Spot"
                            except Exception as ex:
                                db.rollback()
                                user_results[-1]["error"] = f"live order failed: {ex}"
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
