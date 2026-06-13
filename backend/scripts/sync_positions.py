"""Sync incremental de positions: legado (masterbot) -> tradingdb.

Enquanto os DOIS sistemas coexistem (legado ainda opera, Python em paper), o bot
legado continua abrindo/fechando posicoes que o frontend novo (que le do Python)
nao enxerga. Este sync copia o estado atual: insere posicoes novas e ATUALIZA as
que mudaram (ex.: aberta -> fechada, pnl/exit atualizados).

Difere de migrate_positions.py (que e ON CONFLICT DO NOTHING, snapshot da migracao
inicial): aqui e UPSERT, pode rodar quantas vezes quiser. Some quando a Fase 6
parar os bots legado.

Uso: DATABASE_URL=... python scripts/sync_positions.py
"""
import os
import json
import psycopg2
from psycopg2.extras import RealDictCursor, Json

SRC = "postgresql://masterbot:masterbot123@localhost:5432/masterbot"
DST = os.environ.get("DATABASE_URL", "postgresql://tradinguser:TradingPass2026!@localhost:5432/tradingdb")


def _num(v):
    if v is None:
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def main():
    src = psycopg2.connect(SRC)
    dst = psycopg2.connect(DST)
    sc = src.cursor(cursor_factory=RealDictCursor)
    dc = dst.cursor()

    sc.execute("SELECT id, user_id FROM accounts")
    acct_to_user = {r["id"]: str(r["user_id"]) for r in sc.fetchall()}

    sc.execute("SELECT id, symbol, status, data, account_id FROM positions")
    rows = sc.fetchall()

    inserted = updated = skipped = 0
    for r in rows:
        d = r["data"] or {}
        if isinstance(d, str):
            d = json.loads(d)
        account_id = r["account_id"] or "default"
        user_id = acct_to_user.get(account_id)
        if not user_id:
            skipped += 1
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
        if existing is None:
            inserted += 1
        elif existing[0] != (r["status"] or d.get("status")):
            updated += 1

    dst.commit()
    dc.execute("SELECT count(*) FROM positions")
    total = dc.fetchone()[0]
    dc.execute("SELECT count(*) FROM positions WHERE status != 'closed'")
    abertas = dc.fetchone()[0]
    print(f"Sync: {inserted} inseridas, {updated} atualizadas (mudanca de status), {skipped} puladas.")
    print(f"Destino agora: {total} posicoes ({abertas} abertas).")
    src.close()
    dst.close()


if __name__ == "__main__":
    main()
