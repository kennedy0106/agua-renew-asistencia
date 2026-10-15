# Ensayo aislado de tablet (HTTPS)

Este procedimiento prepara un ensayo funcional local con datos ficticios. No autoriza producción, pagos, Neon, R2, despliegues ni eliminación de datos. La prueba física queda pendiente de quien opere la tablet.

## Límites y prerrequisitos

- Use PostgreSQL desechable `asistencia_test` y MinIO local en loopback. No reutilice `DATABASE_URL` ni buckets de otro entorno.
- Antes de arrancar, compruebe sin detener procesos ajenos que `127.0.0.1:5433` (PostgreSQL) y `127.0.0.1:9002` (MinIO) responden. No publique PostgreSQL, MinIO ni su consola en la LAN.
- La tablet requiere HTTPS confiable para la cámara. Instalar una CA/certificado, modificar firewall o crear un túnel requiere autorización específica previa. No ignore advertencias TLS ni desactive verificaciones.
- GitHub Actions permanece sin ejecutar por cuota; esta guía usa validación local.

## Datos de ensayo (ficticios)

Inicie sesión como el administrador ficticio que crea el seed: `admin` / `Admin123!`. Es una credencial de entorno desechable; no la reutilice fuera de él. El seed crea el cargo `Operario` y exactamente estos dos empleados, con QR aleatorio, jornada y sueldo; no cree sustitutos manuales:

| Empleado | DNI ficticio | Código | Jornada inicial | Sueldo de ensayo |
|---|---:|---|---|---:|
| Ana Prueba Norte | 10000001 | `TBL-ANA-01` | L–V 480 min, refrigerio 60 tras 360 min | S/ 1,500.00 |
| Bruno Prueba Sur | 10000002 | `TBL-BRU-02` | L–V 480 min, refrigerio 60 tras 360 min | S/ 1,650.00 |

El seed configura para ambos `effective_from` igual a su fecha de ejecución, `overtime_enabled=false`, jornada L–V y los importes indicados. Son solo datos de prueba y no alteran reglas salariales.

El código se prueba introduciendo `TBL-ANA-01` o `TBL-BRU-02`. Para QR, inicie sesión ADMIN, abra `/admin/employees`, localice cada código y copie su UUID desde el detalle o la URL de ese empleado. Con ese UUID obtenga `GET /api/v1/employees/{id}/qr`: genera el SVG existente cuyo contenido es `AR:<token-aleatorio>`. Ábralo o imprímalo para la tablet; no invente ni cambie el token. Si rota el QR, vuelva a descargarlo.

## Arranque local y validación previa

En PowerShell, desde la raíz del repositorio, arranque únicamente los dos contenedores de ensayo y compruebe sus puertos sin detener ningún otro servicio:

```powershell
docker start asistencia-test-pg asistencia-test-minio
Test-NetConnection 127.0.0.1 -Port 5433 -InformationLevel Quiet
Test-NetConnection 127.0.0.1 -Port 9002 -InformationLevel Quiet
```

Ambas comprobaciones deben devolver `True`. Defina después únicamente valores locales de prueba (reemplace marcadores; no pegue secretos productivos):

```powershell
$env:ALLOW_TEST_DB_RESET = '1'
$env:TEST_DATABASE_URL = 'postgresql+psycopg://<usuario>:<clave>@127.0.0.1:5433/asistencia_test'
$env:OBJECT_STORE_ENDPOINT = 'http://127.0.0.1:9002'
$env:OBJECT_STORE_BUCKET = 'asistencia-evidence-test'
$env:OBJECT_STORE_ACCESS_KEY = '<acceso-local>'
$env:OBJECT_STORE_SECRET_KEY = '<secreto-local>'
uv run --project backend -- python scripts/verify_local.py
```

El verificador exige explícitamente esos destinos, aprovisiona su bucket de prueba y limpia solo el prefijo de su ejecución. Si termina correctamente, aplique el esquema y el seed al mismo entorno para el ensayo:

