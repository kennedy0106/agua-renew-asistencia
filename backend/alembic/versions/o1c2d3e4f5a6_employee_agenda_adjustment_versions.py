"""Agenda de empleado y correcciones versionadas de ajustes legacy.

Revision ID: o1c2d3e4f5a6
Revises: n0b1c2d3e4f5
"""

from alembic import op
import sqlalchemy as sa


revision = "o1c2d3e4f5a6"
down_revision = "n0b1c2d3e4f5"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("hour_adjustments", sa.Column("version", sa.Integer(), nullable=False, server_default="1"))
    op.add_column("hour_adjustments", sa.Column("supersedes_id", sa.Uuid(), nullable=True))
    op.add_column("hour_adjustments", sa.Column("voided_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("hour_adjustments", sa.Column("voided_by", sa.Uuid(), nullable=True))
    op.add_column("hour_adjustments", sa.Column("void_reason", sa.String(length=500), nullable=True))
    op.create_foreign_key("fk_hour_adjustments_supersedes", "hour_adjustments", "hour_adjustments", ["supersedes_id"], ["id"])
    op.create_foreign_key("fk_hour_adjustments_voided_by", "hour_adjustments", "users", ["voided_by"], ["id"])
    op.create_index("ix_hour_adjustments_supersedes_id", "hour_adjustments", ["supersedes_id"])
    op.create_index("ix_hour_adjustments_voided_at", "hour_adjustments", ["voided_at"])
    op.create_index("ix_hour_adjustments_voided_by", "hour_adjustments", ["voided_by"])
    op.create_index(
        "uq_hour_adjustment_active_overtime_day",
        "hour_adjustments",
        ["employee_id", "adjustment_date"],
        unique=True,
        postgresql_where=sa.text("adjustment_type = 'OVERTIME' AND voided_at IS NULL AND status IN ('PENDING', 'APPROVED')"),
    )
    op.create_table(
        "adjustment_operation_receipts",
        sa.Column("idempotency_key", sa.String(length=128), primary_key=True),
        sa.Column("payload_hash", sa.String(length=64), nullable=False),
        sa.Column("result", sa.JSON(), nullable=False),
        sa.Column("actor_user_id", sa.Uuid(), nullable=False),
        sa.Column("operation_type", sa.String(length=16), nullable=False),
        sa.Column("target_adjustment_id", sa.Uuid(), nullable=False),
        sa.Column("http_status", sa.Integer(), nullable=False, server_default="200"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.ForeignKeyConstraint(["actor_user_id"], ["users.id"]),
        sa.ForeignKeyConstraint(["target_adjustment_id"], ["hour_adjustments.id"]),
        sa.CheckConstraint("operation_type IN ('UPDATE', 'VOID', 'APPROVE', 'REJECT')", name="ck_adjustment_receipt_operation"),
    )
    op.create_index("ix_adjustment_receipts_actor", "adjustment_operation_receipts", ["actor_user_id"])
    op.create_index("ix_adjustment_receipts_target", "adjustment_operation_receipts", ["target_adjustment_id"])


def downgrade():
    raise RuntimeError("Las correcciones versionadas conservan auditoría y no se revierten automáticamente")
