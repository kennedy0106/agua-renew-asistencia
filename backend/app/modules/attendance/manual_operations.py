"""Small, transaction-bound receipts for HST-01 administrative mutations.

The receipt is deliberately local to historical attendance.  It is not an
application-wide idempotency framework: callers take the transaction advisory
lock, read a completed v2 receipt before touching the domain rows, and append
the exact HTTP response before the one commit that persists the mutation.
"""
from __future__ import annotations

import hashlib
import json
import uuid
from typing import Any

from fastapi import HTTPException, status
from fastapi.encoders import jsonable_encoder
from sqlalchemy import select, text
from sqlalchemy.exc import OperationalError, SQLAlchemyError
from sqlalchemy.orm import Session

from app.modules.attendance.manual_models import ManualAttendanceIdempotency


def payload_hash(payload: Any) -> str:
    """Hash the normalized operation request, excluding only its retry key.

    The preview token and expected version are part of an operation decision:
    accepting a different one under an already-confirmed key would turn a
    replay into an unauthorized new request.  They therefore intentionally
    remain in this hash (unlike the preview-content hash in manual_service).
    """
    if hasattr(payload, "model_dump"):
        payload = payload.model_dump(mode="json", exclude={"idempotency_key"})
    if isinstance(payload, dict) and isinstance(payload.get("recovery_allocations"), list):
        payload["recovery_allocations"] = sorted(payload["recovery_allocations"], key=lambda item: str(item.get("commitment_id")))
    if isinstance(payload, dict) and isinstance(payload.get("rows"), list):
        for row in payload["rows"]:
            if isinstance(row, dict) and isinstance(row.get("recovery_allocations"), list):
                row["recovery_allocations"] = sorted(row["recovery_allocations"], key=lambda item: str(item.get("commitment_id")))
    return hashlib.sha256(
        json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str).encode()
    ).hexdigest()


def _advisory_value(key: str) -> int:
    return int.from_bytes(
        hashlib.sha256(f"hst01-operation:{key}".encode()).digest()[:8],
        byteorder="big", signed=True,
    )


def lock_operation(db: Session, key: str | None) -> None:
    """Serialize a supplied operation key for the lifetime of this transaction.

    SQLite is used by the fast unit tests and has no advisory lock primitive;
    PostgreSQL integration uses the real transaction-scoped lock.
    """
    if not key or db.get_bind().dialect.name != "postgresql":
        return
    try:
        # The setting is transaction-local, so it cannot leak to a later
        # request sharing this pool connection.  A bounded wait is important:
        # timeout does not prove that the first request rolled back.
        db.execute(text("SET LOCAL lock_timeout = '5s'"))
        db.execute(text("SELECT pg_advisory_xact_lock(:value)"), {"value": _advisory_value(key)})
    except OperationalError as exc:
        # PostgreSQL aborts the transaction on a lock timeout.  Roll it back
        # before returning a recoverable domain result; no mutation has run
        # before this point.
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={"code": "OPERATION_IN_PROGRESS", "message": "La operación sigue en curso; reintente con la misma clave"},
        ) from exc


def replay_or_conflict(
    db: Session,
    *, key: str | None,
    digest: str,
    actor_id: uuid.UUID,
    operation_type: str,
    target_manual_day_id: uuid.UUID | None,
) -> dict | None:
    """Return the immutable v2 response or reject a cross-scope reuse.

    v1 rows intentionally cannot be replayed: they have no demonstrable owner
    or operation scope and must never become an accidental authorization grant.
    """
    if not key:
        return None
    receipt = db.scalar(
        select(ManualAttendanceIdempotency)
        .where(ManualAttendanceIdempotency.idempotency_key == key)
        .execution_options(populate_existing=True)
        .with_for_update()
    )
    if receipt is None:
        return None
    if (
        receipt.protocol_version != 2
        or receipt.payload_hash != digest
        or receipt.actor_user_id != actor_id
        or receipt.operation_type != operation_type
        or receipt.target_manual_day_id != target_manual_day_id
    ):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"code": "IDEMPOTENCY_CONFLICT", "message": "La clave ya fue usada para otra operación"},
        )
    return receipt.result


def store_receipt(
    db: Session,
    *, key: str | None,
    digest: str,
    actor_id: uuid.UUID,
    operation_type: str,
    target_manual_day_id: uuid.UUID | None,
    result: dict,
    http_status: int = 200,
) -> None:
    if not key:
        return
    # SQLAlchemy JSON does not apply FastAPI's response encoder.  Persist the
    # same wire-safe snapshot that the endpoint returns, not ORM date/datetime
    # objects whose later serialization could differ or fail at commit.
    result = jsonable_encoder(result)
    db.add(ManualAttendanceIdempotency(
        idempotency_key=key,
        payload_hash=digest,
        result=result,
        protocol_version=2,
        actor_user_id=actor_id,
        operation_type=operation_type,
        target_manual_day_id=target_manual_day_id,
        http_status=http_status,
    ))


def commit_with_receipt_recovery(
    db: Session,
    *,
    key: str | None,
    digest: str,
    actor_id: uuid.UUID,
    operation_type: str,
    target_manual_day_id: uuid.UUID | None,
    result: dict,
) -> dict:
    """Commit once and resolve an ambiguous driver error from the durable receipt.

    A disconnect raised by ``commit`` does not prove rollback.  The only safe
    answer is the exact receipt written in that transaction, or an explicit
    unknown result that the client retries with the same key.
    """
    try:
        db.commit()
        return result
    except SQLAlchemyError as exc:
        db.rollback()
        if key:
            try:
                with Session(db.get_bind()) as recovery:
                    receipt = recovery.get(ManualAttendanceIdempotency, key)
                    if (
                        receipt is not None
                        and receipt.protocol_version == 2
                        and receipt.payload_hash == digest
                        and receipt.actor_user_id == actor_id
                        and receipt.operation_type == operation_type
                        and receipt.target_manual_day_id == target_manual_day_id
                    ):
                        return receipt.result
            except SQLAlchemyError:
                pass
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={
                "code": "OPERATION_RESULT_UNKNOWN",
                "message": "No se pudo confirmar el resultado; reintente con la misma clave",
            },
        ) from exc
