"""Registrar días sin sueldo en el snapshot de planilla.

Revision ID: b7e1c4a90f12
Revises: 6f4b9c2d1a70
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "b7e1c4a90f12"
down_revision: str | None = "6f4b9c2d1a70"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "payroll_records",
        sa.Column("missing_salary_days", sa.Integer(), server_default="0", nullable=False),
    )


def downgrade() -> None:
    op.drop_column("payroll_records", "missing_salary_days")
