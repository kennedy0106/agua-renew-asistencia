"""CAL-01 cierre: origen de sustitución y recibos con destino.

Revision ID: t6b7c8d9e0f1
Revises: s5a6b7c8d9e0
"""
from alembic import op
import sqlalchemy as sa

revision = "t6b7c8d9e0f1"
down_revision = "s5a6b7c8d9e0"
branch_labels = None
depends_on = None


def upgrade():
    # Existing CAL-01 substitutions were weekly-rest proposals.  Their
    # historical meaning is retained explicitly before holiday substitutions
    # become possible.
    op.add_column("rest_substitutions", sa.Column(
        "origin_kind", sa.String(24), nullable=False, server_default="WEEKLY_REST"
    ))
    op.create_check_constraint(
        "ck_rest_substitution_origin_kind", "rest_substitutions",
        "origin_kind IN ('WEEKLY_REST', 'HOLIDAY')",
    )
    op.add_column("work_calendar_operation_receipts", sa.Column(
        "target_entity_id", sa.Uuid(), nullable=True,
    ))
    op.create_index(
        "ix_work_calendar_operation_receipts_target_entity_id",
        "work_calendar_operation_receipts", ["target_entity_id"],
    )


def downgrade():
    raise RuntimeError("Los recibos y orígenes de sustitución son evidencia auditable y no se revierten automáticamente")
