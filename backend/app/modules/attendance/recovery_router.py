"""Sesión verificada del kiosco y recuperación supervisada.

Rutas aditivas bajo /api/v1/attendance:
- POST /terminal/verify (público, sin efectos de asistencia)
- POST /recovery-requests (público, idempotente por nonce+navegador)
- GET  /recovery-requests/{id} (sólo el navegador solicitante)
- GET  /recovery-requests/admin (ADMIN/BOSS)
- GET  /recovery-requests/admin/{id} (ADMIN/BOSS)
- POST /recovery-requests/admin/{id}/resolve (ADMIN/BOSS)
"""

import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from sqlalchemy.orm import Session

from app.core.permissions import require_any_role
from app.core.rate_limit import RateLimiter, client_ip
from app.core.security import (
    create_terminal_token,
    decode_attendance_token,
    decode_attendance_token_for_recovery,
    decode_terminal_token,
    terminal_cookie_kwargs,
)
from app.core.timezone import lima_tz
from app.db.session import get_db
from app.modules.attendance.models import AttendanceDevice
from app.modules.attendance.recovery_schemas import (
    RecoveryRequestAdminDetail,
    RecoveryRequestAdminItem,
    RecoveryRequestCreate,
    RecoveryRequestResolveRequest,
    RecoveryRequestStatusOut,
    TerminalVerifyRequest,
    TerminalVerifyResponse,
)
from app.modules.attendance.recovery_service import RecoveryService
from app.modules.devices.service import DeviceService
from app.modules.employees.repository import EmployeeRepository

router = APIRouter(prefix="/api/v1/attendance", tags=["attendance-recovery"])

can_manage_recovery = require_any_role("ADMIN", "BOSS")

_verify_limiter = RateLimiter(limit=120, window_seconds=60)
# El límite por IP es holgado: una oficina con NAT puede tener varios
# trabajadores. El control fino es por navegador y por nonce, y las relecturas
# idempotentes no consumen ninguno de los dos.
_recovery_limiter = RateLimiter(limit=30, window_seconds=3600)
_recovery_device_limiter = RateLimiter(limit=5, window_seconds=3600)
_recovery_nonce_limiter = RateLimiter(limit=3, window_seconds=3600)


def _domain_error(status_code: int, code: str, message: str):
    raise HTTPException(status_code=status_code, detail={"code": code, "message": message})


def _cookie_device(request: Request, db: Session) -> tuple[AttendanceDevice | None, str | None]:
    """Devuelve el contexto firmado vigente o el motivo exacto de su ausencia.

    No escribe ni renueva nada. ``missing`` distingue una cookie no enviada de
    una cookie inválida o revocada; el navegador puede entonces informar el
    hecho sin afirmar una causa que no puede comprobar.
    """
    token = request.cookies.get("agua_renew_terminal")
    if not token:
        return None, "missing"
    payload = decode_terminal_token(token)
    if payload is None:
        return None, "invalid"
    try:
        device_id = uuid.UUID(str(payload["sub"]))
        token_version = int(payload.get("ver") or 1)
    except (KeyError, ValueError, TypeError):
        return None, "invalid"
    device = db.get(AttendanceDevice, device_id)
    if device is None:
        return None, "invalid"
    if not device.active or int(device.token_version or 1) != token_version:
        return None, "revoked"
    return device, None


def _rate_limit(request: Request, limiter: RateLimiter, *, key: str | None = None) -> None:
    if not limiter.allow(key or client_ip(request)):
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail={
                "code": "RECOVERY_RATE_LIMITED",
                "message": "Demasiadas solicitudes de recuperación. Espere antes de reintentar.",
            },
        )


