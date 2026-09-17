"""HST-01 v2 operation receipts.

Revision ID: n0b1c2d3e4f5
Revises: m9a0b1c2d3e4
"""
from alembic import op
import sqlalchemy as sa

revision = "n0b1c2d3e4f5"
down_revision = "m9a0b1c2d3e4"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("manual_attendance_idempotency", sa.Column("protocol_version", sa.Integer(), nullable=False, server_default="1"))
    op.add_column("manual_attendance_idempotency", sa.Column("actor_user_id", sa.Uuid(), nullable=True))
    op.add_column("manual_attendance_idempotency", sa.Column("operation_type", sa.String(length=16), nullable=True))
    op.add_column("manual_attendance_idempotency", sa.Column("target_manual_day_id", sa.Uuid(), nullable=True))
    op.add_column("manual_attendance_idempotency", sa.Column("http_status", sa.Integer(), nullable=True))
    op.create_foreign_key("fk_manual_attendance_idempotency_actor", "manual_attendance_idempotency", "users", ["actor_user_id"], ["id"])
    op.create_foreign_key("fk_manual_attendance_idempotency_target", "manual_attendance_idempotency", "manual_attendance_days", ["target_manual_day_id"], ["id"])
    op.create_check_constraint("ck_manual_attendance_idempotency_protocol", "manual_attendance_idempotency", "protocol_version IN (1, 2)")
    op.create_check_constraint("ck_manual_attendance_idempotency_v2_scope", "manual_attendance_idempotency", "protocol_version = 1 OR (actor_user_id IS NOT NULL AND operation_type IS NOT NULL AND operation_type IN ('BATCH', 'UPDATE', 'VOID', 'APPROVE') AND http_status IS NOT NULL AND http_status BETWEEN 200 AND 299 AND ((operation_type = 'BATCH' AND target_manual_day_id IS NULL) OR (operation_type <> 'BATCH' AND target_manual_day_id IS NOT NULL)))")


def downgrade():
    raise RuntimeError("HST-01 operation receipts preserve audit scope and cannot be downgraded safely")
