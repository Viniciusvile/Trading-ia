from datetime import datetime
from sqlalchemy import String, DateTime, Integer, BigInteger, ForeignKey, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column
from app.database import Base


class UserMicroConfig(Base):
    __tablename__ = "user_micro_config"

    user_id: Mapped[str] = mapped_column(
        String, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    data: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class MicroSession(Base):
    __tablename__ = "micro_sessions"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    session_start: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    symbol: Mapped[str] = mapped_column(String(20), nullable=False)
    trades: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)
    account_id: Mapped[str] = mapped_column(String(100), default="default")


class MicroHeartbeat(Base):
    __tablename__ = "micro_heartbeat"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, default=1)
    ts: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    pid: Mapped[int | None] = mapped_column(Integer, nullable=True)
