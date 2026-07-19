"""Task Celery do Micro-Scalper em modo REAL (executa ordem na exchange).

Opt-in DUPLO de segurança: só opera para um usuário se
  (1) o scalper está ligado (is_bot_enabled micro_enabled) E
  (2) user_micro_config.data.live == True.
Sem os dois, nada é executado — a task paper (run_micro_scalper) segue independente.

MULTI-EXCHANGE: opera na conta ATIVA do usuário via adapter (exchange_client) —
Binance (respeita is_testnet) ou Coinbase. Proteção da posição:
  - Binance: OCO real na exchange (TP/SL plantados) + failsafe por software;
  - Coinbase (sem OCO): TP/SL 100% por SOFTWARE — a cada ciclo (60s) o preço é
    comparado com stop/take gravados na Position e a saída é a mercado.

Ciclo por usuário:
  1. Para cada posição ABERTA do scalper: consulta OCO (se houver). Se ALL_DONE
     -> registra saída. Senão: TP/SL por software (sem OCO) ou failsafe (com
     OCO), breakeven e timeout.
  2. Para cada símbolo ativo SEM posição aberta: risk_guard + regime de mercado;
     se sinal 'buy', abre (market por valor) + proteção (OCO ou software) +
     grava Position.
"""
from datetime import datetime, timezone

from celery import shared_task

from app.database import _get_session_factory
from app.models.user import User  # noqa: F401  (registra 'users' p/ FK)
from app.models.micro import UserMicroConfig, MicroHeartbeat
from app.models.position import Position
from app.models.bot_state import is_bot_enabled
from app.models.notification import Notification
from app.services import micro_scalper as scalper
from app.services import scalper_executor as se
from app.services import market_regime
from app.services import risk_guard
from app.services.exchange_client import get_adapter

CANDLE_LIMIT = 250

# cliente PÚBLICO da Binance p/ dados de regime (fonte de preço 4H) — vale para
# qualquer exchange de execução; sem credencial.
_public_client = None


def _regime_client():
    global _public_client
    if _public_client is None:
        from binance.client import Client
        _public_client = Client()
    return _public_client


def _now_ms() -> int:
    return int(datetime.now(timezone.utc).timestamp() * 1000)


def _open_positions(db, user_id: str) -> list[Position]:
    return (
        db.query(Position)
        .filter(Position.user_id == user_id, Position.status == "open",
                Position.plan == "Micro-Scalper")
        .all()
    )


def _register_exit(db, pos: Position, exit_price: float, reason: str) -> None:
    now = datetime.now(timezone.utc)
    pos.status = "closed"
    pos.exit_price = exit_price
    pos.closed_at = now
    pnl_val = 0.0
    if pos.entry_price and exit_price and pos.quantity:
        pnl_val = (exit_price - pos.entry_price) * pos.quantity
        pos.pnl = pnl_val
    d = dict(pos.data or {})
    d.update({"status": "closed", "closedAt": now.isoformat(),
              "exitPrice": exit_price, "exitReason": reason})
    pos.data = d
    from sqlalchemy.orm.attributes import flag_modified
    flag_modified(pos, "data")

    # Adiciona notificação
    notif_type = "success" if pnl_val >= 0 else "error"
    db.add(Notification(
        user_id=pos.user_id,
        title=f"Fechou {pos.symbol}",
        message=f"PnL: {'+' if pnl_val >= 0 else ''}${pnl_val:.4f} | Saída: ${exit_price:.4f} ({reason})",
        type=notif_type,
    ))


def _cancel_native_stop(ex, pos: Position) -> None:
    """Cancela stop nativo da Coinbase antes de fechar (evita ordem órfã).

    Silencia erros — se o stop já executou ou foi cancelado, o fechamento
    a mercado pelo watchdog ainda é válido e seguro.
    """
    stop_id = (pos.data or {}).get("stopOrderId")
    if stop_id and hasattr(ex, "cancel_stop"):
        try:
            ex.cancel_stop(pos.symbol, stop_id)
        except Exception:
            pass


