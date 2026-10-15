"""CAL-04: padres mensuales y periodos quincenales pagables.

Revision ID: s5a6b7c8d9e0
Revises: r4f5a6b7c8d9
"""
from alembic import op
import sqlalchemy as sa

revision = "s5a6b7c8d9e0"
down_revision = "r4f5a6b7c8d9"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "payroll_months",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("year", sa.Integer(), nullable=False),
        sa.Column("month", sa.Integer(), nullable=False),
        sa.Column("mode", sa.String(24), nullable=False, server_default="MONTHLY_LEGACY"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
        sa.UniqueConstraint("year", "month", name="uq_payroll_month_year_month"),
        sa.CheckConstraint("month >= 1 AND month <= 12", name="ck_payroll_month_month"),
    )
    op.add_column("payroll_periods", sa.Column("payroll_month_id", sa.Uuid(), sa.ForeignKey("payroll_months.id"), nullable=True))
    op.add_column("payroll_periods", sa.Column("period_kind", sa.String(20), nullable=False, server_default="MONTHLY"))
    op.create_index("ix_payroll_periods_payroll_month_id", "payroll_periods", ["payroll_month_id"])
    op.create_index("ix_payroll_periods_month_kind", "payroll_periods", ["payroll_month_id", "period_kind"])


def downgrade():
    raise RuntimeError("Las liquidaciones quincenales pueden tener cierres y no se revierten automáticamente")
