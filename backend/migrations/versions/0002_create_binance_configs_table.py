"""create binance_configs table

Revision ID: 0002
Revises: 0001
Create Date: 2026-05-18

"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa

revision: str = '0002'
down_revision: Union[str, None] = '0001'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'binance_configs',
        sa.Column('id', sa.String(), nullable=False),
        sa.Column('user_id', sa.String(), sa.ForeignKey('users.id'), nullable=False),
        sa.Column('encrypted_api_key', sa.String(500), nullable=False),
        sa.Column('encrypted_secret_key', sa.String(500), nullable=False),
        sa.Column('is_testnet', sa.Boolean(), nullable=False, server_default='false'),
        sa.Column('is_valid', sa.Boolean(), nullable=False, server_default='false'),
        sa.Column('last_tested_at', sa.DateTime(), nullable=True),
        sa.Column('created_at', sa.DateTime(), nullable=False, server_default=sa.text('NOW()')),
        sa.Column('updated_at', sa.DateTime(), nullable=False, server_default=sa.text('NOW()')),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('user_id'),
    )


def downgrade() -> None:
    op.drop_table('binance_configs')
