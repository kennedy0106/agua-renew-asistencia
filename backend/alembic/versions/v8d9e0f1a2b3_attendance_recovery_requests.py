"""Solicitudes de recuperación supervisada de intentos de asistencia.

Aditiva y sin backfill: crea una tabla nueva y no altera asistencias,
evidencias ni resoluciones históricas. El token de marcación nunca se guarda
completo; sólo su huella SHA-256.

Revision ID: v8d9e0f1a2b3
Revises: u7c8d9e0f1a2
"""
from alembic import op
import sqlalchemy as sa

revision = "v8d9e0f1a2b3"
down_revision = "u7c8d9e0f1a2"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "attendance_recovery_requests",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("nonce", sa.String(64), nullable=False),
        sa.Column("employee_id", sa.Uuid(), sa.ForeignKey("employees.id"), nullable=False),
        sa.Column("action", sa.String(20), nullable=False),
        sa.Column("original_device_id", sa.Uuid(), sa.ForeignKey("attendance_devices.id"), nullable=True),
        sa.Column("requester_device_id", sa.Uuid(), sa.ForeignKey("attendance_devices.id"), nullable=False),
        sa.Column("token_sha256", sa.String(64), nullable=True),
        sa.Column("token_issued_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("token_expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "status", sa.String(24), nullable=False, server_default="PENDING"
        ),
        sa.Column(
            "requested_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.Column("resolved_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("resolved_by_user_id", sa.Uuid(), sa.ForeignKey("users.id"), nullable=True),
        sa.Column("reason", sa.String(500), nullable=True),
        sa.UniqueConstraint(
            "nonce",
            "requester_device_id",
            name="uq_attendance_recovery_request_nonce_requester",
        ),
        sa.CheckConstraint("action IN ('CHECK_IN', 'CHECK_OUT')", name="ck_recovery_request_action"),
        sa.CheckConstraint(
            "status IN ('PENDING', 'AUTHORIZED', 'REJECTED', 'CONFIRMED_EXISTING')",
            name="ck_recovery_request_status",
        ),
    )
    op.create_index(
        "ix_attendance_recovery_requests_nonce",
        "attendance_recovery_requests",
        ["nonce"],
    )
    op.create_index(
        "ix_attendance_recovery_requests_employee_id",
        "attendance_recovery_requests",
        ["employee_id"],
    )
    op.create_index(
        "ix_attendance_recovery_requests_original_device_id",
        "attendance_recovery_requests",
        ["original_device_id"],
    )
    op.create_index(
        "ix_attendance_recovery_requests_requester_device_id",
        "attendance_recovery_requests",
        ["requester_device_id"],
    )
    op.create_index(
        "ix_attendance_recovery_requests_resolved_by_user_id",
        "attendance_recovery_requests",
        ["resolved_by_user_id"],
    )
    op.create_index(
        "ix_attendance_recovery_requests_status_requested",
        "attendance_recovery_requests",
        ["status", "requested_at"],
    )


def downgrade():
    # Las solicitudes y sus resoluciones son historial auditable de una
    # decisión humana. No se borran automáticamente: una reversión exige una
    # operación manual revisada y respaldada.
    raise RuntimeError(
        "Las solicitudes de recuperación son evidencia auditable y no se revierten automáticamente"
    )
