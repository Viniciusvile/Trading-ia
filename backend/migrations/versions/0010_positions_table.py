"""tabela positions (historico real de posicoes abertas/fechadas, migrado do legado)

Revision ID: 0010
Revises: 0009
Create Date: 2026-06-13

"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "0010"
down_revision: Union[str, None] = "0009"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "positions",
        sa.Column("id", sa.String(100), primary_key=True),
        sa.Column("user_id", sa.String(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("symbol", sa.String(20), nullable=False),
        sa.Column("side", sa.String(10), nullable=True),
        sa.Column("status", sa.String(10), nullable=False),
        sa.Column("strategy", sa.String(50), nullable=True),
        sa.Column("plan", sa.String(100), nullable=True),
        sa.Column("timeframe", sa.String(10), nullable=True),
        sa.Column("quantity", sa.Float(), nullable=True),
        sa.Column("entry_price", sa.Float(), nullable=True),
        sa.Column("exit_price", sa.Float(), nullable=True),
        sa.Column("stop_price", sa.Float(), nullable=True),
        sa.Column("take_profit_price", sa.Float(), nullable=True),
        sa.Column("pnl", sa.Float(), nullable=True),
        sa.Column("opened_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("closed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("data", JSONB(), nullable=False, server_default="{}"),
        sa.Column("account_id", sa.String(100), server_default="default"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("NOW()")),
    )
    op.create_index("idx_positions_user", "positions", ["user_id"])
    op.create_index("idx_positions_status", "positions", ["status"])


def downgrade() -> None:
    op.drop_index("idx_positions_status", table_name="positions")
    op.drop_index("idx_positions_user", table_name="positions")
    op.drop_table("positions")
