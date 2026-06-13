"""Migra accounts (legado masterbot) -> binance_configs (tradingdb).

As chaves no legado estao em TEXTO PURO; o destino exige cifradas (AES-GCM).
Reusa app.services.crypto.encrypt para garantir compatibilidade com o backend
(que vai decifrar com a mesma ENCRYPTION_KEY). Rodar a partir de backend/ com o
venv para que app.config.settings carregue o .env.

Idempotente: ON CONFLICT (id) DO NOTHING.
Mapeamento: name->label, api_key->encrypted_api_key, secret_key->encrypted_secret_key.
"""
import os
import sys
import psycopg2

# garante import de app.* ao rodar de backend/
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from app.services.crypto import encrypt  # noqa: E402

SRC = os.environ.get("SRC_DB", "postgresql://masterbot:masterbot123@localhost:5432/masterbot")
DST = os.environ["DATABASE_URL"]


def main():
    src = psycopg2.connect(SRC)
    dst = psycopg2.connect(DST)
    sc, dc = src.cursor(), dst.cursor()
    sc.execute(
        "SELECT id, user_id, name, api_key, secret_key, is_active, is_testnet, created_at "
        "FROM accounts"
    )
    rows = sc.fetchall()
    migrated = orphan = 0
    for (aid, uid, name, api_key, secret, is_active, is_testnet, created) in rows:
        if uid is None:
            orphan += 1
            continue  # conta sem dono nao migra (FK NOT NULL no destino)
        # so migra se o usuario existe no destino
        dc.execute("SELECT 1 FROM users WHERE id = %s", (str(uid),))
        if not dc.fetchone():
            orphan += 1
            continue
        dc.execute(
            """INSERT INTO binance_configs
                 (id, user_id, label, encrypted_api_key, encrypted_secret_key,
                  is_testnet, is_active, is_valid, created_at, updated_at)
               VALUES (%s, %s, %s, %s, %s, %s, %s, false, %s, %s)
               ON CONFLICT (id) DO NOTHING""",
            (str(aid), str(uid), name, encrypt(api_key), encrypt(secret),
             bool(is_testnet), bool(is_active), created, created),
        )
        migrated += 1
    dst.commit()
    dc.execute("SELECT count(*) FROM binance_configs")
    print(f"Origem: {len(rows)} contas | migradas: {migrated} | orfas(sem user): {orphan} | "
          f"Destino agora: {dc.fetchone()[0]}")
    src.close()
    dst.close()


if __name__ == "__main__":
    main()
