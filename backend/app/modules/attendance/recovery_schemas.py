"""Contratos de sesión verificada y recuperación supervisada.

Estos esquemas son aditivos: los clientes antiguos siguen usando identify,
prepare, evidence, check-in y check-out sin cambios. ``terminal/verify`` sólo
comprueba la sesión antes de abrir la cámara y la recuperación nunca emite una
credencial de marcación nueva.
"""

import uuid
from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, Field, field_validator

from app.core.text import require_visible_text
from app.modules.attendance.schemas import PreparationSnapshot


class TerminalVerifyRequest(BaseModel):
    marking_token: str = Field(min_length=8, max_length=4096)


class TerminalVerifyResponse(BaseModel):
    """Sesión comprobada antes de la cámara; el token se reemite mismo nonce."""

    verified: bool = True
    employee_id: uuid.UUID
    employee_name: str
    action: Literal["CHECK_IN", "CHECK_OUT"]
    device_id: uuid.UUID
    expires_at: datetime
    server_time: str
    marking_token: str


class RecoveryRequestCreate(BaseModel):
    marking_token: str = Field(min_length=8, max_length=4096)


class RecoveryConfirmationOut(BaseModel):
    """Confirmación mínima y ya existente; nunca se edita al mostrarla."""

    id: uuid.UUID
    employee_id: uuid.UUID
    work_date: date
    check_in_at: datetime
    check_out_at: datetime | None = None
    worked_minutes: int | None = None
    status: str
    event_type: str | None = None


class RecoveryRequestStatusOut(BaseModel):
    """Respuesta mínima para el navegador solicitante (sin datos de otros)."""

    id: uuid.UUID
    status: Literal["PENDING", "AUTHORIZED", "REJECTED", "CONFIRMED_EXISTING"]
    requested_at: datetime
    resolved_at: datetime | None = None
    reason: str | None = None
    can_reidentify: bool = False
    confirmation: RecoveryConfirmationOut | None = None


class RecoveryDeviceRef(BaseModel):
    id: uuid.UUID
    name: str


class RecoveryEmployeeRef(BaseModel):
    id: uuid.UUID
    dni: str
    employee_code: str
    first_name: str
    last_name: str
    active: bool


class RecoveryRequestAdminItem(BaseModel):
    id: uuid.UUID
    nonce: str
    employee_id: uuid.UUID
    employee_name: str | None = None
    employee_dni: str | None = None
    action: str
    status: Literal["PENDING", "AUTHORIZED", "REJECTED", "CONFIRMED_EXISTING"]
    requested_at: datetime
    resolved_at: datetime | None = None
    resolved_by_username: str | None = None
    reason: str | None = None
    original_device_id: uuid.UUID | None = None
    requester_device_id: uuid.UUID | None = None


class RecoveryEvidenceInspection(BaseModel):
    ready: bool
    evidence_id: uuid.UUID | None = None
    captured_at: datetime | None = None
    content_type: str | None = None
    record_id: uuid.UUID | None = None


class RecoveryConsumedInspection(BaseModel):
    present: bool
    confirmed: bool
    record_id: uuid.UUID | None = None
    record: RecoveryConfirmationOut | None = None
    created_at: datetime | None = None
    device_id: uuid.UUID | None = None


class RecoveryResolutionInspection(BaseModel):
    present: bool
    resolution: str | None = None
    reason: str | None = None
    resolved_by_user_id: uuid.UUID | None = None
    resolved_at: datetime | None = None
    record_id: uuid.UUID | None = None


class RecoveryAttemptInspection(BaseModel):
    """Estado verificado del intento: preparación, evidencia, consumo y cierre."""

    state: str
    inconsistent: bool
    browser_unverifiable: bool = False
    can_authorize: bool
    token_expired: bool
    preparation: PreparationSnapshot | None = None
    evidence: RecoveryEvidenceInspection
    consumed: RecoveryConsumedInspection
    resolution: RecoveryResolutionInspection
    record: RecoveryConfirmationOut | None = None
    available_actions: list[str] = Field(default_factory=list)


class RecoveryRequestAdminDetail(BaseModel):
    request: RecoveryRequestAdminItem
    employee: RecoveryEmployeeRef | None = None
    original_device: RecoveryDeviceRef | None = None
    requester_device: RecoveryDeviceRef | None = None
    attempt: RecoveryAttemptInspection


class RecoveryRequestResolveRequest(BaseModel):
    decision: Literal["AUTHORIZE_REIDENTIFY", "REJECT", "CONFIRM_EXISTING"]
    reason: str = Field(min_length=3, max_length=500)

    @field_validator("reason")
    @classmethod
    def reason_visible(cls, value: str) -> str:
        return require_visible_text(value, field="motivo")
