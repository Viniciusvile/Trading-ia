"""Migra users do banco legado (masterbot) para o destino (tradingdb).

bcrypt e interoperavel (ambos $2b$), o hash e copiado direto.
Mapeamento: id (uuid -> str), password_hash -> hashed_password, name descartado.
Defaults no destino: is_active=true, is_verified=false, plan=free, max_bots=3.

Reconciliacao de conflito por email (UNIQUE):
  Se um email do legado ja existe no destino com OUTRO id, o id do LEGADO vence
  (trades/estrategias/posicoes do legado referenciam o id do legado). Re-aponta
  os dados ja existentes no destino daquele usuario para o id do legado, depois
  troca o id. Idempotente: ON CONFLICT (id) DO NOTHING para quem nao colide.
"""
import os
import psycopg2

SRC = os.environ.get("SRC_DB", "postgresql://masterbot:masterbot123@localhost:5432/masterbot")
DST = os.environ["DATABASE_URL"]

# Tabelas no destino que referenciam users.id e precisam ser re-apontadas em colisao.
CHILD_TABLES = ["strategies", "binance_configs", "trade_logs"]


def main():
    src = psycopg2.connect(SRC)
    dst = psycopg2.connect(DST)
    sc, dc = src.cursor(), dst.cursor()
    sc.execute("SELECT id, email, password_hash, created_at FROM users")
    rows = sc.fetchall()

    inserted = reconciled = skipped = 0
    for (uid, email, pwd, created) in rows:
        uid = str(uid)
        dc.execute("SELECT id FROM users WHERE email = %s", (email,))
        existing = dc.fetchone()

        if existing and existing[0] != uid:
            # Colisao de email com id diferente: id do legado vence.
            # Ordem segura p/ nao violar FK:
            #  1) liberar o email do usuario de teste (placeholder temporario)
            #  2) inserir o usuario do legado (ja com o email real)
            #  3) re-apontar filhos do id antigo -> id do legado (agora existe)
            #  4) remover o usuario de teste
            old_id = existing[0]
            dc.execute("UPDATE users SET email = %s WHERE id = %s",
                       (f"__migrated__{old_id}@local", old_id))
            dc.execute(
                """INSERT INTO users
                     (id, email, hashed_password, is_active, is_verified, plan, max_bots, created_at)
                   VALUES (%s, %s, %s, true, false, %s, 3, %s)""",
                (uid, email, pwd, "free", created),
            )
            for tbl in CHILD_TABLES:
                dc.execute(f"UPDATE {tbl} SET user_id = %s WHERE user_id = %s", (uid, old_id))
            dc.execute("DELETE FROM users WHERE id = %s", (old_id,))
            reconciled += 1
        elif existing:
            skipped += 1  # mesmo id, ja migrado
        else:
            dc.execute(
                """INSERT INTO users
                     (id, email, hashed_password, is_active, is_verified, plan, max_bots, created_at)
                   VALUES (%s, %s, %s, true, false, %s, 3, %s)
                   ON CONFLICT (id) DO NOTHING""",
                (uid, email, pwd, "free", created),
            )
            inserted += 1

    dst.commit()
    dc.execute("SELECT count(*) FROM users")
    total = dc.fetchone()[0]
    print(f"Origem: {len(rows)} | inseridos: {inserted} | reconciliados: {reconciled} | "
          f"ja existiam: {skipped} | Destino agora: {total}")
    src.close()
    dst.close()


if __name__ == "__main__":
    main()
