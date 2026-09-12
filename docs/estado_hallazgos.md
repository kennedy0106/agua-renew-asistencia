# Estado de hallazgos (H01–H07 y CDB-01–CDB-03)

Documento de seguimiento. No certifica seguridad global ni exactitud de toda la nómina.

## H01–H07 (base `cdb0836` y este incremento)

| ID | Estado | Qué queda |
|---|---|---|
| H01 | Cerrado | Ajuste salarial con `FOR UPDATE` sin `joinedload`; pruebas PostgreSQL de bono y 409. |
| H02 | Parcialmente resuelto | Evidencia idempotente y `/attempt/status` existen. CDB-01 cubre la recuperación con token corto vencido; falta validar el recorrido en tablet física. |
| H03 | Parcialmente resuelto | Hay generación y bloqueos. CDB-02 aísla `finally`, reenvío y QR; las pruebas de navegador usan backend simulado. Falta tablet física. |
| H04 | Implementado; ampliar evidencia | `UPDATE` condicional por hash. Este incremento añade canje simultáneo en PostgreSQL. |
| H05 | Parcialmente resuelto | Límites antes de `load()` y EXIF. CDB-03 cubre bombas de descompresión en `Image.open()`. |
| H06 | Implementado en código | Vista QR e identificación automática. Pendiente tablet física (detector, cámaras, luz). |
| H07 | Corregido en código | `max_age` alineado a `terminal_token_days`. Pendiente cookie real en dominios de despliegue. |

## CDB-01–CDB-03

| ID | Estado previsto al cerrar este incremento | Pendiente físico |
|---|---|---|
| CDB-01 | Recuperación con token vencido, plazo `attempt_recovery_minutes`, pertenencia por `device_id` | Recorrido en tablet con corte de red real |
| CDB-02 | Cancelación no reenvía ni desbloquea otro intento (Playwright) | Doble toque y QR en tablet |
| CDB-03 | Rechazo 422 en apertura y carga, incluidos umbrales de Pillow | Ninguno específico de tablet |

## Fuera de este incremento

Prorrateo salarial, R2, retención de fotos confirmadas y funciones nuevas del ERP.
