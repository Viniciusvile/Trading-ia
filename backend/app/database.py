from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, DeclarativeBase
from app.config import settings

class Base(DeclarativeBase):
    pass

def _make_engine():
    # pool_pre_ping: testa a conexão antes de usar e reabre se o Postgres
    #   derrubou o socket ocioso (corrige os "SSL connection has been closed
    #   unexpectedly" que apareciam no worker).
    # pool_recycle: recicla conexões com mais de 30 min, antes de o servidor/
    #   firewall cortá-las.
    return create_engine(
        settings.database_url,
        pool_pre_ping=True,
        pool_recycle=1800,
    )

def _make_session_factory(eng):
    return sessionmaker(autocommit=False, autoflush=False, bind=eng)

# Lazy init — não conecta na importação, só quando get_db é chamado
_engine = None
_SessionLocal = None

def _get_engine():
    global _engine
    if _engine is None:
        _engine = _make_engine()
    return _engine

def _get_session_factory():
    global _SessionLocal
    if _SessionLocal is None:
        _SessionLocal = _make_session_factory(_get_engine())
    return _SessionLocal

def get_db():
    db = _get_session_factory()()
    try:
        yield db
    finally:
        db.close()
