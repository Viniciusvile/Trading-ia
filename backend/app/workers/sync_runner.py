"""Task Celery: sync incremental de positions legado -> tradingdb.

Enquanto os 2 sistemas coexistem (legado opera real, Python paper), o bot legado
abre/fecha posicoes que o frontend novo (le do Python) so veria via sync manual.
Esta task roda no beat (~60s) e mantem a tabela positions do Python refletindo o
legado quase em tempo real (UPSERT: insere novas, atualiza status/pnl/exit).

DESLIGAR esta task na Fase 6 (quando o legado parar e o Python assumir execucao).
"""
import os
import json
import uuid

import psycopg2
from psycopg2.extras import RealDictCursor, Json
from celery import shared_task

SRC = "postgresql://masterbot:masterbot123@localhost:5432/masterbot"


def _num(v):
    if v is None:
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


@shared_task(name="sync_positions")
def sync_positions():
    dst_url = os.environ.get("DATABASE_URL", "postgresql://tradinguser:TradingPass2026!@localhost:5432/tradingdb")
    try:
        src = psycopg2.connect(SRC)
        dst = psycopg2.connect(dst_url)
    except Exception as e:  # noqa: BLE001 — legado pode estar fora; nao derruba o worker
        return {"ok": False, "error": f"conexao: {e}"}

    sc = src.cursor(cursor_factory=RealDictCursor)
    dc = dst.cursor()
    try:
        sc.execute("SELECT id, user_id FROM accounts")
        acct_to_user = {r["id"]: str(r["user_id"]) for r in sc.fetchall()}

        sc.execute("SELECT id, symbol, status, data, account_id FROM positions")
        rows = sc.fetchall()

        inserted = updated = 0
        for r in rows:
            d = r["data"] or {}
            if isinstance(d, str):
                d = json.loads(d)
            account_id = r["account_id"] or "default"
            user_id = acct_to_user.get(account_id)
            if not user_id:
                continue

            dc.execute("SELECT status FROM positions WHERE id = %s", (r["id"],))
            existing = dc.fetchone()

            dc.execute(
                """
                INSERT INTO positions (
                    id, user_id, symbol, side, status, strategy, plan, timeframe,
                    quantity, entry_price, exit_price, stop_price, take_profit_price, pnl,
                    opened_at, closed_at, data, account_id
                ) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                ON CONFLICT (id) DO UPDATE SET
                    status = EXCLUDED.status,
                    exit_price = EXCLUDED.exit_price,
                    pnl = EXCLUDED.pnl,
                    closed_at = EXCLUDED.closed_at,
                    data = EXCLUDED.data
                """,
                (
                    r["id"], user_id,
                    r["symbol"] or d.get("symbol"),
                    d.get("side"),
                    r["status"] or d.get("status") or "closed",
                    d.get("strategy"), d.get("plan"), d.get("timeframe"),
                    _num(d.get("quantity")), _num(d.get("entryPrice")), _num(d.get("exitPrice")),
                    _num(d.get("stopPrice")), _num(d.get("takeProfitPrice")), _num(d.get("pnl")),
                    d.get("openedAt"), d.get("closedAt"), Json(d), account_id,
                ),
            )
            
            new_status = r["status"] or d.get("status") or "closed"
            if existing is None:
                inserted += 1
                if new_status == "open":
                    side = d.get("side") or "LONG"
                    sym = r["symbol"] or d.get("symbol") or ""
                    entry_price = _num(d.get("entryPrice")) or 0.0
                    dc.execute(
                        """
                        INSERT INTO notifications (id, user_id, title, message, type, is_read, created_at)
                        VALUES (%s, %s, %s, %s, 'info', false, NOW())
                        """,
                        (
                            str(uuid.uuid4()),
                            user_id,
                            f"Abriu {side} {sym}",
                            f"Preço de Entrada: ${entry_price:.4f} | Quantidade: {_num(d.get('quantity')) or 0.0}",
                        )
                    )
            elif existing[0] == "open" and new_status == "closed":
                updated += 1
                sym = r["symbol"] or d.get("symbol") or ""
                pnl_val = _num(d.get("pnl")) or 0.0
                exit_price = _num(d.get("exitPrice")) or 0.0
                reason = d.get("exitReason") or "Binance OCO"
                notif_type = "success" if pnl_val >= 0 else "error"
                dc.execute(
                    """
                    INSERT INTO notifications (id, user_id, title, message, type, is_read, created_at)
                    VALUES (%s, %s, %s, %s, %s, false, NOW())
                    """,
                    (
                        str(uuid.uuid4()),
                        user_id,
                        f"Fechou {sym}",
                        f"PnL: {'+' if pnl_val >= 0 else ''}${pnl_val:.4f} | Saída: ${exit_price:.4f} ({reason})",
                        notif_type,
                    )
                )
            elif existing[0] != new_status:
                updated += 1

        dst.commit()
        return {"ok": True, "inserted": inserted, "updated": updated, "total_src": len(rows)}
    except Exception as e:  # noqa: BLE001
        dst.rollback()
        return {"ok": False, "error": str(e)}
    finally:
        src.close()
        dst.close()
