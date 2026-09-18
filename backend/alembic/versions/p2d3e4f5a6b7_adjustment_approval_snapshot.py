"""Persist immutable valuation for versioned and bulk legacy additions.

Revision ID: p2d3e4f5a6b7
Revises: o1c2d3e4f5a6
"""

from alembic import op
import sqlalchemy as sa


revision = "p2d3e4f5a6b7"
down_revision = "o1c2d3e4f5a6"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("hour_adjustments", sa.Column("approval_snapshot_data", sa.JSON(), nullable=True))


def downgrade():
    raise RuntimeError("Las valoraciones aprobadas son evidencia contable y no se revierten automáticamente")
