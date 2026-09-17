"""HST-01 corrective integrity constraints.

Revision ID: m9a0b1c2d3e4
Revises: l8f9a0b1c2d3
"""
from alembic import op
from sqlalchemy import text

revision = "m9a0b1c2d3e4"
down_revision = "l8f9a0b1c2d3"
branch_labels = None
depends_on = None


def upgrade():
    # Do not choose or merge an audited agreement during schema upgrade.  A
    # duplicate has no mechanically safe winner, so fail before DDL with a
    # diagnosis and leave the l8f9 data untouched for explicit remediation.
    duplicate = op.get_bind().execute(
        text("""
        SELECT employee_id, permission_date
        FROM recovery_commitments
        GROUP BY employee_id, permission_date
        HAVING COUNT(*) > 1
        ORDER BY employee_id, permission_date
        LIMIT 1
        """)
    ).first()
    if duplicate is not None:
        raise RuntimeError(
            "HST-01 corrective upgrade blocked: duplicate recovery commitments "
            f"for employee={duplicate[0]} permission_date={duplicate[1]}; "
            "reconcile the audited agreements before retrying (no data was changed)."
        )
    # The application rejects duplicates before this constraint; the database
    # guard closes the race between two administrative sessions.
    op.create_unique_constraint(
        "uq_recovery_commitment_employee_permission",
        "recovery_commitments",
        ["employee_id", "permission_date"],
    )


def downgrade():
    raise RuntimeError("HST-01 corrective downgrade is blocked: removing audited integrity guarantees is unsafe")
