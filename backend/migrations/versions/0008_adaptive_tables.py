"""tabelas do Adaptive-Bot (espelham o legado): adaptive_params/trades/heartbeat/lessons/reviews

Revision ID: 0008
Revises: 0007
Create Date: 2026-06-13

"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "0008"
down_revision: Union[str, None] = "0007"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "adaptive_params",
        sa.Column("version", sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column("params", JSONB(), nullable=False),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default="false"),
        sa.Column("source", sa.String(50), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("NOW()")),
    )
    op.create_table(
        "adaptive_trades",
        sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column("symbol", sa.String(20), nullable=False),
        sa.Column("result", sa.String(20), nullable=True),
        sa.Column("return_pct", sa.Float(), nullable=True),
        sa.Column("params_version", sa.BigInteger(), nullable=True),
        sa.Column("data", JSONB(), nullable=True),
        sa.Column("opened_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("closed_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_table(
        "adaptive_heartbeat",
        sa.Column("id", sa.Integer(), primary_key=True, server_default="1"),
        sa.Column("ts", sa.DateTime(timezone=True), server_default=sa.text("NOW()")),
        sa.Column("pid", sa.Integer(), nullable=True),
    )
    op.create_table(
        "adaptive_lessons",
        sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column("lesson", sa.Text(), nullable=False),
        sa.Column("active", sa.Boolean(), nullable=False, server_default="true"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("NOW()")),
    )
    op.create_table(
        "adaptive_reviews",
        sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column("old_version", sa.BigInteger(), nullable=True),
        sa.Column("new_version", sa.BigInteger(), nullable=True),
        sa.Column("trades_analyzed", sa.Integer(), nullable=True),
        sa.Column("response", JSONB(), nullable=True),
        sa.Column("applied", sa.Boolean(), nullable=True),
        sa.Column("reason", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("NOW()")),
    )


def downgrade() -> None:
    op.drop_table("adaptive_reviews")
    op.drop_table("adaptive_lessons")
    op.drop_table("adaptive_heartbeat")
    op.drop_table("adaptive_trades")
    op.drop_table("adaptive_params")
