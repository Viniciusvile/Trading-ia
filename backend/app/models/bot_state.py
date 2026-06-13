from datetime import datetime
from sqlalchemy import String, DateTime, ForeignKey, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column
from app.database import Base


class UserBotState(Base):
    """Controle por usuario de quais bots estao ligados (espelha o legado).

    data jsonb: {master_enabled, micro_enabled, futures_enabled, master_config, ...}
    """
    __tablename__ = "user_bot_state"

    user_id: Mapped[str] = mapped_column(String, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    data: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


def is_bot_enabled(db, user_id: str, flag: str) -> bool:
    """True se o bot (flag tipo 'master_enabled') esta ligado para o usuario."""
    st = db.get(UserBotState, user_id)
    return bool(st and (st.data or {}).get(flag) is True)
