"""Ubicación y tamaño persistidos de evidencias de asistencia.

Revision ID: i5d6e7f8a9b0
Revises: h4c5d6e7f8a9
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "i5d6e7f8a9b0"
down_revision: str | None = "h4c5d6e7f8a9"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


class ExternalEvidenceWouldBeLostError(RuntimeError):
    """Downgrade rechazado: hay referencias S3 no representables como bytes."""


def upgrade() -> None:
    op.add_column("attendance_evidence", sa.Column("storage_backend", sa.String(length=16), nullable=True))
    op.add_column("attendance_evidence", sa.Column("storage_bucket", sa.String(length=255), nullable=True))
    op.add_column("attendance_evidence", sa.Column("byte_size", sa.Integer(), nullable=True))
    bind = op.get_bind()
    dialect = bind.dialect.name
    if dialect == "postgresql":
        op.execute(
            sa.text(
                """
                UPDATE attendance_evidence
                SET storage_backend = 'DATABASE',
                    byte_size = octet_length(image_bytes)
                WHERE image_bytes IS NOT NULL AND object_key IS NULL
                """
            )
        )
    else:
        op.execute(
            sa.text(
                """
                UPDATE attendance_evidence
                SET storage_backend = 'DATABASE',
                    byte_size = length(image_bytes)
                WHERE image_bytes IS NOT NULL AND object_key IS NULL
                """
            )
        )
    # Filas con object_key y sin bucket no se rellenan: requieren backfill explícito.
    op.create_check_constraint(
        "ck_attendance_evidence_location",
        "attendance_evidence",
        "("
        "storage_backend = 'DATABASE' AND image_bytes IS NOT NULL AND object_key IS NULL"
        ") OR ("
        "storage_backend = 'S3' AND object_key IS NOT NULL AND storage_bucket IS NOT NULL "
        "AND image_sha256 IS NOT NULL AND byte_size IS NOT NULL AND image_bytes IS NULL"
        ") OR ("
        "storage_backend IS NULL"
        ")",
    )


def downgrade() -> None:
    conn = op.get_bind()
    external = conn.execute(
        sa.text(
            """
            SELECT count(*) FROM attendance_evidence
            WHERE object_key IS NOT NULL AND image_bytes IS NULL
            """
        )
    ).scalar()
    if external:
        raise ExternalEvidenceWouldBeLostError(
            "No se puede revertir i5d6e7f8a9b0: hay evidencias S3 sin JPEG en PostgreSQL. "
            "No se truncan ni se borran fotos para forzar el downgrade. "
            "La revisión h4c5d6e7f8a9 tampoco puede poner image_bytes NOT NULL sobre esas filas."
        )
    op.drop_constraint("ck_attendance_evidence_location", "attendance_evidence", type_="check")
    op.drop_column("attendance_evidence", "byte_size")
    op.drop_column("attendance_evidence", "storage_bucket")
    op.drop_column("attendance_evidence", "storage_backend")
