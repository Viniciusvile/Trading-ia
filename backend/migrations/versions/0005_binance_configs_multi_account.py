"""binance_configs: suporta multi-conta por usuario (remove UNIQUE, add label/is_active)

Revision ID: 0005
Revises: 0004
Create Date: 2026-06-13

"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa

revision: str = "0005"
down_revision: Union[str, None] = "0004"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Multi-conta: um usuario pode ter varias contas Binance (como no legado).
    op.drop_constraint("binance_configs_user_id_key", "binance_configs", type_="unique")
    op.add_column("binance_configs", sa.Column("label", sa.String(100), nullable=True))
    op.add_column(
        "binance_configs",
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default="false"),
    )
    op.create_index("ix_binance_configs_user_id", "binance_configs", ["user_id"])


def downgrade() -> None:
    op.drop_index("ix_binance_configs_user_id", table_name="binance_configs")
    op.drop_column("binance_configs", "is_active")
    op.drop_column("binance_configs", "label")
    op.create_unique_constraint("binance_configs_user_id_key", "binance_configs", ["user_id"])
