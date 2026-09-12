"""Ampliar motivo de resolución de intento a 500 caracteres.

Revision ID: g3b4c5d6e7f8
Revises: f2a3b4c5d6e7
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "g3b4c5d6e7f8"
down_revision: str | None = "f2a3b4c5d6e7"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


class ReasonTooLongForDowngradeError(RuntimeError):
    """Downgrade a VARCHAR(80) rechazado: hay motivos más largos."""


def upgrade() -> None:
    op.alter_column(
        "attendance_attempt_resolutions",
        "reason",
        existing_type=sa.String(length=80),
        type_=sa.String(length=500),
        existing_nullable=False,
    )


def downgrade() -> None:
    conn = op.get_bind()
    too_long = conn.execute(
        sa.text(
            "SELECT count(*) FROM attendance_attempt_resolutions WHERE char_length(reason) > 80"
        )
    ).scalar()
    if too_long:
        raise ReasonTooLongForDowngradeError(
            "No se puede reducir reason a 80 caracteres: hay motivos más largos. "
            "No se recortan datos para forzar el downgrade."
        )
    op.alter_column(
        "attendance_attempt_resolutions",
        "reason",
        existing_type=sa.String(length=500),
        type_=sa.String(length=80),
        existing_nullable=False,
    )
