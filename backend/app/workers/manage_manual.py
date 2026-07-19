"""Watchdog de posições manuais com TP1 parcial e/ou trailing stop.

Roda a cada 60s via Celery beat. Age somente em posições manuais abertas
que tenham tp1Pct ou trailingPct no campo data (modo avançado).
"""
from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy.orm.attributes import flag_modified

from app.workers.celery_app import celery
from app.database import _get_session_factory
from app.models.position import Position
from app.services.exchange_client import get_adapter
from app.services.notify import notify


@celery.task(name="manage_manual_positions")
def manage_manual_positions():
    db = _get_session_factory()()
    try:
        positions = (
            db.query(Position)
            .filter(Position.status == "open", Position.strategy == "manual")
            .all()
        )
        for pos in positions:
            try:
                _handle(db, pos)
            except Exception:
                pass
    finally:
        db.close()


def _handle(db, pos: Position) -> None:
    data = dict(pos.data or {})
    tp1_pct = data.get("tp1Pct")
    trailing_pct = data.get("trailingPct")

    if not tp1_pct and not trailing_pct:
        return

    try:
        ex = get_adapter(db, pos.user_id)
        price = ex.price(pos.symbol)
    except Exception:
        return

    entry = pos.entry_price or 0
    qty = pos.quantity or 0
    if qty <= 0:
        return

    # Update peak price (trailing reference)
    peak = max(float(data.get("peakPrice") or entry), price)
    if peak > float(data.get("peakPrice") or entry):
        data["peakPrice"] = peak
        pos.data = data
        flag_modified(pos, "data")
        db.commit()

    # ─── TP1 partial sell ───────────────────────────────────────────────────
    if tp1_pct and not data.get("tp1Triggered"):
        tp1_price = entry * (1 + float(tp1_pct))
        if price >= tp1_price:
            sell_qty = qty * float(data.get("tp1SizePct") or 0.5)
            result = ex.market_sell(pos.symbol, sell_qty)
            if result.get("ok"):
                exit_price = result.get("exitPrice") or price
                pnl_partial = (exit_price - entry) * sell_qty
                qty = qty - sell_qty
                data["tp1Triggered"] = True
                data["stopPrice"] = entry  # break-even
                pos.quantity = qty
                pos.stop_price = entry
                pos.data = data
                flag_modified(pos, "data")
                notify(
                    db, pos.user_id,
                    f"TP1 atingido {pos.symbol}",
                    f"Parcial @ ${exit_price:.4f} (+{float(tp1_pct)*100:.1f}%) "
                    f"| PnL: ${pnl_partial:+.2f} | Stop → break-even",
                    "success",
                )
                db.commit()

    if qty <= 0:
        return

    # ─── Trailing stop + SL check ───────────────────────────────────────────
    sl_price = float(pos.stop_price or 0)
    trail_stop = peak * (1 - float(trailing_pct)) if trailing_pct else None

    breached_trail = trail_stop is not None and price <= trail_stop
    breached_sl = sl_price > 0 and price <= sl_price

    if breached_trail or breached_sl:
        result = ex.market_sell(pos.symbol, qty)
        if result.get("ok"):
            exit_price = result.get("exitPrice") or price
            pnl = (exit_price - entry) * qty
            # Accumulate PnL if tp1 already realised some profit
            total_pnl = (pos.pnl or 0.0) + pnl
            pos.status = "closed"
            pos.exit_price = exit_price
            pos.closed_at = datetime.now(timezone.utc)
            pos.pnl = total_pnl
            exit_reason = "trailing_stop" if breached_trail else "stop_loss"
            data.update({"status": "closed", "exitPrice": exit_price,
                          "exitReason": exit_reason,
                          "closedAt": pos.closed_at.isoformat()})
            pos.data = data
            flag_modified(pos, "data")
            notif_type = "info" if total_pnl >= 0 else "warning"
            reason_pt = "Trailing stop" if breached_trail else "Stop loss"
            notify(
                db, pos.user_id,
                f"{reason_pt} {pos.symbol}",
                f"Saída @ ${exit_price:.4f} | PnL total: ${total_pnl:+.2f}",
                notif_type,
            )
            db.commit()
