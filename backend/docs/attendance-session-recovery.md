# Sesión verificada y recuperación supervisada (2026-10-22)

Contrato aditivo para que el kiosco compruebe su sesión antes de abrir la
cámara y para que un intento bloqueado pueda recuperarse con autorización de un
jefe. No cambia GPS (50 m), edad de lectura (60 s), foto obligatoria, hora
oficial, permisos ni reglas laborales.

## 1. `POST /api/v1/attendance/terminal/verify`

Público. Se llama **después de `identify` y antes de la cámara**. No escribe
asistencia, eventos, evidencia ni preparación, y **no renueva ni extiende** el
token de marcación: devuelve el mismo token y su `exp` original.

Request:

```json
{ "marking_token": "<jwt de identify>" }
```

Response `200`:

```json
{
  "verified": true,
  "employee_id": "uuid",
  "employee_name": "Ana López",
  "action": "CHECK_IN",
  "device_id": "uuid",
  "expires_at": "2026-10-22T17:45:00Z",
  "server_time": "2026-10-22T17:43:10-05:00",
  "marking_token": "<mismo jwt>"
}
```

Errores estructurados (`detail = {code, message}`), todos distinguibles:

| HTTP | code | significado |
| --- | --- | --- |
| 401 | `TERMINAL_COOKIE_MISSING` | la petición no trajo `agua_renew_terminal` |
| 401 | `TERMINAL_SESSION_INVALID` | cookie ilegible, vencida o de un contexto inexistente |
| 401 | `TERMINAL_SESSION_REVOKED` | dispositivo inactivo o `token_version` distinto |
| 401 | `MARKING_TOKEN_EXPIRED` | firma válida pero `exp` vencido |
| 401 | `MARKING_TOKEN_INVALID` | firma/estructura/tipo inválidos o empleado inexistente |
| 401 | `MARKING_TOKEN_NOT_BOUND` | token sin `did` firmado (no demuestra navegador) |
| 401 | `MARKING_TOKEN_FOREIGN_DEVICE` | `did` distinto de la cookie actual |
| 403 | `EMPLOYEE_INACTIVE` | trabajador cesado |

El frontend usa un plazo total de 10 s. Si falla, conserva el identificador
escrito y **no** abre cámara, no guarda foto, no crea intento pendiente y no
envía marcación. El mensaje de cookie ausente afirma sólo lo observable: el
navegador no envió la cookie; no diagnostica por sí solo un bloqueo del
navegador.

## 2. `POST /api/v1/attendance/recovery-requests`

Público. Crea una solicitud durable para un intento bloqueado. Acepta el token
firmado aunque su `exp` haya vencido **sólo para identificar el caso**; nunca
autoriza una marcación ni emite credencial nueva. Si el navegador no tiene
cookie vigente, crea un contexto anónimo y emite `agua_renew_terminal` en la
misma respuesta; el `GET` posterior demuestra la aceptación.

Request: `{ "marking_token": "<jwt>" }`

Response `201` (o `200` si ya existía la misma solicitud nonce+navegador):

```json
{
  "id": "uuid",
  "status": "PENDING",
  "requested_at": "...",
  "resolved_at": null,
  "reason": null,
  "can_reidentify": false,
  "confirmation": null
}
```

Reglas:

- Idempotencia por `(nonce, requester_device_id)`; dos navegadores pueden crear
  solicitudes distintas para el mismo nonce y la resolución las cierra a todas.
- Límites en memoria: 30 solicitudes/hora por IP (una oficina con NAT no
  queda bloqueada por cinco empleados), 5/hora por navegador solicitante y
  3/hora por nonce. La relectura idempotente del mismo nonce+navegador no
  consume límites.
- `token_sha256` es la única huella persistida; el JWT completo no se guarda.
- `iat`/`exp` se convierten desde epoch numérico a UTC; si no son convertibles
  quedan nulos (no se inventa fecha).
