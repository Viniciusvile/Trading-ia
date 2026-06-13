"""Migra user_bot_state do legado (masterbot) para o destino (tradingdb).

Idempotente. So migra estado de usuarios que existem no destino.
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
    sc.execute("SELECT user_id, data, updated_at FROM user_bot_state")
    n = skipped = 0
    for (uid, data, updated) in sc.fetchall():
        dc.execute("SELECT 1 FROM users WHERE id = %s", (str(uid),))
        if not dc.fetchone():
            skipped += 1
            continue
        dc.execute(
            """INSERT INTO user_bot_state (user_id, data, updated_at)
               VALUES (%s, %s, %s) ON CONFLICT (user_id) DO NOTHING""",
            (str(uid), Json(data), updated),
        )
        n += 1
    dst.commit()
    print(f"user_bot_state migrados: {n} | pulados (sem user): {skipped}")
    src.close()
    dst.close()


if __name__ == "__main__":
    main()
