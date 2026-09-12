"""Pertenencia del nonce consumido al terminal que lo confirmó.

Revision ID: e1f2a3b4c5d6
Revises: d9a1b2c3d4e5
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "e1f2a3b4c5d6"
down_revision: str | None = "d9a1b2c3d4e5"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "attendance_consumed_nonces",
        sa.Column("device_id", sa.Uuid(), sa.ForeignKey("attendance_devices.id"), nullable=True),
    )
    op.create_index("ix_attendance_consumed_nonces_device_id", "attendance_consumed_nonces", ["device_id"])


def downgrade() -> None:
    op.drop_index("ix_attendance_consumed_nonces_device_id", table_name="attendance_consumed_nonces")
    op.drop_column("attendance_consumed_nonces", "device_id")