- Token con firma/estructura inválida: `422 RECOVERY_TOKEN_UNREADABLE`. No se
  crea fila ni se confía en DNI o metadatos locales; el navegador conserva la
  referencia para revisión manual.
- Empleado inexistente: `404 RECOVERY_EMPLOYEE_NOT_FOUND`.

## 3. `GET /api/v1/attendance/recovery-requests/{id}`

Sólo el navegador solicitante (`requester_device_id` de la cookie vigente).
Cualquier otro navegador recibe `404 RECOVERY_REQUEST_NOT_FOUND`. Respuesta
mínima: `id`, `status`, `requested_at`, `resolved_at`, `reason`,
`can_reidentify` y, si ya había confirmación, `confirmation` reducida. No hay
polling: el botón "Consultar solicitud" hace una lectura explícita.

## 4. Panel ADMIN/BOSS

- `GET /api/v1/attendance/recovery-requests/admin?status=&employee_id=&q=&limit=&offset=`
- `GET /api/v1/attendance/recovery-requests/admin/{id}`
- `POST /api/v1/attendance/recovery-requests/admin/{id}/resolve`

Listado/detalle incluyen empleado, acción, dispositivo original y solicitante,
fechas, motivo, responsable y una inspección del intento:

- `preparation`: snapshot de hora/ubicación si existe.
- `evidence`: existencia, fecha, tipo y vínculo al registro.
- `consumed`: consumo del nonce y confirmación real.
- `resolution`: resolución durable previa.
- `record`: confirmación contrastada contra `attendance_records`.

Estados: `EMPTY` (nonce firmado sin filas), `PREPARATION_ONLY`,
`EXPIRED_UNCONFIRMED`, `EVIDENCE_ONLY`, `CONFIRMED`, `CANCELLED`, `REVIEWED`,
`INCONSISTENT`, `UNVERIFIABLE_BROWSER`.

`resolve` exige `reason` visible (3–500 caracteres) y `decision`:

- `AUTHORIZE_REIDENTIFY`: bajo el lock del empleado, crea una única
  `AttendanceAttemptResolution(CANCELLED_UNCONFIRMED)` con actor y motivo y
  cierra todas las solicitudes pendientes del mismo nonce. El envío tardío del
  nonce viejo queda rechazado (check-in/out/evidence comprueban la resolución
  bajo el mismo lock).
- `CONFIRM_EXISTING`: devuelve la confirmación ya existente sin editar horas ni
  evidencia; marca la solicitud `CONFIRMED_EXISTING`.
- `REJECT`: cierra la solicitud `REJECTED` sin crear resolución de intento.

Un intento `INCONSISTENT` (payload y registro real no coinciden, empleado,
acción, dispositivo o evidencia discrepan, o hay confirmación y cancelación
incompatibles) **no es aprobable** y requiere corrección manual. Un token sin
`did` demostrable queda `UNVERIFIABLE_BROWSER` y tampoco se autoriza
automáticamente. La resolución conserva `original_device_id`; nunca se sustituye
por el solicitante.

Cada creación y resolución se audita con actor, motivo, nonce y referencia.

## 5. Modelo y migración

Tabla nueva `attendance_recovery_requests` (migración
`v8d9e0f1a2b3`, `down_revision = u7c8d9e0f1a2`). Es aditiva y sin backfill:
no altera asistencias, evidencias, preparaciones ni resoluciones históricas.
El `downgrade` se niega a borrar el historial auditable; una reversión exige una
operación manual revisada y respaldada. El runtime no ejecuta migraciones; el
despliegue aplica la migración en un paso separado después de comparar la
revisión real y el respaldo.

## 6. Compatibilidad

Los endpoints existentes (`identify`, `prepare`, `evidence`, `check-in`,
`check-out`, `attempt/status`, `attempt/resolve`, panel) no cambian de contrato.
Un backend con esta migración y rutas sirve primero; el frontend que usa
`terminal/verify` y recuperación se despliega después.
