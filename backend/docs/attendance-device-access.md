# Acceso de dispositivos a la marcación pública

Este documento describe el comportamiento vigente del backend local. No autoriza
producción, despliegues ni cambios de esquema; no afirma nada sobre entornos
desplegados.

## Contexto de navegador automático

La marcación pública (`DNI/código/QR + foto`, sin login) está disponible desde
cualquier navegador. Ya no existe aprobación previa de equipos.

- `POST /api/v1/attendance/identify` reutiliza la cookie firmada
  (`agua_renew_terminal`) si el contexto sigue vigente. En ese caso no escribe
  ningún dispositivo.
- Si la cookie falta, venció, fue manipulada o su contexto fue revocado, el
  backend prepara un dispositivo anónimo con un UUID explícito. Solo si la
  identificación del trabajador es exitosa (trabajador existente y activo)
  persiste ese dispositivo y emite la cookie `HttpOnly`, `SameSite` según
  `SESSION_COOKIE_SAMESITE` y `Secure` según `SESSION_COOKIE_SECURE`.
- Una identificación fallida (trabajador inexistente o inactivo) no crea
  dispositivos, no emite cookie y no modifica contadores de asistencia.
- El identificador del dispositivo se incorpora al token de marcación para que
  las etapas posteriores verifiquen la pertenencia.

## Rutas posteriores

`/evidence`, `/check-in`, `/check-out`, `/attempt/status` y `/attempt/resolve`
siguen exigiendo el contexto del navegador. Un intento confirmado solo se puede
consultar o resolver desde el mismo dispositivo que lo produjo. Un `401` en
estas rutas nunca renueva ni reescribe la cookie: no hay auto-renovación desde
intentos, consultas, evidencia ni resolución. El contexto revocado no revive con
un identificador nuevo, y un intento pendiente no se transfiere a la identidad
nueva.

## Emparejamiento retirado

Devuelven `HTTP 410` sin mutaciones:

- `POST /api/v1/attendance/terminal/pair`
- `POST /api/v1/devices` (creación manual de terminal)
- `POST /api/v1/devices/{id}/pairing-code`

El router de dispositivos mantiene la autenticación ADMIN y conserva:

- `GET /api/v1/devices` — historial de contextos de marcación.
- `POST /api/v1/devices/{id}/revoke` — invalida el contexto vigente (no borra
  filas ni campos históricos).

Los campos históricos de emparejamiento (`pairing_code_hash`,
`pairing_expires_at`) y las columnas de propiedad de evidencia/nonce quedan
intactos para auditar datos previos; no se ejecuta limpieza destructiva.

## Referencias

- `backend/tests/test_public_attendance_devices.py` — flujo público en
  producción, reutilización, aislamiento entre navegadores, cookie manipulada o
  vencida, revocación, retiro del pairing e invalidación sin persistencia.
- `backend/tests/test_attendance_hardening.py` — evidencia, nonce, intentos,
  pertenencia, recuperación y permisos administrativos.
