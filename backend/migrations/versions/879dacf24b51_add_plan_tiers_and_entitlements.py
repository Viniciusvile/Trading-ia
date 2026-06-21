"""add_plan_tiers_and_entitlements

Revision ID: 879dacf24b51
Revises: 0010
Create Date: 2026-06-21 13:46:56.514022

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '879dacf24b51'
down_revision: Union[str, None] = '0010'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Add 'ultra' to the plantype enum using autocommit
    with op.get_context().autocommit_block():
        op.execute("ALTER TYPE plantype ADD VALUE 'ultra'")
    
    # Add new entitlement and Stripe billing columns
    op.add_column("users", sa.Column("max_strategies", sa.Integer(), server_default="3", nullable=False))
    op.add_column("users", sa.Column("stripe_customer_id", sa.String(length=255), nullable=True))
    op.add_column("users", sa.Column("stripe_subscription_id", sa.String(length=255), nullable=True))
    op.add_column("users", sa.Column("plan_status", sa.String(length=50), server_default="trialing", nullable=False))


def downgrade() -> None:
    # Drop columns
    op.drop_column("users", "plan_status")
    op.drop_column("users", "stripe_subscription_id")
    op.drop_column("users", "stripe_customer_id")
    op.drop_column("users", "max_strategies")