@router.post("/terminal/verify", response_model=TerminalVerifyResponse)
def verify_terminal_session(
    payload: TerminalVerifyRequest,
    request: Request,
    db: Session = Depends(get_db),
) -> TerminalVerifyResponse:
    """Comprueba cookie + token vigente del mismo navegador antes de la cámara.

    No crea asistencia, eventos, evidencia ni preparación. Devuelve el MISMO
    token con su vencimiento original: verificar nunca amplía la ventana.
    """
    _rate_limit(request, _verify_limiter)
    device, failure = _cookie_device(request, db)
    if failure == "missing":
        _domain_error(
            status.HTTP_401_UNAUTHORIZED,
            "TERMINAL_COOKIE_MISSING",
            "El navegador no envió la cookie de sesión de este equipo. No se abrió la cámara ni se registró nada.",
        )
    if failure == "revoked":
        _domain_error(
            status.HTTP_401_UNAUTHORIZED,
            "TERMINAL_SESSION_REVOKED",
            "La sesión de este equipo fue revocada. Vuelva a identificar el equipo.",
        )
    if failure is not None or device is None:
        _domain_error(
            status.HTTP_401_UNAUTHORIZED,
            "TERMINAL_SESSION_INVALID",
            "La sesión de este equipo no es válida. Vuelva a identificar el equipo.",
        )

    decoded = decode_attendance_token(payload.marking_token)
    if decoded is None:
        if decode_attendance_token_for_recovery(payload.marking_token) is not None:
            _domain_error(
                status.HTTP_401_UNAUTHORIZED,
                "MARKING_TOKEN_EXPIRED",
                "La identificación venció antes de abrir la cámara. Vuelva a identificar.",
            )
        _domain_error(
            status.HTTP_401_UNAUTHORIZED,
            "MARKING_TOKEN_INVALID",
            "La identificación no es válida. Vuelva a identificar.",
        )
    token_device = decoded.get("did")
    if not token_device:
        _domain_error(
            status.HTTP_401_UNAUTHORIZED,
            "MARKING_TOKEN_NOT_BOUND",
            "La identificación no está vinculada a este navegador. Vuelva a identificar.",
        )
    if str(token_device) != str(device.id):
        _domain_error(
            status.HTTP_401_UNAUTHORIZED,
            "MARKING_TOKEN_FOREIGN_DEVICE",
            "La identificación pertenece a otro equipo o navegador. Vuelva a identificar en este equipo.",
        )
    try:
        employee_id = uuid.UUID(str(decoded["sub"]))
    except (KeyError, ValueError, TypeError):
        _domain_error(
            status.HTTP_401_UNAUTHORIZED,
            "MARKING_TOKEN_INVALID",
            "La identificación no es válida. Vuelva a identificar.",
        )
    employee = EmployeeRepository(db).get_by_id(employee_id)
    if employee is None:
        _domain_error(
            status.HTTP_401_UNAUTHORIZED,
            "MARKING_TOKEN_INVALID",
            "La identificación no corresponde a un trabajador vigente. Vuelva a identificar.",
        )
    if not employee.active:
        _domain_error(
            status.HTTP_403_FORBIDDEN,
            "EMPLOYEE_INACTIVE",
            "El trabajador está inactivo y no puede marcar asistencia.",
        )

    now = datetime.now(timezone.utc)
    # Verificar no renueva ni extiende el permiso de marcación: devuelve el
    # mismo token con su vencimiento original. La ventana sólo la fija prepare.
    raw_exp = decoded.get("exp")
    if isinstance(raw_exp, datetime):
        expires_at = raw_exp
    elif isinstance(raw_exp, (int, float)) and not isinstance(raw_exp, bool):
        expires_at = datetime.fromtimestamp(float(raw_exp), tz=timezone.utc)
    else:
        _domain_error(
            status.HTTP_401_UNAUTHORIZED,
            "MARKING_TOKEN_INVALID",
            "La identificación no tiene un vencimiento verificable. Vuelva a identificar.",
        )
    return TerminalVerifyResponse(
        verified=True,
        employee_id=employee.id,
        employee_name=f"{employee.first_name} {employee.last_name}".strip(),
        action=decoded["action"],
        device_id=device.id,
        expires_at=expires_at,
        server_time=now.astimezone(lima_tz()).isoformat(),
        marking_token=payload.marking_token,
    )


