"""Trading MANUAL — ordens reais enviadas pela página Mercado.

Substitui o antigo /bot/force-trade (que era um stub paper e nunca tocava a
exchange). Aqui a ordem é REAL, na conta ATIVA do usuário — Binance (respeita
testnet) OU Coinbase, via adapter unificado (exchange_client).

Decisões:
  - Símbolos internos no formato Binance ("BTCUSDT"); o adapter converte p/ a
    Coinbase ("BTC/USDC"). quoteAsset informa à UI o que exibir (USDT/USDC).
  - Toda compra vira uma Position com plan="Manual" -> aparece no Diário e em
    Posições automaticamente, com PnL calculado no fechamento.
  - TP/SL (OCO) só quando o adapter suporta (Binance). A UI esconde na Coinbase.
  - O regime de mercado usa dados PÚBLICOS da Binance (fonte de preço), valendo
    para qualquer exchange — não bloqueia ordem manual, só avisa.
"""
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.database import get_db
from app.deps import get_current_user
from app.models.user import User
from app.models.position import Position
from app.models.notification import Notification
from app.services import market_regime
from app.services.exchange_client import get_adapter
from app.services.scalper_executor import compute_tp_sl

router = APIRouter()

TRACKED_SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT"]

# cliente PÚBLICO da Binance p/ dados de regime (klines 4H) — sem credencial
_public_client = None


def _regime_client():
    global _public_client
    if _public_client is None:
        from binance.client import Client
        _public_client = Client()
    return _public_client


class OrderRequest(BaseModel):
    symbol: str
    side: str  # "buy" | "sell"
    amount_usdt: float | None = None  # compra: valor na moeda-quote
    quantity: float | None = None     # venda avulsa: qtde do ativo (default: tudo)
    tp_pct: float | None = None       # ex.: 0.02 = +2%
    sl_pct: float | None = None       # ex.: 0.01 = -1%


def _base_asset(symbol: str) -> str:
    return symbol.upper().replace("USDT", "")


def _adapter_or_400(db: Session, user_id: str):
    try:
        return get_adapter(db, user_id)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Conta da corretora não configurada: {e}")


@router.get("/context")
def trade_context(symbol: str = "BTCUSDT", db: Session = Depends(get_db),
                  user: User = Depends(get_current_user)):
    """Contexto p/ o painel de ordem: saldos, preço, regime e posições do símbolo."""
    ex = _adapter_or_400(db, user.id)
    symbol = symbol.upper()
    base = _base_asset(symbol)
    try:
        quote_free = ex.free(ex.quote_asset)
        base_free = ex.free(base)
        price = ex.price(symbol)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Erro ao consultar a corretora: {e}")

    regime = market_regime.entry_allowed(_regime_client(), symbol, "LONG")

    open_positions = (
        db.query(Position)
        .filter(Position.user_id == user.id, Position.status == "open",
                Position.symbol == symbol)
        .all()
    )

    return {
        "success": True,
        "symbol": symbol,
        "price": price,
        "exchange": ex.exchange,
        "quoteAsset": ex.quote_asset,
        "supportsTpSl": ex.supports_oco,
        "usdtFree": quote_free,  # nome mantido p/ compat.; é o saldo da moeda-quote
        "baseAsset": base,
        "baseFree": base_free,
        "baseFreeUsdt": base_free * price,
        "regime": {
            "allowed": regime["allowed"],
            "reason": regime["reason"],
            "symbolRegime": regime.get("symbol_regime"),
            "macroRegime": regime.get("macro_regime"),
        },
        "openPositions": [
            {
                "id": p.id,
                "plan": p.plan,
                "side": p.side,
                "quantity": p.quantity,
                "entryPrice": p.entry_price,
                "stopPrice": p.stop_price,
                "takeProfitPrice": p.take_profit_price,
                "openedAt": p.opened_at.isoformat() if p.opened_at else None,
                "unrealizedPnl": ((price - (p.entry_price or price)) * (p.quantity or 0))
                if p.side == "LONG" else 0.0,
            }
            for p in open_positions
        ],
    }


