"""Huella de planilla, filas no pagables, nonce y evidencia de marcación.

Revision ID: c8d4e5f6a701
Revises: b7e1c4a90f12

No reescribe asistencia histórica ni planillas cerradas (R13).
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "c8d4e5f6a701"
down_revision: str | None = "b7e1c4a90f12"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("payroll_periods", sa.Column("inputs_fingerprint", sa.String(length=64), nullable=True))
    op.add_column(
        "payroll_records",
        sa.Column("payable", sa.Boolean(), server_default="true", nullable=False),
    )
    op.create_table(
        "attendance_consumed_nonces",
        sa.Column("nonce", sa.String(length=64), primary_key=True),
        sa.Column("action", sa.String(length=20), nullable=False),
        sa.Column("employee_id", sa.Uuid(), sa.ForeignKey("employees.id"), nullable=False),
        sa.Column("attendance_record_id", sa.Uuid(), sa.ForeignKey("attendance_records.id"), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_attendance_consumed_nonces_employee_id", "attendance_consumed_nonces", ["employee_id"])
    op.create_table(
        "attendance_evidence",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("nonce", sa.String(length=64), nullable=False),
        sa.Column("employee_id", sa.Uuid(), sa.ForeignKey("employees.id"), nullable=False),
        sa.Column("attendance_record_id", sa.Uuid(), sa.ForeignKey("attendance_records.id"), nullable=True),
        sa.Column("content_type", sa.String(length=40), nullable=False),
        sa.Column("image_bytes", sa.LargeBinary(), nullable=False),
        sa.Column("captured_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("exception_reason", sa.String(length=500), nullable=True),
    )
    op.create_index("ix_attendance_evidence_nonce", "attendance_evidence", ["nonce"], unique=True)
    op.create_index("ix_attendance_evidence_employee_id", "attendance_evidence", ["employee_id"])


def downgrade() -> None:
    op.drop_index("ix_attendance_evidence_employee_id", table_name="attendance_evidence")
    op.drop_index("ix_attendance_evidence_nonce", table_name="attendance_evidence")
    op.drop_table("attendance_evidence")
    op.drop_index("ix_attendance_consumed_nonces_employee_id", table_name="attendance_consumed_nonces")
    op.drop_table("attendance_consumed_nonces")
    op.drop_column("payroll_records", "payable")
    op.drop_column("payroll_periods", "inputs_fingerprint")