```powershell
Push-Location backend
$env:DATABASE_URL = $env:TEST_DATABASE_URL
$env:DATABASE_URL_UNPOOLED = $env:TEST_DATABASE_URL
uv run alembic upgrade head
uv run python -m scripts.seed_e2e_kiosk
uv run python -c "from app.core.object_store import provision_test_bucket; provision_test_bucket()"
$env:OBJECT_STORE_CREATE_BUCKET = '0'
$env:FRONTEND_URL = 'https://192.168.18.141:8443'
$env:SESSION_COOKIE_SECURE = 'true'
$env:SESSION_COOKIE_SAMESITE = 'lax'
uv run uvicorn app.main:app --host 127.0.0.1 --port 18000
Pop-Location
```

En otra consola, construya y sirva el frontend con exactamente el mismo origen visible para la tablet; `NEXT_PUBLIC_API_URL` debe ser la raíz, no `127.0.0.1`, ni `/api`, ni una segunda URL:

```powershell
Push-Location frontend
$env:NEXT_PUBLIC_API_URL = 'https://192.168.18.141:8443'
npm run build
npx next start --hostname 127.0.0.1 --port 13000
Pop-Location
```

El proxy HTTPS nativo local, una vez autorizado y configurado, debe publicar un solo origen y enrutar `/` a `127.0.0.1:13000` y `/api/v1/...` a `127.0.0.1:18000`. La URL concreta condicional de la tablet es `https://192.168.18.141:8443/asistencia`: antes de usarla, revalide que esa sea la IP Wi-Fi actual y que el certificado incluya exactamente esa IP en su SAN. El proxy, certificado y cambio de firewall siguen pendientes de autorización específica; Caddy y mkcert no están instalados, por lo que no se inventan comandos de instalación todavía. Mantenga `SESSION_COOKIE_SECURE=true` y `SESSION_COOKIE_SAMESITE=lax` como en el bloque de arranque.

Desde la PC, el administrador crea el terminal en `/api/v1/devices`, obtiene el código de un uso y en la tablet abre solo `/asistencia` para emparejarse. No inicie sesión ADMIN en la tablet. El proxy es el único servicio visible en LAN; FastAPI sigue en `127.0.0.1:18000`, frontend en `127.0.0.1:13000` y MinIO/PostgreSQL en loopback.

## Matriz del ensayo físico (pendiente)

Registre SHA servido, origen HTTPS, hora Lima, modelo de tablet y versión de Android/navegador; adjunte solo referencias de evidencia, no fotos. Registre cada incidente con T, empleado ficticio, código HTTP, hora y si el objeto quedó en MinIO.

| ID | Acción | Aceptación |
|---|---|---|
| T1 | Abrir `/asistencia` | HTTPS sin alerta, API y permisos disponibles. |
| T2 | Emparejar | Cookie de terminal; sin sesión ADMIN. |
| T3 | Entrada con código Ana | Persona correcta, frontal, contador, una foto y entrada. |
| T4 | Salida con código Ana | Foto nueva, salida correcta; evidencia de entrada conservada. |
| T5 | QR Bruno | Lee QR, detiene cámara lectora y habilita frontal. |
| T6 | Cancelar/doble toque | No cruza empleados ni duplica evento/cámara. |
| T7 | Cortar red tras enviar | No afirma éxito o fracaso sin reconciliar el intento. |
| T8 | Recargar/consultar | Recupera el mismo intento sin crear acción contraria. |
| T9 | Foto sin completar | Continúa o informa resolución controlada, sin bloqueo permanente. |
| T10 | Revisar en PC | ADMIN/BOSS ve foto correcta; consultar no modifica marcaciones. |
| T11 | Reiniciar navegador/tablet | Registra qué persiste; no presupone `sessionStorage`. |
| T12 | Otro navegador sin autorizar | Rechazo conforme a política de terminal, sin salario ni evidencia. |

## Parada y limpieza

Detenga únicamente FastAPI y Next iniciados para este ensayo con `Ctrl+C` en sus consolas. Luego detenga únicamente sus dos contenedores de ensayo:

```powershell
docker stop asistencia-test-pg asistencia-test-minio
```

Después, revise registros y borre las fotos de prueba mediante el procedimiento local autorizado; no ejecute borrados masivos ni toque MinIO, PostgreSQL o datos ajenos. Si se autorizó una CA de desarrollo, retire de la tablet el certificado público de confianza al terminar; nunca copie ni publique su clave privada.