def _manage_position(db, ex, pos: Position, cfg_plan: dict) -> dict:
    """Gerencia UMA posição aberta. Retorna {symbol, result}."""
    symbol = pos.symbol
    d = pos.data or {}
    oco_id = d.get("ocoOrderListId")
    has_oco = bool(oco_id) and ex.supports_oco

    # 1) OCO bateu? (TP/SL fechou na exchange — só Binance)
    if has_oco:
        st = ex.get_oco_status(symbol, oco_id)
        if st.get("ok") and st.get("status") == "ALL_DONE":
            _register_exit(db, pos, st.get("filled_price") or pos.take_profit_price or 0, "binance_oco_filled")
            return {"symbol": symbol, "result": "oco_filled"}

    price = ex.price(symbol)

    if has_oco:
        # Failsafe de stop: preço passou do stop e a OCO NÃO fechou (stop-limit
        # furado por gap/livro raso) -> sai a mercado.
        if pos.stop_price and price <= pos.stop_price * 0.997:
            sell = ex.close_long(symbol, pos.quantity or 0, oco_id=oco_id)
            _register_exit(db, pos, sell.get("exitPrice") or price, "stop_failsafe")
            return {"symbol": symbol, "result": "stop_failsafe", "sell_ok": sell.get("ok")}
    else:
        # TP/SL por SOFTWARE (exchange sem OCO, ex.: Coinbase): compara o preço
        # com os níveis gravados e fecha a mercado quando batem.
        # Stop nativo da Coinbase é cancelado antes de fechar (evita ordem órfã).
        if pos.stop_price and price <= pos.stop_price:
            _cancel_native_stop(ex, pos)
            sell = ex.close_long(symbol, pos.quantity or 0)
            _register_exit(db, pos, sell.get("exitPrice") or price, "stop_loss")
            return {"symbol": symbol, "result": "stop_loss", "sell_ok": sell.get("ok")}
        if pos.take_profit_price and price >= pos.take_profit_price:
            _cancel_native_stop(ex, pos)
            sell = ex.close_long(symbol, pos.quantity or 0)
            _register_exit(db, pos, sell.get("exitPrice") or price, "take_profit")
            return {"symbol": symbol, "result": "take_profit", "sell_ok": sell.get("ok")}

    # 2) breakeven / timeout
    # Breakeven automático: sem breakeven_pct configurado, arma em 40% do caminho
    # até o TP (auditoria: trades com breakeven armado deram +$5,58; sem, -$37,93).
    breakeven_pct = cfg_plan.get("breakeven_pct") or (cfg_plan.get("tp_pct", 0.01) * 0.4)
    pos_state = {
        "entry_price": pos.entry_price,
        "sl_price": pos.stop_price,
        "opened_at_ms": int(pos.opened_at.timestamp() * 1000) if pos.opened_at else 0,
        "max_hold_ms": cfg_plan.get("max_hold_ms") or d.get("maxHoldMs") or 0,
        "breakeven_pct": breakeven_pct,
        "breakeven_triggered": d.get("breakevenTriggered", False),
    }
    decision = se.decide_management(pos_state, price, _now_ms())

    if decision["action"] == "breakeven":
        new_sl = decision["new_sl"]
        d = dict(pos.data or {})
        d["breakevenTriggered"] = True
        if has_oco:
            # cancela OCO antiga e recoloca com SL mais alto
            ex.cancel_oco(symbol, oco_id)
            oco = ex.place_oco_sell(symbol, pos.quantity or 0, pos.take_profit_price, new_sl)
            if oco.get("ok"):
                d["ocoOrderListId"] = oco.get("orderListId")
            oco_ok = oco.get("ok")
        else:
            # Coinbase: atualiza stop nativo (cancela antigo, planta no novo SL)
            stop_id = d.get("stopOrderId")
            if stop_id and hasattr(ex, "cancel_stop"):
                ex.cancel_stop(symbol, stop_id)
                new_stop_order = ex.place_stop_sell(symbol, pos.quantity or 0, new_sl) if hasattr(ex, "place_stop_sell") else {"ok": False}
                d["stopOrderId"] = new_stop_order.get("orderId") if new_stop_order.get("ok") else stop_id
            oco_ok = True
        pos.stop_price = new_sl
        pos.data = d
        from sqlalchemy.orm.attributes import flag_modified
        flag_modified(pos, "data")
        return {"symbol": symbol, "result": "breakeven", "oco_ok": oco_ok}

    if decision["action"] == "timeout_exit":
        if not has_oco:
            _cancel_native_stop(ex, pos)
        sell = ex.close_long(symbol, pos.quantity or 0, oco_id=oco_id if has_oco else None)
        _register_exit(db, pos, sell.get("exitPrice") or price, "timeout")
        return {"symbol": symbol, "result": "timeout_exit", "sell_ok": sell.get("ok")}

    return {"symbol": symbol, "result": "hold"}


