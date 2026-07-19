import uuid
from datetime import datetime
from sqlalchemy import String, DateTime, ForeignKey, Boolean
from sqlalchemy.orm import Mapped, mapped_column
from app.database import Base

class BinanceConfig(Base):
    __tablename__ = "binance_configs"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    # Multi-conta: varias contas por usuario (sem UNIQUE em user_id).
    user_id: Mapped[str] = mapped_column(String, ForeignKey("users.id"), index=True, nullable=False)
    # Multi-exchange: "binance" | "coinbase". A tabela mantém o nome legado
    # binance_configs; renomear quebraria FKs/queries sem ganho funcional.
    exchange: Mapped[str] = mapped_column(String(20), default="binance", server_default="binance", nullable=False)
    label: Mapped[str | None] = mapped_column(String(100), nullable=True)
    encrypted_api_key: Mapped[str] = mapped_column(String(500), nullable=False)
    encrypted_secret_key: Mapped[str] = mapped_column(String(500), nullable=False)
    is_testnet: Mapped[bool] = mapped_column(Boolean, default=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=False)
    is_valid: Mapped[bool] = mapped_column(Boolean, default=False)
    last_tested_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
