"""Terminal pairing, evidence hash and immutable nonce payloads.

Revision ID: d9a1b2c3d4e5
Revises: c8d4e5f6a701
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "d9a1b2c3d4e5"
down_revision: str | None = "c8d4e5f6a701"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("attendance_devices", sa.Column("pairing_code_hash", sa.String(length=255), nullable=True))
    op.add_column("attendance_devices", sa.Column("pairing_expires_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column(
        "attendance_devices",
        sa.Column("token_version", sa.Integer(), server_default="1", nullable=False),
    )
    op.add_column(
        "attendance_consumed_nonces",
        sa.Column("event_type", sa.String(length=20), server_default="CHECK_IN", nullable=False),
    )
    op.add_column("attendance_consumed_nonces", sa.Column("result_payload", sa.JSON(), nullable=True))
    op.add_column("attendance_evidence", sa.Column("device_id", sa.Uuid(), sa.ForeignKey("attendance_devices.id"), nullable=True))
    op.add_column("attendance_evidence", sa.Column("image_sha256", sa.String(length=64), nullable=True))
    op.create_index("ix_attendance_evidence_device_id", "attendance_evidence", ["device_id"])


def downgrade() -> None:
    op.drop_index("ix_attendance_evidence_device_id", table_name="attendance_evidence")
    op.drop_column("attendance_evidence", "image_sha256")
    op.drop_column("attendance_evidence", "device_id")
    op.drop_column("attendance_consumed_nonces", "result_payload")
    op.drop_column("attendance_consumed_nonces", "event_type")
    op.drop_column("attendance_devices", "token_version")
    op.drop_column("attendance_devices", "pairing_expires_at")
    op.drop_column("attendance_devices", "pairing_code_hash")
