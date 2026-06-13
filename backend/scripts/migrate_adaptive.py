"""Migra as tabelas adaptive_* do legado (masterbot) para o destino (tradingdb).

Copia adaptive_params (versoes), adaptive_trades, adaptive_heartbeat,
adaptive_lessons, adaptive_reviews preservando ids/versions. Idempotente.
"""
import os
import psycopg2
from psycopg2.extras import Json

SRC = os.environ.get("SRC_DB", "postgresql://masterbot:masterbot123@localhost:5432/masterbot")
DST = os.environ["DATABASE_URL"]


def main():
    src = psycopg2.connect(SRC)
    dst = psycopg2.connect(DST)
    sc, dc = src.cursor(), dst.cursor()
    counts = {}

    sc.execute("SELECT version, params, is_active, source, created_at FROM adaptive_params")
    rows = sc.fetchall()
    for (version, params, is_active, source, created) in rows:
        dc.execute(
            """INSERT INTO adaptive_params (version, params, is_active, source, created_at)
               VALUES (%s, %s, %s, %s, %s) ON CONFLICT (version) DO NOTHING""",
            (version, Json(params), is_active, source, created),
        )
    counts["adaptive_params"] = len(rows)

    sc.execute("SELECT id, symbol, result, return_pct, params_version, data, opened_at, closed_at FROM adaptive_trades")
    rows = sc.fetchall()
    for r in rows:
        dc.execute(
            """INSERT INTO adaptive_trades (id, symbol, result, return_pct, params_version, data, opened_at, closed_at)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT (id) DO NOTHING""",
            (r[0], r[1], r[2], r[3], r[4], Json(r[5]) if r[5] is not None else None, r[6], r[7]),
        )
    counts["adaptive_trades"] = len(rows)

    sc.execute("SELECT id, ts, pid FROM adaptive_heartbeat")
    rows = sc.fetchall()
    for (hid, ts, pid) in rows:
        dc.execute(
            """INSERT INTO adaptive_heartbeat (id, ts, pid) VALUES (%s,%s,%s)
               ON CONFLICT (id) DO UPDATE SET ts = EXCLUDED.ts, pid = EXCLUDED.pid""",
            (hid, ts, pid),
        )
    counts["adaptive_heartbeat"] = len(rows)

    sc.execute("SELECT id, lesson, active, created_at FROM adaptive_lessons")
    rows = sc.fetchall()
    for r in rows:
        dc.execute(
            """INSERT INTO adaptive_lessons (id, lesson, active, created_at)
               VALUES (%s,%s,%s,%s) ON CONFLICT (id) DO NOTHING""", r)
    counts["adaptive_lessons"] = len(rows)

    sc.execute("SELECT id, old_version, new_version, trades_analyzed, response, applied, reason, created_at FROM adaptive_reviews")
    rows = sc.fetchall()
    for r in rows:
        dc.execute(
            """INSERT INTO adaptive_reviews (id, old_version, new_version, trades_analyzed, response, applied, reason, created_at)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT (id) DO NOTHING""",
            (r[0], r[1], r[2], r[3], Json(r[4]) if r[4] is not None else None, r[5], r[6], r[7]),
        )
    counts["adaptive_reviews"] = len(rows)

    dst.commit()
    print("migrado:", counts)
    src.close()
    dst.close()


if __name__ == "__main__":
    main()
