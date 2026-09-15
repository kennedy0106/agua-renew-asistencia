"""Obliga el cambio de contraseña temporal para nuevos usuarios.

Revision ID: j6e7f8a9b0c1
Revises: i5d6e7f8a9b0
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "j6e7f8a9b0c1"
down_revision: str | None = "i5d6e7f8a9b0"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # El server_default permite el backfill atómico de filas existentes. La
    # aplicación fija True explícitamente únicamente al crear nuevos usuarios.
    op.add_column(
        "users",
        sa.Column("must_change_password", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    op.alter_column("users", "must_change_password", server_default=None)


def downgrade() -> None:
    op.drop_column("users", "must_change_password")
