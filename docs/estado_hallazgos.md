# Estado de hallazgos (H01–H07, CDB-01–CDB-03, R45, EDB-01–EDB-03 y E506-01–E506-02)

Documento de seguimiento. No certifica seguridad global ni exactitud de toda la nómina.

## H01–H07 (base `cdb0836` y posteriores)

| ID | Estado | Qué queda |
|---|---|---|
| H01 | Cerrado | Ajuste salarial con `FOR UPDATE` sin `joinedload`; pruebas PostgreSQL de bono y 409. |
| H02 | Parcialmente resuelto | Evidencia idempotente, `/attempt/status` y recuperación con token corto vencido. R45-02 exige terminal autenticado y `device_id` coincidente; EDB-02 añade resolución durable y revisión ADMIN/BOSS. Falta el recorrido en tablet física. |
| H03 | Parcialmente resuelto | Generación y bloqueos; R45-03 conserva el intento enviado. EDB-01 separa consultar de reenviar. Pruebas UI con API simulada y suite de integración local. Falta tablet física. |
| H04 | Implementado; ampliar evidencia | `UPDATE` condicional por hash y canje simultáneo en PostgreSQL. |
| H05 | Parcialmente resuelto | Límites antes de `load()` y EXIF; CDB-03 cubre bombas de descompresión en `Image.open()`. |
| H06 | Implementado en código | Vista QR e identificación automática. Pendiente tablet física (detector, cámaras, luz). |
| H07 | Corregido en código | `max_age` alineado a `terminal_token_days`. Pendiente cookie real en dominios de despliegue. |

## CDB-01–CDB-03

| ID | Estado | Pendiente físico |
|---|---|---|
| CDB-01 | Recuperación con token vencido, plazo `attempt_recovery_minutes`, pertenencia demostrable | Recorrido en tablet con corte de red real |
| CDB-02 | Cancelación no reenvía ni desbloquea otro intento | Doble toque y QR en tablet |
| CDB-03 | Rechazo 422 en apertura y carga, incluidos umbrales de Pillow | Ninguno específico de tablet |

## R45 (base `45d414b`)

| ID | Corrección | Prueba | Resultado previsto | Pendiente |
|---|---|---|---|---|
| R45-01 | Se retiró `isE2eKiosk` / `__E2E_KIOSK`, el salto de cuenta regresiva y el JPEG sintético. Sin fotograma válido no hay evidencia ni marcación. | Bundle sin `__E2E_KIOSK`; harness de cámara con MediaStream; countdown real | Cerrado en código y CI de UI | Tablet física |
| R45-02 | `/attempt/status` exige terminal vigente, `did` firmado y `consumed.device_id` coincidente. Pertenencia nula se deniega sin backfill. Escrituras siguen con `decode_attendance_token`. | Pytest de recuperación, otro/revocado/ausente/nulo; Alembic con nonces previos | Cerrado en pruebas locales | Recorrido en tablet |
| R45-03 | Intento enviado se persiste en `sessionStorage` (token + acción + empleado; sin cookie ni foto). «Tomar otra foto» recaptura el mismo intento; cancelar no borra una asistencia confirmada. | UI de carreras + integración con respuesta perdida tras commit real | Cerrado en Chromium de escritorio | Corte de red real en tablet |
| R45-04 | Suite UI (API simulada) + integración Chromium/Next/FastAPI/Postgres desechable con Alembic | `npm run test:e2e` y `npm run test:e2e:integration` en CI | Debe ejecutarse en la rama; falla si falta el entorno | No declara tablet física |

## EDB-01–EDB-03 (sobre `edbfcbc`)

| ID | Corrección | Prueba | Pendiente |
|---|---|---|---|
| EDB-03 | `seed_e2e_kiosk` exige `TEST_DATABASE_URL` validada; no usa `SessionLocal` ni `DATABASE_URL`. | `test_seed_e2e_kiosk.py` con destinos ficticios locales | Ninguno de seed en Neon |
| EDB-01 | `consultAttempt()` es lectura; `kiosk-consult-attempt` no llama a `sendPhoto`. Recarga sin foto local. | UI f/g + integración T01/T02 | Tablet física |
| EDB-02 | Tabla `attendance_attempt_resolutions`, lock de empleado, `/attempt/resolve`, revisión ADMIN/BOSS, completar evidencia existente. | Hardening, concurrencia A/B, Alembic `e1f2a3b4c5d6`→`f2a3b4c5d6e7`, T03–T11 | Tablet física y despliegue autorizado |

## E506-01–E506-02 (sobre `e506ada`)

| ID | Corrección | Prueba | Pendiente |
|---|---|---|---|
| E506-01 | `AttendanceAttemptResolution.reason` y migración nueva `g3b4c5d6e7f8` (80→500). Schema y panel alineados a 500. No se edita `f2a3b4c5d6e7`. | Alembic PG (80/81/120/500, rechazo 501, downgrade sin recorte), HTTP SQLite y PostgreSQL | Tablet física |
| E506-02 | `attempt_status` y `resolve_attempt` comprueban existencia, no `active`. Nuevas marcaciones/evidencia siguen 403 si el empleado está inactivo. | Hardening A06–A10 e integración A06–A08 | Tablet física |

## CD10-01–CD10-04 (sobre `cd10b33`)

