"""Ubicación de marcación: preparación idempotente por nonce (S1-S12).

Aditiva y sin backfill: la tabla es nueva; la evidencia histórica permanece sin
hora/coordenadas fabricadas. La aplicación de la migración no está autorizada en
esta tarea.

Revision ID: u7c8d9e0f1a2
Revises: t6b7c8d9e0f1
"""
from alembic import op
import sqlalchemy as sa

revision = "u7c8d9e0f1a2"
down_revision = "t6b7c8d9e0f1"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "attendance_preparations",
        sa.Column("nonce", sa.String(64), primary_key=True),
        sa.Column("employee_id", sa.Uuid(), sa.ForeignKey("employees.id"), nullable=False),
        sa.Column("device_id", sa.Uuid(), sa.ForeignKey("attendance_devices.id"), nullable=True),
        sa.Column("action", sa.String(20), nullable=False),
        sa.Column("attendance_record_id", sa.Uuid(), sa.ForeignKey("attendance_records.id"), nullable=True),
        sa.Column("marked_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("latitude", sa.Float(), nullable=False),
        sa.Column("longitude", sa.Float(), nullable=False),
        sa.Column("accuracy_m", sa.Float(), nullable=False),
        sa.Column("age_ms", sa.Integer(), nullable=False),
        sa.Column("observed_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("address", sa.String(500), nullable=True),
        sa.Column("employee_name", sa.String(200), nullable=False),
        sa.Column("employee_code", sa.String(64), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.CheckConstraint("action IN ('CHECK_IN', 'CHECK_OUT')", name="ck_attendance_preparation_action"),
    )
    op.create_index("ix_attendance_preparations_employee_id", "attendance_preparations", ["employee_id"])
    op.create_index("ix_attendance_preparations_device_id", "attendance_preparations", ["device_id"])
    op.create_index(
        "ix_attendance_preparations_attendance_record_id",
        "attendance_preparations",
        ["attendance_record_id"],
    )
    op.create_index("ix_attendance_preparations_marked_at", "attendance_preparations", ["marked_at"])


def downgrade():
    raise RuntimeError(
        "La preparación de ubicación es evidencia auditable y no se revierte automáticamente"
    )
