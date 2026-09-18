"""CAL-03: feriados versionados y catálogo nacional 2026.

Revision ID: r4f5a6b7c8d9
Revises: q3e4f5a6b7c8
"""
from alembic import op
import sqlalchemy as sa

revision = "r4f5a6b7c8d9"
down_revision = "q3e4f5a6b7c8"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "holiday_calendar_days",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("holiday_date", sa.Date(), nullable=False),
        sa.Column("name", sa.String(160), nullable=False),
        sa.Column("scope", sa.String(40), nullable=False, server_default="NATIONAL"),
        sa.Column("day_kind", sa.String(40), nullable=False, server_default="HOLIDAY"),
        sa.Column("source", sa.String(250), nullable=False),
        sa.Column("effective_from", sa.Date(), nullable=False),
        sa.Column("effective_to", sa.Date()),
        sa.Column("version", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
        sa.UniqueConstraint("holiday_date", "scope", "version", name="uq_holiday_calendar_day_version"),
        sa.CheckConstraint("version >= 1", name="ck_holiday_calendar_version"),
    )
    op.create_index("ix_holiday_calendar_active", "holiday_calendar_days", ["holiday_date", "effective_to"])


def downgrade():
    raise RuntimeError("El calendario de feriados publicado no se revierte automáticamente")
