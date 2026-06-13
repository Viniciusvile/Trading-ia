"""Verificacao da migracao de positions (legado masterbot -> tradingdb).

Roda contra os bancos reais no servidor. Confere contagem e integridade de PnL.
"""
import os
import psycopg2

SRC = "postgresql://masterbot:masterbot123@localhost:5432/masterbot"
DST = os.environ.get("DATABASE_URL", "postgresql://tradinguser:TradingPass2026!@localhost:5432/tradingdb")


def _scalar(dsn, sql):
    c = psycopg2.connect(dsn)
    cur = c.cursor()
    cur.execute(sql)
    v = cur.fetchone()[0]
    c.close()
    return v


def test_positions_count_matches():
    src = _scalar(SRC, "SELECT count(*) FROM positions")
    dst = _scalar(DST, "SELECT count(*) FROM positions")
    assert dst == src, f"destino {dst} != origem {src}"


def test_positions_pnl_matches():
    # PnL do legado vem de data->>'pnl'; no destino e a coluna tipada.
    src = _scalar(SRC, "SELECT round(coalesce(sum((data->>'pnl')::numeric),0), 6) FROM positions")
    dst = _scalar(DST, "SELECT round(coalesce(sum(pnl::numeric),0), 6) FROM positions")
    assert dst == src, f"PnL destino {dst} != origem {src}"


def test_positions_all_linked_to_user():
    # Toda posicao migrada tem user_id valido (FK).
    orphans = _scalar(
        DST,
        "SELECT count(*) FROM positions p LEFT JOIN users u ON p.user_id = u.id WHERE u.id IS NULL",
    )
    assert orphans == 0, f"{orphans} posicoes sem user_id valido"