| ID | Corrección | Prueba | Pendiente |
|---|---|---|---|
| CD10-01 | `verify_local` exige `ALLOW_TEST_DB_RESET=1`, valida destinos desechables y fuerza las tres URLs de BD. Live S3 rechaza R2 y usa keys UUID. | `test_verify_env.py`, live S3 | R2 real con procedimiento aparte |
| CD10-02 | Purge exige `CANCELLED_UNCONFIRMED`, lock de empleado y antigüedad ≥ 24 h. Marcación nueva comprueba el objeto. | Hardening + concurrencia PG | Tablet física |
| CD10-03 | Errores 404 vs 503, timeouts 3 s / 8 s / 2 intentos, bucket precreado en producción. | Fake client + HTTP 503 | Token R2 limitado al bucket |
| CD10-04 | `storage_backend` / `storage_bucket` / `byte_size`; PUT+SQL y backfill bloqueado. Migración `i5d6e7f8a9b0`. | Alembic + object_store | Backfill explícito de keys huérfanas |

## 7A-01–7A-03 (sobre `7add8ed`)

| ID | Corrección | Prueba | Pendiente |
|---|---|---|---|
| 7A-01 | Purge no usa el bucket global si falta `storage_bucket`; omite con `incomplete_storage_location` y conserva la fila. | Hardening (ubicación incompleta + bucket de la fila) | Backfill explícito si esas filas existen en un destino autorizado |
| 7A-02 | PUT condicional sin fallback `TypeError` → PUT incondicional. 412 + hash para adoptar o 409. | Fake client TypeError; PUT+SQL con foto distinta | R2 real autorizado |
| 7A-03 | `total_max_attempts=2`. Tras PUT, `IntegrityError`/`OperationalError`/`InterfaceError` responden 503 o recuperan la fila; no se capturan errores de programación. | object_store (operacional, commit incierto, AttributeError) | Corte real de PostgreSQL |

Procedimiento de ensayo en tablet (HTTPS, datos aislados, sin despliegue): `docs/ensayo_tablet_https.md`. No autoriza R2, Neon ni publicación.

## Almacenamiento privado de fotos (S3/R2)

Las fotos nuevas se guardan en un bucket S3-compatible privado (`OBJECT_STORE_*`). PostgreSQL conserva `object_key`, `storage_backend`, `storage_bucket`, `byte_size` e `image_sha256`; no el JPEG. El panel sigue leyendo por la API autorizada (`Cache-Control: private, no-store`); no hay URLs públicas. Las pruebas unitarias usan moto; la verificación local exige MinIO desechable y `ALLOW_TEST_DB_RESET=1` explícito. **No se usa el bucket productivo de R2 en tests.** Un 403 o timeout del almacén es 503, no 404. FastAPI no crea buckets en producción. Un PUT de evidencia nueva lleva `IfNoneMatch='*'`; un error de compatibilidad no autoriza un PUT incondicional. La limpieza de abandonadas no borra contra el bucket global si la fila no tiene `storage_bucket`. Migraciones `h4c5d6e7f8a9` e `i5d6e7f8a9b0` no aplicadas a Neon. Filas `object_key` sin `storage_bucket` no se rellenan con el bucket actual: requieren backfill explícito.

### Migraciones

- `e1f2a3b4c5d6`: pertenencia de nonce. Probada en PostgreSQL local desechable. No aplicada a Neon en R45.
- `f2a3b4c5d6e7`: tabla `attendance_attempt_resolutions`. Upgrade poblado desde `e1f2a3b4c5d6` en Postgres desechable. **No aplicada a Neon.** El backend nuevo necesita un esquema compatible antes de un despliegue autorizado. Un downgrade de esta revisión elimina la trazabilidad de resoluciones.
- `g3b4c5d6e7f8`: amplia `attendance_attempt_resolutions.reason` de 80 a 500. Upgrade poblado desde `f2a3b4c5d6e7` en Postgres desechable. **No aplicada a Neon.** Un downgrade a 80 se niega si existen motivos más largos; no recorta.
- `h4c5d6e7f8a9`: `attendance_evidence.object_key` y `image_bytes` nullable. **No aplicada a Neon.** Un downgrade que ponga `image_bytes` NOT NULL se detiene si hay filas S3 sin bytes; no borra fotos.
- `i5d6e7f8a9b0`: `storage_backend`, `storage_bucket`, `byte_size`. Históricos con JPEG se marcan `DATABASE`. Filas con `object_key` y sin bucket no se inventan. El downgrade se niega si hay referencias S3 sin JPEG. **No aplicada a Neon.**

### Referencia mínima del kiosco (R45-03 / EDB-01)

Si la marcación ya se envió y el resultado es incierto, el kiosco guarda en `sessionStorage` (`agua_renew_kiosk_open_attempt`) el token de marcación, la acción, el empleado y la etapa local versionada. No guarda la cookie del terminal, contraseñas ni fotografías. Consultar no sube foto. Un 401/410 o un fallo de consulta muestra el paso de revisión por un jefe; no se afirma que no se haya marcado. Tras CANCELLED/REVIEWED, «Volver al inicio» es explícito.

### Avisos npm (clasificación)

Ejecutado `npm audit --json` (sin `--force`):

| Paquete | Alcance | Severidad | Acción |
|---|---|---|---|
| js-yaml (transitivo) | desarrollo / herramientas | alta (DoS por merge keys, GHSA-2883-xcg3-v3hh) | Parche compatible aplicado (`npm audit fix`) |
| sharp (transitivo de Next) | producción (optimización de imágenes) | alta (libheif) | Parche compatible aplicado (`npm audit fix`) |
| next 16.3.2 | producción (directo) | crítica (RCE Windows / Image Optimization AVIF: GHSA-p293-qw3h-jr36, GHSA-2xp9-vwfh-vxw4) | Parche compatible a 16.3.5 (misma línea 16.3; no es major) |

No se usó `npm audit fix --force`. No quedan avisos conocidos en el árbol tras el parche de Next.

## Fuera de este incremento

Prorrateo salarial, bucket productivo de R2, retención de fotos confirmadas, funciones nuevas del ERP, tablet física y despliegue productivo.
