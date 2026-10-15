"""Override diario de refrigerio real.

Revision ID: k7f8a9b0c1d2
Revises: j6e7f8a9b0c1
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "k7f8a9b0c1d2"
down_revision: Union[str, Sequence[str], None] = "j6e7f8a9b0c1"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "attendance_break_overrides",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("employee_id", sa.Uuid(), nullable=False),
        sa.Column("work_date", sa.Date(), nullable=False),
        sa.Column("requested_break_minutes", sa.Integer(), nullable=False),
        sa.Column("reason", sa.String(length=500), nullable=False),
        sa.Column("created_by_user_id", sa.Uuid(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.CheckConstraint("requested_break_minutes >= 0 AND requested_break_minutes <= 1440", name="ck_attendance_break_override_minutes"),
        sa.ForeignKeyConstraint(["created_by_user_id"], ["users.id"]),
        sa.ForeignKeyConstraint(["employee_id"], ["employees.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("employee_id", "work_date", name="uq_attendance_break_override_employee_day"),
    )
    op.create_index(op.f("ix_attendance_break_overrides_employee_id"), "attendance_break_overrides", ["employee_id"], unique=False)
    op.create_index(op.f("ix_attendance_break_overrides_work_date"), "attendance_break_overrides", ["work_date"], unique=False)
    op.create_index(op.f("ix_attendance_break_overrides_created_by_user_id"), "attendance_break_overrides", ["created_by_user_id"], unique=False)


def downgrade() -> None:
    op.drop_index(op.f("ix_attendance_break_overrides_created_by_user_id"), table_name="attendance_break_overrides")
    op.drop_index(op.f("ix_attendance_break_overrides_work_date"), table_name="attendance_break_overrides")
    op.drop_index(op.f("ix_attendance_break_overrides_employee_id"), table_name="attendance_break_overrides")
    op.drop_table("attendance_break_overrides")
