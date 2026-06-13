"""tabelas do Micro-Scalper (espelham o legado): user_micro_config, micro_sessions, micro_heartbeat

Revision ID: 0006
Revises: 0005
Create Date: 2026-06-13

"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "0006"
down_revision: Union[str, None] = "0005"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "user_micro_config",
        sa.Column("user_id", sa.String(), sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("data", JSONB(), nullable=False, server_default="{}"),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("NOW()")),
    )
    op.create_table(
        "micro_sessions",
        sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column("session_start", sa.DateTime(timezone=True), nullable=False),
        sa.Column("symbol", sa.String(20), nullable=False),
        sa.Column("trades", JSONB(), nullable=False, server_default="[]"),
        sa.Column("account_id", sa.String(100), server_default="default"),
        sa.UniqueConstraint("session_start", "symbol", "account_id",
                            name="micro_sessions_session_start_symbol_account_id_key"),
    )
    op.create_index("idx_micro_sessions_ts", "micro_sessions", [sa.text("session_start DESC")])
    op.create_table(
        "micro_heartbeat",
        sa.Column("id", sa.Integer(), primary_key=True, server_default="1"),
        sa.Column("ts", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("NOW()")),
        sa.Column("pid", sa.Integer(), nullable=True),
    )


def downgrade() -> None:
    op.drop_table("micro_heartbeat")
    op.drop_index("idx_micro_sessions_ts", table_name="micro_sessions")
    op.drop_table("micro_sessions")
    op.drop_table("user_micro_config")
