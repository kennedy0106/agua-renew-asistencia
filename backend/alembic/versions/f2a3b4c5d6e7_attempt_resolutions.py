"""Registro durable de resolución de intentos de kiosco.

Revision ID: f2a3b4c5d6e7
Revises: e1f2a3b4c5d6
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "f2a3b4c5d6e7"
down_revision: str | None = "e1f2a3b4c5d6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "attendance_attempt_resolutions",
        sa.Column("nonce", sa.String(length=64), primary_key=True),
        sa.Column("employee_id", sa.Uuid(), sa.ForeignKey("employees.id"), nullable=False),
        sa.Column("device_id", sa.Uuid(), sa.ForeignKey("attendance_devices.id"), nullable=False),
        sa.Column("action", sa.String(length=20), nullable=False),
        sa.Column("resolution", sa.String(length=32), nullable=False),
        sa.Column("reason", sa.String(length=80), nullable=False),
        sa.Column("resolved_by_user_id", sa.Uuid(), sa.ForeignKey("users.id"), nullable=True),
        sa.Column("attendance_record_id", sa.Uuid(), sa.ForeignKey("attendance_records.id"), nullable=True),
        sa.Column("resolved_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.CheckConstraint("action IN ('CHECK_IN', 'CHECK_OUT')", name="ck_attempt_resolution_action"),
        sa.CheckConstraint(
            "resolution IN ('CANCELLED_UNCONFIRMED', 'REVIEWED_CONFIRMED')",
            name="ck_attempt_resolution_kind",
        ),
        sa.CheckConstraint(
            "(resolution <> 'CANCELLED_UNCONFIRMED') OR (attendance_record_id IS NULL)",
            name="ck_attempt_resolution_cancelled_without_record",
        ),
        sa.CheckConstraint(
            "(resolution <> 'REVIEWED_CONFIRMED') OR (resolved_by_user_id IS NOT NULL AND attendance_record_id IS NOT NULL)",
            name="ck_attempt_resolution_reviewed_has_actor_and_record",
        ),
    )
    op.create_index("ix_attendance_attempt_resolutions_employee_id", "attendance_attempt_resolutions", ["employee_id"])
    op.create_index("ix_attendance_attempt_resolutions_device_id", "attendance_attempt_resolutions", ["device_id"])
    op.create_index(
        "ix_attendance_attempt_resolutions_resolved_by_user_id",
        "attendance_attempt_resolutions",
        ["resolved_by_user_id"],
    )
    op.create_index(
        "ix_attendance_attempt_resolutions_attendance_record_id",
        "attendance_attempt_resolutions",
        ["attendance_record_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_attendance_attempt_resolutions_attendance_record_id", table_name="attendance_attempt_resolutions")
    op.drop_index("ix_attendance_attempt_resolutions_resolved_by_user_id", table_name="attendance_attempt_resolutions")
    op.drop_index("ix_attendance_attempt_resolutions_device_id", table_name="attendance_attempt_resolutions")
    op.drop_index("ix_attendance_attempt_resolutions_employee_id", table_name="attendance_attempt_resolutions")
    op.drop_table("attendance_attempt_resolutions")
