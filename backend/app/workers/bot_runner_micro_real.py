"""Task Celery do Micro-Scalper em modo REAL (executa ordem na Binance).

Opt-in DUPLO de segurança: só opera para um usuário se
  (1) o scalper está ligado (is_bot_enabled micro_enabled) E
  (2) user_micro_config.data.live == True.
Sem os dois, nada é executado — a task paper (run_micro_scalper) segue independente.

O client é o AUTENTICADO do usuário (binance_config) e respeita is_testnet — então
um usuário com a conta testnet ativa opera na testnet (dinheiro fake). NUNCA rodar
junto com o bot legado na MESMA conta real.

Ciclo por usuário:
  1. Para cada posição ABERTA do scalper: consulta OCO. Se ALL_DONE -> registra
     saída (a Binance já vendeu via OCO). Senão decide_management: breakeven (cancela
     e recoloca OCO com SL mais alto) ou timeout (fecha a mercado).
  2. Para cada símbolo ativo SEM posição aberta: decide sinal; se 'buy', abre
     (open_long) + coloca OCO (place_oco_sell) + grava Position.
"""
from datetime import datetime, timezone

from celery import shared_task
from binance.client import Client

from app.database import _get_session_factory
from app.models.user import User  # noqa: F401  (registra 'users' p/ FK)
from app.models.micro import UserMicroConfig, MicroHeartbeat
from app.models.position import Position
from app.models.bot_state import is_bot_enabled
from app.models.notification import Notification
from app.services import micro_scalper as scalper
from app.services import order_real as o
from app.services import scalper_executor as se
from app.services.order_executor import get_binance_client

SCALPER_INTERVAL = Client.KLINE_INTERVAL_5MINUTE
CANDLE_LIMIT = 100


def _fetch_candles(client: Client, symbol: str) -> list[dict]:
    raw = client.get_klines(symbol=symbol, interval=SCALPER_INTERVAL, limit=CANDLE_LIMIT)
    return [
        {"open": float(k[1]), "high": float(k[2]), "low": float(k[3]),
         "close": float(k[4]), "volume": float(k[5]), "vol": float(k[5]), "time": int(k[0])}
        for k in raw
    ]


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


def _manage_position(db, client, pos: Position, cfg_plan: dict) -> dict:
    """Gerencia UMA posição aberta. Retorna {symbol, result}."""
    symbol = pos.symbol
    d = pos.data or {}
    oco_id = d.get("ocoOrderListId")

    # 1) OCO bateu? (TP/SL fechou na Binance)
    if oco_id:
        st = o.get_oco(client, oco_id)
        if st.get("ok") and st.get("status") == "ALL_DONE":
            _register_exit(db, pos, st.get("filled_price") or pos.take_profit_price or 0, "binance_oco_filled")
            return {"symbol": symbol, "result": "oco_filled"}

    # 2) breakeven / timeout
    price = float(client.get_symbol_ticker(symbol=symbol)["price"])
    pos_state = {
        "entry_price": pos.entry_price,
        "sl_price": pos.stop_price,
        "opened_at_ms": int(pos.opened_at.timestamp() * 1000) if pos.opened_at else 0,
        "max_hold_ms": cfg_plan.get("max_hold_ms") or d.get("maxHoldMs") or 0,
        "breakeven_pct": cfg_plan.get("breakeven_pct") or 0,
        "breakeven_triggered": d.get("breakevenTriggered", False),
    }
    decision = se.decide_management(pos_state, price, _now_ms())

    if decision["action"] == "breakeven":
        new_sl = decision["new_sl"]
        # cancela OCO antiga e recoloca com SL mais alto
        if oco_id:
            o.cancel_oco(client, symbol, oco_id)
        oco_qty = o.fmt_qty(symbol, (pos.quantity or 0) * 0.999, cfg_plan)
        oco = o.place_oco_sell(client, symbol, oco_qty, pos.take_profit_price, new_sl, new_sl * 0.99)
        pos.stop_price = new_sl
        d = dict(pos.data or {})
        d["breakevenTriggered"] = True
        if oco.get("ok"):
            d["ocoOrderListId"] = oco.get("orderListId")
        pos.data = d
        from sqlalchemy.orm.attributes import flag_modified
        flag_modified(pos, "data")
        return {"symbol": symbol, "result": "breakeven", "oco_ok": oco.get("ok")}

    if decision["action"] == "timeout_exit":
        sell = o.close_long(client, symbol, pos.quantity or 0, cfg_plan, oco_id=oco_id)
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
                client = get_binance_client(db, cfg.user_id)
            except Exception as e:  # sem credencial valida -> pula usuario
                results.append({"user": cfg.user_id, "error": f"client: {e}"})
                continue

            plans = data.get("plans") or {}

            # 1) gerencia posicoes abertas primeiro (libera saldo)
            open_by_symbol = {}
            for pos in _open_positions(db, cfg.user_id):
                open_by_symbol[pos.symbol] = pos
                try:
                    results.append({"user": cfg.user_id, **_manage_position(db, client, pos, plans.get(pos.symbol) or {})})
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
                    candles = _fetch_candles(client, symbol)
                    sig = scalper.decide_signal_for_symbol(plan, candles)
                    if sig["action"] != "buy":
                        continue
                    trade_usdt = float(data.get("max_trade_usdt", 20))
                    buy = o.open_long(client, symbol, trade_usdt, plan)
                    if not buy["ok"]:
                        results.append({"user": cfg.user_id, "symbol": symbol, "error": f"buy: {buy.get('error')}"})
                        continue
                    entry = buy["avgPrice"]
                    qty = buy["qty"]
                    tp_pct = plan.get("tp_pct", 0.015)
                    sl_pct = plan.get("sl_pct", 0.01)
                    levels = se.compute_tp_sl(entry, tp_pct, sl_pct, "buy")
                    now = datetime.now(timezone.utc)
                    pos_id = f"POS-SCALPER-{int(now.timestamp() * 1000)}"

                    oco_qty = o.fmt_qty(symbol, qty * 0.999, plan)
                    oco = o.place_oco_sell(client, symbol, oco_qty, levels["tp"], levels["sl"], levels["sl"] * 0.99)

                    db.add(Position(
                        id=pos_id, user_id=cfg.user_id, symbol=symbol, side="LONG",
                        status="open", strategy=plan.get("strategy_mode", "micro-dip"),
                        plan="Micro-Scalper", timeframe="5m", quantity=qty,
                        entry_price=entry, stop_price=levels["sl"], take_profit_price=levels["tp"],
                        opened_at=now,
                        data={"orderId": str(buy["raw"].get("orderId", pos_id)),
                              "ocoOrderListId": oco.get("orderListId") if oco.get("ok") else None,
                              "openedAt": now.isoformat(), "side": "LONG",
                              "entryPrice": entry, "stopPrice": levels["sl"],
                              "takeProfitPrice": levels["tp"], "strategy": plan.get("strategy_mode", "micro-dip"),
                              "signal": sig.get("signal"), "breakevenTriggered": False},
                        account_id="default",
                    ))
                    db.add(Notification(
                        user_id=cfg.user_id,
                        title=f"Abriu LONG {symbol}",
                        message=f"Preço de Entrada: ${entry:.4f} | Quantidade: {qty:.4f}",
                        type="info",
                    ))
                    db.commit()
                    results.append({"user": cfg.user_id, "symbol": symbol, "result": "opened",
                                    "entry": entry, "qty": qty, "oco_ok": oco.get("ok")})
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
