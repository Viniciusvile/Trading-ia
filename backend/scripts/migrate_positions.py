"""Migra positions do legado (masterbot) para o tradingdb.

O legado guarda cada posicao em `positions.data` (JSONB) + colunas id/symbol/status/account_id.
O destino tem colunas tipadas (entry/exit/pnl/...) + `data` preservando o JSONB original.

Mapeamento de dono: legado `accounts.id` (== positions.account_id) -> `accounts.user_id`.
Idempotente: ON CONFLICT (id) DO NOTHING.
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


def _ts(v):
    # ISO string ("2026-06-13T05:47:31.194Z") -> deixa o Postgres converter.
    return v if v else None


def main():
    src = psycopg2.connect(SRC)
    dst = psycopg2.connect(DST)
    sc = src.cursor(cursor_factory=RealDictCursor)
    dc = dst.cursor()

    # Mapa account_id -> user_id
    sc.execute("SELECT id, user_id FROM accounts")
    acct_to_user = {r["id"]: str(r["user_id"]) for r in sc.fetchall()}

    sc.execute("SELECT id, symbol, status, data, account_id FROM positions")
    rows = sc.fetchall()

    migrated = 0
    skipped = []
    for r in rows:
        d = r["data"] or {}
        if isinstance(d, str):
            d = json.loads(d)

        account_id = r["account_id"] or "default"
        user_id = acct_to_user.get(account_id)
        if not user_id:
            skipped.append((r["id"], account_id))
            continue

        dc.execute(
            """
            INSERT INTO positions (
                id, user_id, symbol, side, status, strategy, plan, timeframe,
                quantity, entry_price, exit_price, stop_price, take_profit_price, pnl,
                opened_at, closed_at, data, account_id
            ) VALUES (
                %s,%s,%s,%s,%s,%s,%s,%s,
                %s,%s,%s,%s,%s,%s,
                %s,%s,%s,%s
            ) ON CONFLICT (id) DO NOTHING
            """,
            (
                r["id"],
                user_id,
                r["symbol"] or d.get("symbol"),
                d.get("side"),
                r["status"] or d.get("status") or "closed",
                d.get("strategy"),
                d.get("plan"),
                d.get("timeframe"),
                _num(d.get("quantity")),
                _num(d.get("entryPrice")),
                _num(d.get("exitPrice")),
                _num(d.get("stopPrice")),
                _num(d.get("takeProfitPrice")),
                _num(d.get("pnl")),
                _ts(d.get("openedAt")),
                _ts(d.get("closedAt")),
                Json(d),
                account_id,
            ),
        )
        migrated += dc.rowcount

    dst.commit()
    dc.execute("SELECT count(*) FROM positions")
    total = dc.fetchone()[0]
    print(f"Origem: {len(rows)} posicoes. Inseridas agora: {migrated}. Destino total: {total}.")
    if skipped:
        print(f"PULADAS (account_id sem user): {skipped}")
    src.close()
    dst.close()


if __name__ == "__main__":
    main()