@router.post(
    "/recovery-requests",
    response_model=RecoveryRequestStatusOut,
    status_code=status.HTTP_201_CREATED,
)
def create_recovery_request(
    payload: RecoveryRequestCreate,
    request: Request,
    response: Response,
    db: Session = Depends(get_db),
) -> RecoveryRequestStatusOut:
    """Crea una solicitud durable; no autoriza ni registra asistencia.

    Acepta un token firmado aunque su ``exp`` haya vencido sólo para identificar
    el caso. Si el navegador no tiene cookie vigente, crea un contexto nuevo y
    lo devuelve para que la consulta posterior (GET) pueda probar la aceptación.
    """
    decoded = decode_attendance_token_for_recovery(payload.marking_token)
    if decoded is None:
        _domain_error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "RECOVERY_TOKEN_UNREADABLE",
            "La referencia no es una marcación firmada verificable. Consérvela y pida revisión manual; no se creó ninguna solicitud.",
        )
    nonce = str(decoded.get("nonce") or "")
    service = RecoveryService(db)
    device, _failure = _cookie_device(request, db)

    # Relectura idempotente: el mismo nonce+navegador devuelve su solicitud sin
    # consumir límites ni reescribir nada.
    if device is not None:
        existing = service.find_existing(nonce, device.id)
        if existing is not None:
            response.status_code = status.HTTP_200_OK
            return service.public_status(existing.id, device.id)

    _rate_limit(request, _recovery_limiter, key=f"ip:{client_ip(request)}")
    _rate_limit(request, _recovery_nonce_limiter, key=f"nonce:{nonce}")

    bootstrapped = False
    if device is None:
        draft_device_id = uuid.uuid4()
        device = DeviceService(db).create_anonymous(draft_device_id)
        response.set_cookie(
            value=create_terminal_token(str(device.id), device.token_version),
            **terminal_cookie_kwargs(),
        )
        bootstrapped = True
    _rate_limit(request, _recovery_device_limiter, key=f"device:{device.id}")

    record, created = service.create_request(
        marking_token=payload.marking_token,
        decoded=decoded,
        requester_device_id=device.id,
    )
    if not created:
        response.status_code = status.HTTP_200_OK
    elif bootstrapped:
        # La cookie recién emitida ya viaja en la respuesta; el GET posterior
        # demuestra que este navegador puede leer su propia solicitud.
        response.headers["X-Recovery-Cookie-Bootstrapped"] = "1"
    return service.public_status(record.id, device.id)


@router.get(
    "/recovery-requests/admin",
    response_model=list[RecoveryRequestAdminItem],
)
def list_recovery_requests(
    db: Session = Depends(get_db),
    _: object = Depends(can_manage_recovery),
    status_filter: str | None = Query(default=None, alias="status"),
    employee_id: uuid.UUID | None = Query(default=None),
    q: str | None = Query(default=None, max_length=80),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
) -> list[RecoveryRequestAdminItem]:
    return RecoveryService(db).list_admin(
        status_filter=status_filter,
        employee_id=employee_id,
        query=q,
        limit=limit,
        offset=offset,
    )


@router.get(
    "/recovery-requests/admin/{request_id}",
    response_model=RecoveryRequestAdminDetail,
)
def recovery_request_detail(
    request_id: uuid.UUID,
    db: Session = Depends(get_db),
    _: object = Depends(can_manage_recovery),
) -> RecoveryRequestAdminDetail:
    return RecoveryService(db).detail_admin(request_id)


@router.post(
    "/recovery-requests/admin/{request_id}/resolve",
    response_model=RecoveryRequestAdminDetail,
)
def resolve_recovery_request(
    request_id: uuid.UUID,
    payload: RecoveryRequestResolveRequest,
    db: Session = Depends(get_db),
    user=Depends(can_manage_recovery),
) -> RecoveryRequestAdminDetail:
    return RecoveryService(db).resolve(
        request_id,
        decision=payload.decision,
        reason=payload.reason,
        user_id=user.id,
    )


@router.get(
    "/recovery-requests/{request_id}",
    response_model=RecoveryRequestStatusOut,
)
def recovery_request_status(
    request_id: uuid.UUID,
    request: Request,
    db: Session = Depends(get_db),
) -> RecoveryRequestStatusOut:
    device, _failure = _cookie_device(request, db)
    if device is None:
        _domain_error(
            status.HTTP_404_NOT_FOUND,
            "RECOVERY_REQUEST_NOT_FOUND",
            "Solicitud no encontrada para este navegador.",
        )
    return RecoveryService(db).public_status(request_id, device.id)
