# Ubicación obligatoria y evidencia con sello (frontend React)

Estado: implementación local, sin despliegue ni migraciones ejecutadas.

Este documento describe el contrato de interfaz que acompaña a los cambios de
backend de la tarea `odd/tasks/attendance-location-evidence.md` (specs S1-S13).

## 1. Lectura puntual de ubicación antes de identificar

- Al enviar el DNI o al leer un código QR se pide **una** lectura de ubicación
  (`navigator.geolocation.getCurrentPosition`) antes de llamar a
  `POST /api/v1/attendance/identify`. Nunca se usa `watchPosition` ni
  seguimiento continuo.
- Parámetros: `enableHighAccuracy: true`, `maximumAge: 0`, `timeout: 20000` y un
  plazo propio de 20 s por si el navegador no responde.
- Se acepta cualquier zona geográfica (S10) pero sólo lecturas con precisión
  reportada positiva y `<= 50 m` (S11). Las coordenadas deben ser finitas y
  estar en rango.
- El recuerdo del permiso no prueba disponibilidad: si el empleado ya autorizó
  la web pero el equipo no entrega posición, la marcación se bloquea.
- Denegado, no disponible, tiempo agotado o precisión insuficiente **bloquean**
  sin llamada al API, sin cámara y sin escritura, con mensaje accionable en
  español y reintento (volver a pulsar "Identificar asistencia").

Mensajes (se muestran en `data-testid="kiosk-location-error"`):

| Motivo | Mensaje |
| --- | --- |
| Permiso denegado | El navegador bloqueó el acceso a la ubicación. Habilite el permiso de ubicación para este sitio y vuelva a intentar la marcación. |
| Plazo agotado | La ubicación tardó más de 20 segundos. Acerque el equipo a una zona con mejor señal y vuelva a intentar. |
| Precisión insuficiente | La ubicación recibida no es suficientemente precisa (máximo 50 metros). Espere unos segundos y vuelva a intentar. |
| Navegador sin soporte | Este navegador no puede obtener la ubicación del equipo. Use un dispositivo con ubicación habilitada para marcar asistencia. |
| Otro error | No se pudo obtener la ubicación del equipo. Revise que la ubicación esté habilitada y vuelva a intentar la marcación. |

No se diagnostica "GPS apagado" ante errores genéricos.

## 2. Edad de la lectura

- La antigüedad se mide con reloj monótono (`performance.now`) desde el instante
  en que llegó el callback, no con la hora del equipo.
- Si antes de preparar la ubicación supera `60_000` ms, se pide una lectura
  nueva.
- `age_ms` viaja al servidor dentro de la preparación; es el único valor de
  antigüedad y no es una hora autoritativa.

## 3. Preparación y subida de la foto

Orden exacto por operación (entrada o salida):

1. Lectura de ubicación puntual (arriba) y `identify`.
2. Foto local (`canvas` → JPEG base64). Si la captura falla, no hay escritura.
3. `POST /api/v1/attendance/attempt/prepare` con
   `{marking_token, location: {latitude, longitude, accuracy_m, age_ms}}`.
   No se llama a `prepare` automáticamente en `identify`, `evidence`, escritura
   ni consulta.
4. Se persiste en `sessionStorage` la referencia del intento con el **token
   renovado** y la etapa `PREPARED` **antes** de subir la imagen (no se guardan
   coordenadas precisas en el navegador; el snapshot vive en el servidor).
5. `POST /api/v1/attendance/evidence` con el token renovado.
6. `check-in` / `check-out` con el mismo token.

La hora oficial (`marked_at`) y el vencimiento fijo de 5 minutos
(`expires_at`) los fija el servidor en la preparación; reintentar no reserva una
hora ni una identidad nuevas.

Resultados desconocidos (prepare, subida o escritura) se reconcilian con
`POST /api/v1/attendance/attempt/status` sobre el **mismo** intento; nunca se
crea una identidad nueva a ciegas. Ese DTO devuelve
`marking_token: string | null` y `preparation: {marked_at, expires_at, location} | null`
(el snapshot va **anidado**, no como claves planas).

Reglas fail-closed del navegador:

- Un token renovado sólo se adopta si es la **misma cadena** que el vigente o si
  ambos exponen el **mismo nonce JWT no vacío**. Un reemplazo ausente (`null`),
  malformado o de otro intento nunca sustituye al token actual: no se sube la
  foto ni se marca bajo él y la referencia del intento original se conserva para
  reconciliarla.
- La recuperación con `PENDING` aplica la misma regla antes de adoptar cualquier
  `marking_token`; el `preparation` anidado habilita el mensaje "la ubicación y
  la hora oficial ya quedaron reservadas, pero la marcación aún no se registró"
  cuando todavía no hay foto.
- La firma la valida el backend: el navegador sólo compara el nonce.

## 4. Visor privado de evidencia (AdminAttendancePage)

- `GET /api/v1/attendance/{record_id}/evidence` mantiene sus claves antiguas y
  añade `marked_at`, `location` (`latitude`, `longitude`, `accuracy_m`,
  `observed_at`, `address`) y `stamped_available`.
- La imagen original sigue en `GET /api/v1/attendance/evidence/{id}/image`.
- La versión sellada se pide a
  `GET /api/v1/attendance/evidence/{id}/stamped-image` (JPEG privado)
  únicamente cuando `stamped_available` es verdadero. Si el derivado falla, se
  conserva el original.
- La evidencia nueva muestra el sello, la hora oficial, coordenadas, precisión
  reportada y dirección aproximada, con enlace **solo-texto** a Google Maps:
  `https://www.google.com/maps/search/?api=1&query=<lat>%2C<lon>` en pestaña
  nueva con `rel="noopener noreferrer"`. No se incrusta mapa, no se llama a un
  geocodificador desde el navegador y la URL no incluye empleado, DNI, foto ni
  token.
- Cada figura declara qué versión muestra ("Versión con sello" o "Versión
  original (sin sello)") y el original siempre es visible y descargable, incluso
  cuando el sello existe. Cuando el sello está anunciado (`stamped_available`)
  pero el derivado no carga, se muestra un aviso visible y la imagen queda
  etiquetada como original: nunca se hace pasar una foto cruda por sellada. Solo
  se ofrece descarga del derivado cuando el sello se obtuvo.
- La evidencia histórica se muestra como original con
  "Ubicación no disponible para este registro." y **sin** enlace de mapas ni
  datos inventados; no tener preparación/sello no es un error.
- Roles sin cambios: el visor sigue disponible para ADMIN/BOSS.

## 5. Pruebas

- `src/lib/__tests__/attendance-location.test.ts`: contrato HTTP de `prepare`,
  DTO real de recuperación (`marking_token` + `preparation` anidado), límites de
  antigüedad/precisión, plazo propio de 20 s y endpoint privado del sello.
- `src/pages/__tests__/AsistenciaPage.test.tsx`: bloqueo por ubicación, límite
  de 50 m, orden prepare→evidencia→marcación, token renovado persistido antes de
  la subida, renovación pasados 60 s, reconciliación sin duplicados y fail-closed
  ante tokens renovados de otro nonce, ausentes o sin nonce.
- `src/pages/__tests__/AdminAttendancePage.test.tsx`: sello, hora oficial,
  coordenadas/enlace de Maps, original descargable, evidencia histórica y
  contexto de autorización.
- Los specs E2E siguen sin backend real para la suite UI: emulan geolocalización
  con Playwright y preparan la marcación con el mismo token y snapshot.
