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


def test_positions_destino_e_subconjunto_fiel_da_origem():
    # O legado SEGUE operando (cria posicoes novas) ate a virada real dos bots
    # (Fase 6), entao origem >= destino. O que importa: o destino nao perdeu
    # nenhuma posicao migrada e nenhuma extra alem das que existem na origem.
    src = _scalar(SRC, "SELECT count(*) FROM positions")
    dst = _scalar(DST, "SELECT count(*) FROM positions")
    assert dst <= src, f"destino {dst} > origem {src} (destino tem posicao que nao existe no legado)"
    assert dst >= 22, f"destino {dst} < 22 (perdeu posicoes migradas)"


def test_positions_pnl_matches():
    # Compara o PnL APENAS das posicoes que estao no destino (subconjunto migrado),
    # buscando o mesmo conjunto de ids na origem. O legado pode ter posicoes novas
    # (Fase 6 ainda nao virou), entao a comparacao e por-id, nao soma total.
    import psycopg2
    dconn = psycopg2.connect(DST); dcur = dconn.cursor()
    dcur.execute("SELECT id, round(coalesce(pnl,0)::numeric, 6) FROM positions")
    dst_rows = dict(dcur.fetchall()); dconn.close()

    ids = list(dst_rows.keys())
    assert len(ids) >= 22, f"destino tem {len(ids)} posicoes (< 22 migradas)"

    sconn = psycopg2.connect(SRC); scur = sconn.cursor()
    scur.execute(
        "SELECT id, round(coalesce((data->>'pnl')::numeric,0), 6) FROM positions WHERE id = ANY(%s)",
        (ids,),
    )
    src_rows = dict(scur.fetchall()); sconn.close()

    for pid, dpnl in dst_rows.items():
        assert pid in src_rows, f"posicao {pid} no destino nao existe na origem"
        assert src_rows[pid] == dpnl, f"PnL divergente em {pid}: origem {src_rows[pid]} != destino {dpnl}"


def test_positions_all_linked_to_user():
    # Toda posicao migrada tem user_id valido (FK).
    orphans = _scalar(
        DST,
        "SELECT count(*) FROM positions p LEFT JOIN users u ON p.user_id = u.id WHERE u.id IS NULL",
    )
    assert orphans == 0, f"{orphans} posicoes sem user_id valido"
