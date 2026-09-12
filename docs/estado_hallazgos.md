# Estado de hallazgos (H01–H07, CDB-01–CDB-03, R45 y EDB-01–EDB-03)

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

### Migraciones

- `e1f2a3b4c5d6`: pertenencia de nonce. Probada en PostgreSQL local desechable. No aplicada a Neon en R45.
- `f2a3b4c5d6e7`: tabla `attendance_attempt_resolutions`. Upgrade poblado desde `e1f2a3b4c5d6` en Postgres desechable. **No aplicada a Neon.** El backend nuevo necesita un esquema compatible antes de un despliegue autorizado. Un downgrade de esta revisión elimina la trazabilidad de resoluciones.

## Fuera de este incremento

Prorrateo salarial, R2, retención de fotos confirmadas, funciones nuevas del ERP, tablet física y despliegue productivo.
