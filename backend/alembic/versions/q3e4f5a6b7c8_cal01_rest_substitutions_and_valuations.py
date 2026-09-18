"""CAL-01/CAL-02: calendario de descansos y valoración versionada.

Revision ID: q3e4f5a6b7c8
Revises: p2d3e4f5a6b7
"""
from alembic import op
import sqlalchemy as sa

revision = "q3e4f5a6b7c8"
down_revision = "p2d3e4f5a6b7"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("payroll_records", sa.Column("special_day_amount", sa.Numeric(12, 2), nullable=False, server_default="0.00"))
    op.create_table(
        "employee_weekly_rest_rules",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("employee_id", sa.Uuid(), sa.ForeignKey("employees.id"), nullable=False),
        sa.Column("weekly_rest_weekday", sa.Integer(), nullable=False),
        sa.Column("week_starts_on", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("reference_daily_minutes", sa.Integer(), nullable=False),
        sa.Column("source", sa.String(80), nullable=False),
        sa.Column("reason", sa.String(500), nullable=False),
        sa.Column("effective_from", sa.Date(), nullable=False),
        sa.Column("effective_to", sa.Date()),
        sa.Column("version", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("created_by_user_id", sa.Uuid(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
        sa.CheckConstraint("weekly_rest_weekday >= 0 AND weekly_rest_weekday <= 6", name="ck_weekly_rest_weekday"),
        sa.CheckConstraint("reference_daily_minutes > 0 AND reference_daily_minutes <= 1440", name="ck_weekly_rest_reference"),
        sa.CheckConstraint("week_starts_on = 0", name="ck_weekly_rest_monday_start"),
    )
    op.create_index("ix_weekly_rest_employee_effective", "employee_weekly_rest_rules", ["employee_id", "effective_from", "effective_to"])
    op.create_table(
        "rest_substitutions",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("employee_id", sa.Uuid(), sa.ForeignKey("employees.id"), nullable=False),
        sa.Column("original_date", sa.Date(), nullable=False),
        sa.Column("substitute_start", sa.DateTime(timezone=True), nullable=False),
        sa.Column("substitute_end", sa.DateTime(timezone=True), nullable=False),
        sa.Column("reference", sa.String(500), nullable=False),
        sa.Column("reason", sa.String(500), nullable=False),
        sa.Column("status", sa.String(24), nullable=False, server_default="PROPOSED"),
        sa.Column("version", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("evidence", sa.JSON()),
        sa.Column("created_by_user_id", sa.Uuid(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("approved_by_user_id", sa.Uuid(), sa.ForeignKey("users.id")),
        sa.Column("approved_at", sa.DateTime(timezone=True)),
        sa.Column("cancelled_at", sa.DateTime(timezone=True)),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
        sa.CheckConstraint("substitute_end >= substitute_start", name="ck_rest_substitution_range"),
        sa.CheckConstraint("version >= 1", name="ck_rest_substitution_version"),
    )
    op.create_index("ix_rest_substitution_employee_origin", "rest_substitutions", ["employee_id", "original_date"])
    op.create_index("ix_rest_substitution_employee_range", "rest_substitutions", ["employee_id", "substitute_start", "substitute_end"])
    op.create_table(
        "special_day_valuations",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("employee_id", sa.Uuid(), sa.ForeignKey("employees.id"), nullable=False),
        sa.Column("work_date", sa.Date(), nullable=False),
        sa.Column("source_kind", sa.String(40), nullable=False),
        sa.Column("status", sa.String(32), nullable=False, server_default="PENDING"),
        sa.Column("worked_minutes", sa.Integer(), nullable=False),
        sa.Column("reference_daily_minutes", sa.Integer(), nullable=False),
        sa.Column("amount", sa.Numeric(12, 2), nullable=False, server_default="0.00"),
        sa.Column("calculation", sa.JSON(), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("preview_token", sa.String(128)),
        sa.Column("approved_by_user_id", sa.Uuid(), sa.ForeignKey("users.id")),
        sa.Column("approved_at", sa.DateTime(timezone=True)),
        sa.Column("voided_at", sa.DateTime(timezone=True)),
        sa.Column("void_reason", sa.String(500)),
        sa.Column("created_by_user_id", sa.Uuid(), sa.ForeignKey("users.id")),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
        sa.CheckConstraint("worked_minutes >= 0", name="ck_special_day_worked_minutes"),
        sa.CheckConstraint("reference_daily_minutes > 0", name="ck_special_day_reference_minutes"),
        sa.CheckConstraint("version >= 1", name="ck_special_day_valuation_version"),
    )
    op.create_index("ix_special_day_valuation_employee_day", "special_day_valuations", ["employee_id", "work_date"])
    op.create_index("uq_special_day_valuation_active", "special_day_valuations", ["employee_id", "work_date", "source_kind"], unique=True, postgresql_where=sa.text("voided_at IS NULL"))
    op.create_table(
        "special_day_valuation_components",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("valuation_id", sa.Uuid(), sa.ForeignKey("special_day_valuations.id"), nullable=False),
        sa.Column("component_kind", sa.String(48), nullable=False),
        sa.Column("minutes", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("amount", sa.Numeric(12, 2), nullable=False, server_default="0.00"),
        sa.Column("details", sa.JSON()),
        sa.UniqueConstraint("valuation_id", "component_kind", name="uq_special_day_component_kind"),
    )
    op.create_table(
        "work_calendar_operation_receipts",
        sa.Column("idempotency_key", sa.String(128), primary_key=True),
        sa.Column("payload_hash", sa.String(64), nullable=False),
        sa.Column("operation_type", sa.String(48), nullable=False),
        sa.Column("result", sa.JSON(), nullable=False),
        sa.Column("actor_user_id", sa.Uuid(), sa.ForeignKey("users.id")),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
    )


def downgrade():
    raise RuntimeError("Las valoraciones especiales son evidencia contable y no se revierten automáticamente")
