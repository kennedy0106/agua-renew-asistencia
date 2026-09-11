"""Harden attendance events, daily breaks and payment versioning.

Revision ID: 6f4b9c2d1a70
Revises: 3e6aff77cfa9
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "6f4b9c2d1a70"
down_revision: str | None = "3e6aff77cfa9"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "work_schedules",
        sa.Column("break_applies_after_minutes", sa.Integer(), server_default="360", nullable=False),
    )
    op.create_check_constraint(
        "ck_work_schedule_break_threshold_range",
        "work_schedules",
        "break_applies_after_minutes >= 0 AND break_applies_after_minutes <= 1440",
    )
    op.create_check_constraint(
        "ck_attendance_checkout_after_checkin",
        "attendance_records",
        "check_out_at IS NULL OR check_out_at >= check_in_at",
    )
    op.create_index(
        "uq_attendance_one_open_per_employee",
        "attendance_records",
        ["employee_id"],
        unique=True,
        postgresql_where=sa.text("check_out_at IS NULL"),
    )

    op.create_table(
        "attendance_devices",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("name", sa.String(length=100), nullable=False),
        sa.Column("device_code", sa.String(length=64), nullable=False),
        sa.Column("credential_hash", sa.String(length=255), nullable=True),
        sa.Column("active", sa.Boolean(), server_default=sa.true(), nullable=False),
        sa.Column("last_sync_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("device_code"),
    )
    op.create_index("ix_attendance_devices_device_code", "attendance_devices", ["device_code"])
    op.create_table(
        "attendance_events",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("employee_id", sa.Uuid(), nullable=False),
        sa.Column("device_id", sa.Uuid(), nullable=True),
        sa.Column("attendance_record_id", sa.Uuid(), nullable=True),
        sa.Column("external_event_id", sa.String(length=100), nullable=False),
        sa.Column("event_type", sa.String(length=20), nullable=False),
        sa.Column("source", sa.String(length=20), server_default="WEB", nullable=False),
        sa.Column("captured_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("received_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.CheckConstraint("event_type IN ('CHECK_IN', 'CHECK_OUT')", name="ck_attendance_event_type"),
        sa.CheckConstraint("source IN ('WEB', 'BIOMETRIC', 'ADMIN')", name="ck_attendance_event_source"),
        sa.ForeignKeyConstraint(["attendance_record_id"], ["attendance_records.id"]),
        sa.ForeignKeyConstraint(["device_id"], ["attendance_devices.id"]),
        sa.ForeignKeyConstraint(["employee_id"], ["employees.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("device_id", "external_event_id", name="uq_attendance_event_device_external"),
    )
    op.create_index("ix_attendance_events_employee_id", "attendance_events", ["employee_id"])
    op.create_index("ix_attendance_events_device_id", "attendance_events", ["device_id"])
    op.create_index("ix_attendance_events_attendance_record_id", "attendance_events", ["attendance_record_id"])

    op.add_column("payroll_periods", sa.Column("root_period_id", sa.Uuid(), nullable=True))
    op.add_column("payroll_periods", sa.Column("version", sa.Integer(), server_default="1", nullable=False))
    op.add_column("payroll_periods", sa.Column("supersedes_period_id", sa.Uuid(), nullable=True))
    op.add_column("payroll_periods", sa.Column("rectification_reason", sa.String(length=500), nullable=True))
    op.execute("UPDATE payroll_periods SET root_period_id = id WHERE root_period_id IS NULL")
    op.alter_column("payroll_periods", "root_period_id", nullable=False)
    op.create_foreign_key(
        "fk_payroll_period_supersedes", "payroll_periods", "payroll_periods", ["supersedes_period_id"], ["id"]
    )
    op.create_index("ix_payroll_periods_root_period_id", "payroll_periods", ["root_period_id"])
    op.create_index("ix_payroll_periods_supersedes_period_id", "payroll_periods", ["supersedes_period_id"])
    op.create_check_constraint("ck_payroll_period_version_positive", "payroll_periods", "version >= 1")
    op.create_unique_constraint("uq_payroll_period_root_version", "payroll_periods", ["root_period_id", "version"])
    op.create_unique_constraint(
        "uq_payroll_record_period_employee", "payroll_records", ["payroll_period_id", "employee_id"]
    )


def downgrade() -> None:
    op.drop_constraint("uq_payroll_record_period_employee", "payroll_records", type_="unique")
    op.drop_constraint("uq_payroll_period_root_version", "payroll_periods", type_="unique")
    op.drop_constraint("ck_payroll_period_version_positive", "payroll_periods", type_="check")
    op.drop_index("ix_payroll_periods_supersedes_period_id", table_name="payroll_periods")
    op.drop_index("ix_payroll_periods_root_period_id", table_name="payroll_periods")
    op.drop_constraint("fk_payroll_period_supersedes", "payroll_periods", type_="foreignkey")
    op.drop_column("payroll_periods", "rectification_reason")
    op.drop_column("payroll_periods", "supersedes_period_id")
    op.drop_column("payroll_periods", "version")
    op.drop_column("payroll_periods", "root_period_id")
    op.drop_index("ix_attendance_events_attendance_record_id", table_name="attendance_events")
    op.drop_index("ix_attendance_events_device_id", table_name="attendance_events")
    op.drop_index("ix_attendance_events_employee_id", table_name="attendance_events")
    op.drop_table("attendance_events")
    op.drop_index("ix_attendance_devices_device_code", table_name="attendance_devices")
    op.drop_table("attendance_devices")
    op.drop_index("uq_attendance_one_open_per_employee", table_name="attendance_records")
    op.drop_constraint("ck_attendance_checkout_after_checkin", "attendance_records", type_="check")
    op.drop_constraint("ck_work_schedule_break_threshold_range", "work_schedules", type_="check")
    op.drop_column("work_schedules", "break_applies_after_minutes")
