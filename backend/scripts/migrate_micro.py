"""Migra as tabelas do Micro-Scalper do legado (masterbot) para o destino (tradingdb).

user_micro_config (por user, jsonb), micro_sessions (jsonb trades), micro_heartbeat.
Idempotente. user_micro_config so migra se o user existe no destino.
"""
import os
import json
import psycopg2
from psycopg2.extras import Json

SRC = os.environ.get("SRC_DB", "postgresql://masterbot:masterbot123@localhost:5432/masterbot")
DST = os.environ["DATABASE_URL"]


def main():
    src = psycopg2.connect(SRC)
    dst = psycopg2.connect(DST)
    sc, dc = src.cursor(), dst.cursor()

    # user_micro_config
    sc.execute("SELECT user_id, data, updated_at FROM user_micro_config")
    cfg = 0
    for (uid, data, updated) in sc.fetchall():
        dc.execute("SELECT 1 FROM users WHERE id = %s", (str(uid),))
        if not dc.fetchone():
            continue
        dc.execute(
            """INSERT INTO user_micro_config (user_id, data, updated_at)
               VALUES (%s, %s, %s) ON CONFLICT (user_id) DO NOTHING""",
            (str(uid), Json(data), updated),
        )
        cfg += 1

    # micro_sessions
    sc.execute("SELECT session_start, symbol, trades, account_id FROM micro_sessions")
    sess = 0
    for (start, symbol, trades, account_id) in sc.fetchall():
        dc.execute(
            """INSERT INTO micro_sessions (session_start, symbol, trades, account_id)
               VALUES (%s, %s, %s, %s)
               ON CONFLICT (session_start, symbol, account_id) DO NOTHING""",
            (start, symbol, Json(trades), account_id),
        )
        sess += 1

    # micro_heartbeat (singleton id=1)
    sc.execute("SELECT id, ts, pid FROM micro_heartbeat")
    hb = 0
    for (hid, ts, pid) in sc.fetchall():
        dc.execute(
            """INSERT INTO micro_heartbeat (id, ts, pid) VALUES (%s, %s, %s)
               ON CONFLICT (id) DO UPDATE SET ts = EXCLUDED.ts, pid = EXCLUDED.pid""",
            (hid, ts, pid),
        )
        hb += 1

    dst.commit()
    print(f"user_micro_config: {cfg} | micro_sessions: {sess} | micro_heartbeat: {hb}")
    src.close()
    dst.close()


if __name__ == "__main__":
    main()
