"""Añadir clave de objeto privada para evidencias de asistencia.

Revision ID: h4c5d6e7f8a9
Revises: g3b4c5d6e7f8
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "h4c5d6e7f8a9"
down_revision: str | None = "g3b4c5d6e7f8"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("attendance_evidence", sa.Column("object_key", sa.String(length=512), nullable=True))
    op.alter_column(
        "attendance_evidence",
        "image_bytes",
        existing_type=sa.LargeBinary(),
        nullable=True,
    )


def downgrade() -> None:
    op.alter_column(
        "attendance_evidence",
        "image_bytes",
        existing_type=sa.LargeBinary(),
        nullable=False,
    )
    op.drop_column("attendance_evidence", "object_key")
