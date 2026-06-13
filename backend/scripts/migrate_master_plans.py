"""Migra group_plans + watchlist/active_plans do rules.json legado para o tradingdb.

Os planos no rules.json sao GLOBAIS no legado (pertencem ao dono). Migramos para
o usuario dono (OWNER_ID). Idempotente (ON CONFLICT).

Uso: rodar de backend/ com RULES_JSON apontando para o rules.json do legado:
  RULES_JSON=/home/ubuntu/trading/rules.json DATABASE_URL=... python scripts/migrate_master_plans.py
"""
import os
import json
import uuid
import psycopg2
from psycopg2.extras import Json

DST = os.environ["DATABASE_URL"]
RULES = os.environ.get("RULES_JSON", "/home/ubuntu/trading/rules.json")
OWNER_ID = os.environ.get("OWNER_ID", "17a63e02-c89b-4952-9768-f88371d1202a")


def main():
    with open(RULES, encoding="utf-8") as f:
        rules = json.load(f)
    plans = rules.get("group_plans") or []
    watchlist = rules.get("watchlist") or []
    active = rules.get("active_plans") or ([rules["active_plan"]] if rules.get("active_plan") else [])

    dst = psycopg2.connect(DST)
    dc = dst.cursor()
    # so migra se o dono existe
    dc.execute("SELECT 1 FROM users WHERE id = %s", (OWNER_ID,))
    if not dc.fetchone():
        raise SystemExit(f"OWNER_ID {OWNER_ID} nao existe no destino")

    n = 0
    for p in plans:
        name = p.get("name")
        if not name:
            continue
        is_active = name in active
        dc.execute(
            """INSERT INTO master_plans (id, user_id, name, data, is_active)
               VALUES (%s, %s, %s, %s, %s)
               ON CONFLICT (user_id, name) DO UPDATE SET data = EXCLUDED.data, is_active = EXCLUDED.is_active""",
            (str(uuid.uuid4()), OWNER_ID, name, Json(p), is_active),
        )
        n += 1

    dc.execute(
        """INSERT INTO master_config (user_id, data)
           VALUES (%s, %s)
           ON CONFLICT (user_id) DO UPDATE SET data = EXCLUDED.data""",
        (OWNER_ID, Json({"watchlist": watchlist, "active_plans": active})),
    )
    dst.commit()
    print(f"master_plans migrados: {n} | watchlist: {len(watchlist)} simbolos | active: {active}")
    dst.close()


if __name__ == "__main__":
    main()
