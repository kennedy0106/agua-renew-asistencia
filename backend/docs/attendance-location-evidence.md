# Asistencia: ubicación y evidencia sellada (backend core)

Implementación local de S1-S12. La migración es **aditiva y no ejecutada** en esta
tarea; la evidencia histórica permanece sin hora ni coordenadas fabricadas.

## Preparación explícita de ubicación

`POST /api/v1/attendance/attempt/prepare`

```json
{
  "marking_token": "<JWT de identificación>",
  "location": {
    "latitude": -12.046374,
    "longitude": -77.042793,
    "accuracy_m": 12.5,
    "age_ms": 1500
  }
}
```

- `latitude` ∈ [-90, 90], `longitude` ∈ [-180, 180], valores **finitos**.
- `accuracy_m` > 0 y ≤ 50 m (radio estimado reportado, no prueba física).
- `age_ms` ≥ 0 y ≤ 60 000 ms (antigüedad monotónica de una lectura recién
  adquirida; no es el reloj del dispositivo).
- Exige token vigente, trabajador activo y el mismo contexto de navegador
  (`did`).

Respuesta (200):

```json
{
  "marking_token": "<JWT renovado, mismo nonce/sub/acción/rid/did>",
  "marked_at": "2026-01-01T12:00:00+00:00",
  "expires_at": "2026-01-01T12:05:00+00:00",
  "location": {
    "latitude": -12.046374,
    "longitude": -77.042793,
    "accuracy_m": 12.5,
    "observed_at": "2026-01-01T11:59:58.500000+00:00",
    "address": null
  }
}
```

Reglas:

- `marked_at` lo fija el **servidor**; `expires_at = marked_at + 5 min` fijo.
- Es idempotente por `nonce`: repetir devuelve el mismo snapshot, hora y plazo,
  sin reemplazarlos.
- No crea asistencia, eventos ni contadores.
- Toda preparación **nueva** exige `did` firmado y contexto de navegador real
  (cookie de terminal) que coincidan; sin ellos responde `401` en cualquier
  entorno. No se admiten propietarios nulos (`None == None`).
- Antes de persistir valida el objetivo sin mutar nada: `CHECK_OUT` exige el
  registro `rid` abierto y del trabajador; `CHECK_IN` exige que no exista una
  entrada abierta. Si el estado cambió desde la identificación responde `409`
  y no deja snapshot obsoleto.
- Cuerpos con `NaN`/`Infinity` (JSON no estándar) o desbordes como `1e999` se
  rechazan localmente con `422` y un detalle fijo que nunca reexpone el valor
  no finito; no hay un 500 ni un manejador global nuevo.
- El token renovado conserva `nonce`/`sub`/`acción`/`rid`/`did` y su `iat`
  original; su `exp` es exactamente `expires_at`.
- No hay preparación automática en identify/evidence/check-in/check-out/status.

## Escritura firmada

`/evidence`, `/check-in` y `/check-out` con `marking_token` **exigen** una
preparación previa del mismo nonce, vigente y del mismo navegador; sin ella
responden `409` (ausente o vencida) o `401` (navegador distinto). El flujo local
por `employee_id` crudo (solo desarrollo) no la exige.
- El `expires_at` persistido se aplica de forma independiente al JWT: un token
  aún vigente no permite escribir con una preparación vencida.
- En `attempt/status`, una preparación vencida se reporta `EXPIRED_UNCONFIRMED`
  sin token de escritura, aunque el JWT presentado siga vigente; la recuperación
  confirmada de solo lectura se conserva intacta.

- `check_in_at`/`check_out_at`, `work_date`, eventos y snapshot de replay se
  derivan de `marked_at`, no de la hora de subida.
- En el JSON de `AttendanceRecordOut`, `check_in_at` y `check_out_at` se
  serializan siempre con zona UTC explícita (`Z`); una salida pendiente conserva
  `null`. Si SQLite devuelve una fecha sin zona, se aplica la semántica UTC de
  almacenamiento existente. Los valores con offset se convierten al mismo
  instante UTC. Esto solo afecta la salida JSON: no cambia la BD, los valores
  Python ni la serialización de `created_at`/`updated_at`. Los esquemas de
  validación y respuesta conservan ambos campos requeridos: `check_in_at` no
  admite `null`, mientras que `check_out_at` sí lo admite.
- La salida no puede ser anterior a la entrada (`409`).
- Una entrada preparada no puede comenzar antes del fin de una jornada ya
  cerrada del mismo trabajador, aunque ya no haya una entrada abierta. Se
  verifica bajo el mismo bloqueo del trabajador y responde `409` con:
  `La hora preparada es anterior a una jornada ya cerrada; cancele este intento e identifique de nuevo`.
  No se cambia la hora reservada, la foto original, el historial ni los
  contadores. La cancelación/reidentificación debe ser explícita; una nueva
  entrada posterior y sin solapamiento sigue permitida.
- Un `rid` obsoleto o un estado cambiado produce `409` sin escribir en otro
  registro.
- Un trabajador inactivo después de preparar no puede marcar (`403`).
- La dirección aproximada se resuelve una vez por confirmación nueva; su
  ausencia, cuota o caída no altera el resultado ni la hora.

## Recuperación acotada

`POST /api/v1/attendance/attempt/status` para el mismo navegador puede devolver,
mientras la preparación siga vigente, `marking_token` renovado y
`preparation` (mismo `marked_at`/`expires_at`/`location`). Nunca extiende el
plazo, no crea identidad/preparación ni ejecuta una escritura.

## Evidencia privada

- `GET /attendance/{record_id}/evidence` conserva sus claves y agrega
  `marked_at`, `location` (latitud, longitud, precisión, `observed_at`,
  `address`) y `stamped_available` por evento. Sin preparación quedan nulos
  (nada fabricado).
- `GET /attendance/evidence/{id}/image` sigue devolviendo los **bytes
  originales** con los roles ADMIN/BOSS.
- `GET /attendance/evidence/{id}/stamped-image` (JPEG) solo existe para
  evidencia **confirmada y preparada**. Se genera perezosamente desde el
  original y se lee/escribe en el **bucket de la fila** (`storage_bucket`), no en
  el bucket por defecto global; el hash/clave del original no cambian. Un fallo
  del sello devuelve `503` controlado y **nunca** la imagen original como si
  estuviera sellada, ni revierte/duplica la marcación.

## Configuración

`Settings.geoapify_api_key: str = ""`. Sin clave no hay red. La cuota es de
cuenta completa y queda como verificación previa a publicar; no se promete un
presupuesto global.