@shared_task(name="run_micro_scalper_real")
def run_micro_scalper_real():
    db = _get_session_factory()()
    results = []
    try:
        for cfg in db.query(UserMicroConfig).all():
            data = cfg.data or {}
            # opt-in DUPLO: bot ligado E modo live habilitado
            if not is_bot_enabled(db, cfg.user_id, "micro_enabled"):
                continue
            if not data.get("live"):
                continue

            try:
                ex = get_adapter(db, cfg.user_id)
            except Exception as e:  # sem credencial valida -> pula usuario
                results.append({"user": cfg.user_id, "error": f"client: {e}"})
                continue

            plans = data.get("plans") or {}

            # 1) gerencia posicoes abertas primeiro (libera saldo)
            open_by_symbol = {}
            for pos in _open_positions(db, cfg.user_id):
                open_by_symbol[pos.symbol] = pos
                try:
                    results.append({"user": cfg.user_id, **_manage_position(db, ex, pos, plans.get(pos.symbol) or {})})
                except Exception as e:
                    results.append({"user": cfg.user_id, "symbol": pos.symbol, "error": f"manage: {e}"})
            db.commit()

            # 2) novas entradas (so em simbolos SEM posicao aberta)
            for symbol in scalper.active_symbols(data):
                if symbol in open_by_symbol:
                    continue
                plan = plans.get(symbol)
                if not plan:
                    continue
                try:
                    # Guarda de risco: cooldown pós-stop, máx. perdas/dia e
                    # circuit breaker diário (auditoria 11-30/jun).
                    guard = risk_guard.check_entry_allowed(
                        db, cfg.user_id, plan.get("strategy_mode", "micro-dip"), symbol,
                        timeframe="5m",
                        daily_max_loss_usdt=float(data.get("daily_max_loss_usdt", risk_guard.DEFAULT_DAILY_MAX_LOSS_USDT)),
                    )
                    if not guard["allowed"]:
                        results.append({"user": cfg.user_id, "symbol": symbol,
                                        "result": "blocked", "reason": guard["reason"]})
                        continue

                    # Regime de mercado: nada de LONG com o símbolo ou o BTC em bear no 4H.
                    regime = market_regime.entry_allowed(_regime_client(), symbol, "LONG")
                    if not regime["allowed"]:
                        results.append({"user": cfg.user_id, "symbol": symbol,
                                        "result": "blocked", "reason": regime["reason"]})
                        continue

                    candles = ex.get_candles(symbol, "5m", CANDLE_LIMIT)
                    sig = scalper.decide_signal_for_symbol(plan, candles)
                    if sig["action"] != "buy":
                        continue
                    trade_usdt = float(data.get("max_trade_usdt", 20))
                    buy = ex.market_buy_quote(symbol, trade_usdt)
                    if not buy.get("ok"):
                        results.append({"user": cfg.user_id, "symbol": symbol, "error": f"buy: {buy.get('error')}"})
                        continue
                    entry = buy["avgPrice"]
                    qty = buy["qty"]
                    tp_pct = plan.get("tp_pct", 0.015)
                    sl_pct = plan.get("sl_pct", 0.01)
                    levels = se.compute_tp_sl(entry, tp_pct, sl_pct, "buy")
                    now = datetime.now(timezone.utc)
                    pos_id = f"POS-SCALPER-{int(now.timestamp() * 1000)}"

                    # Proteção: OCO real na Binance; Coinbase usa stop nativo
                    # (place_stop_sell) + watchdog por software como failsafe.
                    oco = ex.place_oco_sell(symbol, qty, levels["tp"], levels["sl"]) if ex.supports_oco else None
                    stop_order = None
                    if not ex.supports_oco and hasattr(ex, "place_stop_sell"):
                        stop_order = ex.place_stop_sell(symbol, qty, levels["sl"])

                    raw = buy.get("raw") or {}
                    order_id = raw.get("orderId") or raw.get("id") or pos_id
                    db.add(Position(
                        id=pos_id, user_id=cfg.user_id, symbol=symbol, side="LONG",
                        status="open", strategy=plan.get("strategy_mode", "micro-dip"),
                        plan="Micro-Scalper", timeframe="5m", quantity=qty,
                        entry_price=entry, stop_price=levels["sl"], take_profit_price=levels["tp"],
                        opened_at=now,
                        data={"orderId": str(order_id),
                              "ocoOrderListId": oco.get("orderListId") if oco and oco.get("ok") else None,
                              "stopOrderId": stop_order.get("orderId") if stop_order and stop_order.get("ok") else None,
                              "openedAt": now.isoformat(), "side": "LONG",
                              "entryPrice": entry, "stopPrice": levels["sl"],
                              "takeProfitPrice": levels["tp"], "strategy": plan.get("strategy_mode", "micro-dip"),
                              "exchange": ex.exchange,
                              "signal": sig.get("signal"), "breakevenTriggered": False},
                        account_id="default",
                    ))
                    db.add(Notification(
                        user_id=cfg.user_id,
                        title=f"Abriu LONG {symbol} ({ex.exchange})",
                        message=f"Preço de Entrada: ${entry:.4f} | Quantidade: {qty:.4f}",
                        type="info",
                    ))
                    db.commit()
                    results.append({"user": cfg.user_id, "symbol": symbol, "result": "opened",
                                    "exchange": ex.exchange, "entry": entry, "qty": qty,
                                    "oco_ok": oco.get("ok") if oco else None,
                                    "stop_ok": stop_order.get("ok") if stop_order else None})
                except Exception as e:
                    db.rollback()
                    results.append({"user": cfg.user_id, "symbol": symbol, "error": f"entry: {e}"})

        # heartbeat
        hb = db.get(MicroHeartbeat, 1)
        now = datetime.now(timezone.utc)
        if hb:
            hb.ts = now
        else:
            db.add(MicroHeartbeat(id=1, ts=now))
        db.commit()
        return {"status": "ok", "results": results}
    finally:
        db.close()
