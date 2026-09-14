# Ensayo de kiosco en tablet (HTTPS, datos aislados)

Esto prepara una prueba funcional con empleados y fotos ficticios. **No habilita
el sistema como registro único de asistencia ni autoriza un despliegue.**

No crear certificados públicos, túneles, buckets R2, proyectos Neon ni
publicar MinIO hasta una autorización explícita aparte. Este documento no
ejecuta esos pasos.

## Condiciones que ya deben cumplirse en código

- Terminal emparejado (`agua_renew_terminal`, HttpOnly). La tablet no es
  administrador: el panel de revisión sigue en un rol ADMIN/BOSS.
- Cámara real: el kiosco llama a `getUserMedia`. El navegador exige un
  [contexto seguro](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia)
  (HTTPS válido o `localhost`). HTTP hacia la IP de la PC no basta.
- Fotos nuevas van a un almacén S3-compatible privado. El frontend no recibe
  credenciales ni URLs públicas del bucket.
- Consultar un intento no sube foto. Cancelar no borra una marcación
  confirmada.

## Entorno aislado (local)

Usar solo destinos desechables. No copiar empleados, sueldos ni fotografías
productivas.

| Recurso | Destino de ensayo | Prohibido |
|---|---|---|
| PostgreSQL | `asistencia_test` en loopback (p. ej. `:5433`) | Neon / `DATABASE_URL` productiva |
| Objetos | MinIO local, bucket `asistencia-evidence` o `asistencia-evidence-test` | R2 productivo u otro bucket no autorizado |
| Seed | `uv run python -m scripts.seed_e2e_kiosk` con `ALLOW_TEST_DB_RESET=1` y `TEST_DATABASE_URL` validada | Seeds en producción |
| Verificación previa | `scripts/verify_local.py` | Reintentar GitHub Actions por cuota |

El arranque de FastAPI de ensayo lleva `OBJECT_STORE_CREATE_BUCKET=0` tras
aprovisionar el bucket en el harness. No publicar el puerto de MinIO a
Internet.

## HTTPS en la tablet (cuando se autorice el ensayo)

Objetivo: un **origen HTTPS único** para kiosco y API, de modo que la cookie
siga `SameSite=lax` y no haga falta `SameSite=none`.

Esquema recomendado (proxy local, sin nube):

1. Instalar una CA local en la PC y en la tablet (p. ej. mkcert). El
   certificado debe coincidir con el nombre que escribe la tablet
   (`asistencia-test.lan` o similar), no solo con una IP.
2. Servir Next y FastAPI detrás del mismo host HTTPS:
   - `https://<nombre>/` → frontend
   - `https://<nombre>/api` → backend, o `NEXT_PUBLIC_API_URL` apuntando al
     mismo host si el proxy no unifica la ruta.
3. Variables mínimas del ensayo (valores de prueba, no secretos productivos):
   - `FRONTEND_URL=https://<nombre>` (CORS de development también honra este origen)
   - `NEXT_PUBLIC_API_URL=https://<nombre-api>` (mismo sitio si hay proxy)
   - `SESSION_COOKIE_SECURE=true`
   - `SESSION_COOKIE_SAMESITE=lax` si el origen es único
4. Si API y kiosco quedan en hosts distintos, las cookies son cross-site:
   hace falta `SESSION_COOKIE_SAMESITE=none` y `SESSION_COOKIE_SECURE=true`.
   Preferir el proxy del punto 2 antes de relajar SameSite.
5. Emparejar el terminal desde el panel en un navegador de la PC (ADMIN).
   En la tablet abrir solo `/asistencia`. No iniciar sesión de administrador
   en la tablet para «facilitar» la prueba.

No usar ngrok, Cloudflare Tunnel, Tailscale Funnel ni un certificado público
hasta que alguien autorice el gasto y el alcance de red.

## Recorrido esperado

El trabajador de prueba y el código QR deben ser los del seed aislado.

| Ensayo | Resultado esperado |
|---|---|
| Código de prueba | Trabajador correcto y acción (entrada o salida) correspondiente. |
| QR con cámara | Lectura y paso a la frontal; la cámara posterior se detiene. |
| Entrada y salida | Dos fotos distintas, eventos correctos, sin duplicar el mismo nonce. |
| Cancelar y doble toque | No se cruzan intentos ni aparecen capturas tardías. |
| Red interrumpida después de enviar | Se consulta el intento original; no se crea sola la acción contraria. |
| Recargar sin foto en memoria | Recuperación sin nueva captura. |
| Revisión del jefe | Solo ADMIN/BOSS, con auditoría; la evidencia se conserva. |
| Reiniciar navegador/tablet | Cookie del terminal, permisos de cámara y recuperación según el procedimiento real. |

Anotar fallos con hora, empleado ficticio, código HTTP y si la foto quedó en
MinIO. No extraer JPEG reales del ensayo a un canal no controlado.

## Después del ensayo

Una prueba autorizada contra R2 real es otro procedimiento (token limitado al
bucket de ensayo, sin copiar fotos productivas). El piloto con registro de
respaldo, el cotejo salarial y la política de conservación de fotos
confirmadas siguen fuera de este documento.