@router.post("/order")
def place_order(body: OrderRequest, db: Session = Depends(get_db),
                user: User = Depends(get_current_user)):
    symbol = body.symbol.upper()
    side = (body.side or "").lower()
    if symbol not in TRACKED_SYMBOLS:
        raise HTTPException(status_code=400, detail=f"Símbolo não suportado: {symbol}")
    if side not in ("buy", "sell"):
        raise HTTPException(status_code=400, detail="side deve ser 'buy' ou 'sell'")

    ex = _adapter_or_400(db, user.id)

    if side == "buy":
        amount = float(body.amount_usdt or 0)
        if amount < 5:
            raise HTTPException(status_code=400, detail=f"Valor mínimo de compra: 5 {ex.quote_asset}")
        if body.tp_pct and body.sl_pct and not ex.supports_oco:
            raise HTTPException(status_code=400,
                                detail="TP/SL automático não é suportado nesta exchange")

        buy = ex.market_buy_quote(symbol, amount)
        if not buy.get("ok"):
            raise HTTPException(status_code=400, detail=f"Compra rejeitada pela corretora: {buy.get('error')}")

        entry = buy["avgPrice"]
        qty = buy["qty"]
        now = datetime.now(timezone.utc)
        pos_id = f"POS-MANUAL-{int(now.timestamp() * 1000)}"

        tp_price = None
        sl_price = None
        oco = None
        if body.tp_pct and body.sl_pct and ex.supports_oco:
            levels = compute_tp_sl(entry, body.tp_pct, body.sl_pct, "buy")
            tp_price, sl_price = levels["tp"], levels["sl"]
            oco = ex.place_oco_sell(symbol, qty, tp_price, sl_price)

        raw = buy.get("raw") or {}
        order_id = raw.get("orderId") or raw.get("id") or pos_id
        db.add(Position(
            id=pos_id, user_id=user.id, symbol=symbol, side="LONG",
            status="open", strategy="manual", plan="Manual", timeframe="manual",
            quantity=qty, entry_price=entry,
            stop_price=sl_price, take_profit_price=tp_price, opened_at=now,
            data={"orderId": str(order_id),
                  "ocoOrderListId": oco.get("orderListId") if oco and oco.get("ok") else None,
                  "openedAt": now.isoformat(), "side": "LONG",
                  "entryPrice": entry, "stopPrice": sl_price,
                  "takeProfitPrice": tp_price, "strategy": "manual",
                  "exchange": ex.exchange, "signal": "ordem manual"},
            account_id="default",
        ))
        db.add(Notification(
            user_id=user.id, title=f"Compra manual {symbol} ({ex.exchange})",
            message=f"Entrada: ${entry:.4f} | Qtd: {qty:.6f}" + (
                f" | TP {body.tp_pct*100:.1f}% / SL {body.sl_pct*100:.1f}%" if tp_price else ""),
            type="info",
        ))
        db.commit()
        return {
            "success": True, "positionId": pos_id, "entryPrice": entry,
            "quantity": qty, "tpPrice": tp_price, "slPrice": sl_price,
            "ocoOk": bool(oco and oco.get("ok")) if oco else None,
            "ocoError": (oco or {}).get("error"),
        }

    # ─── sell: venda avulsa do saldo do ativo ───
    base = _base_asset(symbol)
    try:
        free = ex.free(base)
        price = ex.price(symbol)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Erro ao consultar a corretora: {e}")

    qty = float(body.quantity) if body.quantity else free
    qty = min(qty, free)
    if qty <= 0 or qty * price < 5:
        raise HTTPException(status_code=400,
                            detail=f"Saldo de {base} insuficiente para vender (mín. 5 {ex.quote_asset})")

    sell = ex.market_sell(symbol, qty)
    if not sell.get("ok"):
        raise HTTPException(status_code=400, detail=f"Venda rejeitada pela corretora: {sell.get('error')}")

    filled = sell.get("qty") or 0
    exit_price = sell.get("exitPrice") or price
    total_quote = sell.get("totalQuote") or filled * exit_price

    db.add(Notification(
        user_id=user.id, title=f"Venda manual {symbol} ({ex.exchange})",
        message=f"Vendeu {filled:.6f} {base} a ${exit_price:.4f} (${total_quote:.2f})",
        type="info",
    ))
    db.commit()
    return {"success": True, "quantity": filled, "exitPrice": exit_price, "totalUsdt": total_quote}


@router.post("/close/{position_id}")
def close_position(position_id: str, db: Session = Depends(get_db),
                   user: User = Depends(get_current_user)):
    """Fecha a mercado uma posição ABERTA (manual ou de bot) do usuário."""
    pos = (
        db.query(Position)
        .filter(Position.id == position_id, Position.user_id == user.id,
                Position.status == "open")
        .first()
    )
    if not pos:
        raise HTTPException(status_code=404, detail="Posição aberta não encontrada")
    if pos.side != "LONG":
        raise HTTPException(status_code=400, detail="Apenas posições LONG spot podem ser fechadas aqui")

    ex = _adapter_or_400(db, user.id)
    d = pos.data or {}

    # Binance: cancela a OCO antes de vender (senão o saldo está travado).
    oco_id = d.get("ocoOrderListId")
    if oco_id and ex.exchange == "binance":
        from app.services import order_real as o
        o.cancel_oco(ex.client, pos.symbol, oco_id)

    # vende o MIN(qtde da posição, saldo livre) — não falha por poeira/lock
    try:
        free = ex.free(_base_asset(pos.symbol))
    except Exception:
        free = pos.quantity or 0
    sell = ex.market_sell(pos.symbol, min(pos.quantity or 0, free))
    if not sell.get("ok"):
        raise HTTPException(status_code=400, detail=f"Falha ao fechar: {sell.get('error')}")

    exit_price = sell.get("exitPrice") or 0
    now = datetime.now(timezone.utc)
    pos.status = "closed"
    pos.exit_price = exit_price
    pos.closed_at = now
    pnl_val = 0.0
    if pos.entry_price and exit_price and pos.quantity:
        pnl_val = (exit_price - pos.entry_price) * pos.quantity
        pos.pnl = pnl_val
    nd = dict(d)
    nd.update({"status": "closed", "closedAt": now.isoformat(),
               "exitPrice": exit_price, "exitReason": "manual_close"})
    pos.data = nd
    from sqlalchemy.orm.attributes import flag_modified
    flag_modified(pos, "data")

    db.add(Notification(
        user_id=user.id, title=f"Fechou {pos.symbol} (manual)",
        message=f"PnL: {'+' if pnl_val >= 0 else ''}${pnl_val:.4f} | Saída: ${exit_price:.4f}",
        type="success" if pnl_val >= 0 else "error",
    ))
    db.commit()
    return {"success": True, "exitPrice": exit_price, "pnl": pnl_val}
