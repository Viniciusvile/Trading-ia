from datetime import datetime
from sqlalchemy import String, DateTime, Float, ForeignKey, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column
from app.database import Base


class Position(Base):
    """Posição aberta/fechada por um bot (migrada do legado).

    Espelha os campos ricos que o legado guardava em `positions.data` (JSONB):
    entry/exit/pnl/stop/take-profit. Mantém `data` para preservar o resto
    (exitReason, ocoOrderListId, orderId, etc.) sem perda de informação.
    """

    __tablename__ = "positions"

    # Mantém o id natural do legado (ex.: "POS-SCALPER-1781301588016")
    id: Mapped[str] = mapped_column(String(100), primary_key=True)
    user_id: Mapped[str] = mapped_column(
        String, ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    symbol: Mapped[str] = mapped_column(String(20), nullable=False)
    side: Mapped[str | None] = mapped_column(String(10), nullable=True)
    status: Mapped[str] = mapped_column(String(10), nullable=False)  # open | closed
    strategy: Mapped[str | None] = mapped_column(String(50), nullable=True)
    plan: Mapped[str | None] = mapped_column(String(100), nullable=True)
    timeframe: Mapped[str | None] = mapped_column(String(10), nullable=True)

    quantity: Mapped[float | None] = mapped_column(Float, nullable=True)
    entry_price: Mapped[float | None] = mapped_column(Float, nullable=True)
    exit_price: Mapped[float | None] = mapped_column(Float, nullable=True)
    stop_price: Mapped[float | None] = mapped_column(Float, nullable=True)
    take_profit_price: Mapped[float | None] = mapped_column(Float, nullable=True)
    pnl: Mapped[float | None] = mapped_column(Float, nullable=True)

    opened_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    closed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    # Restante do JSONB do legado, preservado integralmente.
    data: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    account_id: Mapped[str] = mapped_column(String(100), default="default")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
