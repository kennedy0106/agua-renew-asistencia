# HST-01 — cierre H693

Base funcional: `693ffba40a022ab043bf98e07c9fe02fb2c4956a`.
Este incremento no autoriza Neon, cargas reales, despliegues, `main`, fotografía,
GPS ni cambios del kiosco. La verificación usa PostgreSQL 17 y MinIO locales
desechables. Los resultados finales y SHA validados se completan en un commit
exclusivamente documental después de congelar y verificar el candidato.

## Contratos cerrados

- **H693-01:** batch/update/void bloquean empleado, jornada, unión de compromisos
  antiguos+nuevos y periodos en orden estable; las aplicaciones se vacían antes
  de derivar efectos. Se invalidan trabajo y fechas origen editables, nunca el
  snapshot CLOSED. El fingerprint incluye recuperaciones entrantes de otros
  meses sin sumarlas al W del origen y se ordena canónicamente.
- **H693-02:** preview/snapshot contienen contenido, importe y procedencia exacta
  de sueldo, jornada y política (IDs y vigencias). Guardado y edición persisten
  esa representación, sin segunda valoración. Aprobación individual vuelve a
  mostrar la valoración vigente y exige confirmación explícita.
- **H693-03:** `n0b1c2d3e4f5` amplía recibos v2 con actor/tipo/objetivo/status. Un
  advisory lock acotado serializa la clave; recibo y efecto comparten commit;
  replay precede CLOSED/version/voided. Un COMMIT incierto se resuelve por el
  recibo exacto o devuelve `OPERATION_RESULT_UNKNOWN`. La UI conserva un único
  DTO/clave por usuario, no permite sobrescribir un encargo incierto y lo
  consulta/reintenta después de recargar.

## Matriz A — recuperaciones, fechas y fingerprint

| ID | Test(s) persistidos | Evidencia esperada |
|---|---|---|
| A01 | `test_h693_cross_month_update_invalidates_work_and_permission_periods` | Trabajo y origen quedan OPEN/fingerprint nulo; W origen no crece. |
| A02 | `test_h693_moves_recovery_origin_then_removes_it_without_residual_credit` | Julio pierde y agosto recibe exactamente 120; los tres meses se invalidan. |
| A03 | mismo test A02 | Al retirar R no queda aplicación efectiva ni crédito residual. |
| A04 | `test_closed_root_uses_editable_rectification_and_checks_recovery_permission_date` | Origen CLOSED rechaza todo el cambio. |
| A05 | mismo test A04 y `test_closed_period_requires_rectification_and_invalidates_editable_snapshot` | Sólo la rectificación editable se abre; original CLOSED queda intacto. |
| A06 | tests A01/A02 | Fingerprints cambian al recalcular; W del origen permanece 0. |
| A07 | test A04 y batch multi-R de la suite HST | Todos los orígenes se reúnen antes de validar periodos. |
| A08 | `test_h693_unrelated_integrity_failure_rolls_back_instead_of_claiming_duplicate` | Fallo posterior a flush revierte filas, auditoría y recibo. |
| A09 | `test_recovery_credit_excludes_approved_legacy_coverage_at_origin`, `test_recovery_credit_does_not_treat_approved_overtime_as_origin_coverage` | No doble crédito; OVERTIME no cubre R. |
| A10 | orden canónico en fingerprint/preview/payload y suite completa | Orden SQL/DTO no cambia la representación empresarial. |
| A11 | `test_hst01_f04_close_blocks_concurrent_versioned_edit`, `test_ajuste_gana_antes_del_cierre` | Ambos órdenes PG terminan sin parcial ni bloqueo. |
| A12 | `U09 real` y regresiones de saldo/diario/export | N/P/R coinciden en saldo, diario y CSV; sin doble refrigerio. |

## Matriz B — valoración y aprobación

| ID | Test(s) persistidos | Evidencia esperada |
|---|---|---|
| B01 | UI base y `U09 real` | Varios empleados conservan snapshot/importe mostrado. |
| B02 | `test_h693_preview_binds_configuration_identity_even_when_amount_is_equal`, `test_approval_rejects_changed_preview_and_repeat_is_stable` | Configuración cambiada produce STALE_PREVIEW, incluso con mismo importe. |
| B03 | `test_h693_persists_the_exact_validated_valuation_without_second_estimate` | Cambio tras validación no altera el importe persistido. |
| B04 | distribución inválida y rollback B07/C11 | Lote inválido deja cero parciales. |
| B05 | tests REVIEWED de política/mínimo vigente | REVIEWED no elude el mínimo. |
| B06 | `test_manual_day_versioned_update_and_void` y B03 | Sustituta P contiene valoración validada. |
| B07 | rollback B07/C11 | Error interno no se vuelve conflicto empresarial falso. |
| B08 | UI `B08/U08: aprobación individual...` | Se muestra importe vigente y se confirma antes de aprobar. |
| B09 | `test_h693_replay_binds_the_preview_decision_and_hides_unscoped_v1` | Metadata de transporte no altera hash; preview sí queda ligado. |

## Matriz C — recibos, concurrencia y recuperación

| ID | Test(s) persistidos | Evidencia esperada |
|---|---|---|
| C01 | `test_hst01_a30_same_idempotency_key_has_one_effective_creation` | Dos conexiones obtienen mismos IDs; una fila/recibo. |
| C02 | `test_h693_same_key_can_continue_after_first_transaction_rolls_back` | Segundo espera y confirma una vez tras rollback. |
| C03 | `test_h693_batch_receipt_is_scoped_and_returns_original_result` | Payload/actor/operación/objetivo distintos no reutilizan resultado. |
| C04 | replay update/void y `U02/U03 real` | PATCH perdido devuelve sustituta original y un efecto. |
| C05 | mismos tests C04 | VOID perdido no incrementa ni libera R dos veces. |
| C06 | `test_approval_rejects_changed_preview_and_repeat_is_stable` | Replay APPROVE conserva importe/version/autor. |
| C07 | replay update/void tras CLOSED | Replay sólo lee recibo; CLOSED queda intacto. |
| C08 | `test_h693_new_decision_against_voided_version_is_stale_not_missing` | Nueva clave contra anulada da STALE_VERSION. |
| C09 | replay update/void | Primer PATCH conserva snapshot aunque exista otra sustituta. |
| C10 | tests de COMMIT ambiguo y consulta indisponible | Sólo recibo durable converge; lo incierto devuelve 503. |
| C11 | rollback B07/C11 | Error de auditoría/constraint no deja parcial. |
| C12 | recibo scoped | 401 sin login, 403 sin rol, 404 para otro propietario. |
| C13 | `test_h693_advisory_lock_timeout_is_controlled_and_keeps_same_key` | Timeout controlado conserva clave. |
| C14 | `test_h693_operation_receipt_upgrade_keeps_v1_unscoped` | v1/created_at conservados; checks v2 rechazan nulos. |
| C15 | C03/C07 | Contenido alterado sigue en conflicto tras CLOSED. |
| C16 | `test_hst01_d03_two_concurrent_creations_leave_one_active_day` | Claves distintas conservan exclusividad. |

## Matriz U — pantalla e integración real

| ID | Test(s) persistidos | Evidencia esperada |
|---|---|---|
| U01 | UI `U01: una respuesta perdida...` | DTO/clave idénticos y un efecto. |
| U02 | integración `U02/U03 real...` | PATCH con R confirma, pierde respuesta y recarga recibo/version2. |
| U03 | integración `U02/U03 real...` | VOID confirma, pierde respuesta y deja una sola línea 1→3. |
| U04 | UI `A09/A14: descarta un preview tardío...` | Preview viejo no habilita contenido nuevo. |
| U05 | handlers y UI U01 | Éxito con fallo de refresh no invita a duplicar. |
| U06 | `recoveryGeneration` y UI U06/U07 | Respuesta antigua no altera otro contexto. |
| U07 | storage por usuario, C12 y UI U06/U07 | Encargo ajeno no se muestra ni recupera. |
| U08 | UI B08/U08 y edición STALE_VERSION | Preview, versión y red tienen mensajes/acciones distintos. |
| U09 | integración `U09 real...` | N/P/R/Mixto cotejado con API, saldo, diario y CSV reales. |

## Autorrevisión dirigida

1. Aplicaciones nuevas: `flush` explícito antes de derivar efectos.
2. Update: unión vieja+nueva antes de anular.
3. Valoración: ningún cálculo posterior a la representación aceptada.
4. Replay: recibo antes de CLOSED/version/voided.
5. Recibo, negocio y auditoría: un commit.
6. UI UNKNOWN: no genera otra clave/DTO.
7. Consulta indisponible: no equivale a “no guardado”.
8. Pruebas cruzan periodos, fingerprints, saldo, diario, CSV y auditoría.
9. Concurrencia usa conexiones PG independientes y locks reales.
10. API, tipos, UI, permisos y migración están conectados.

## Prueba manual ficticia

1. **Normal:** 480 W / 480 N / 0 P / 0 R; previsualizar y guardar.
2. **Adicional:** 120 W / 0 N / 120 P / 0 R; elegir método, previsualizar y confirmar importe.
3. **Recuperación:** compromiso de 120 en origen; 120 W / 0 N / 0 P / 120 R en otra fecha; crédito sólo en origen.
4. **Mixto:** 480 W / 240 N / 120 P / 120 R; elegir compromiso y confirmar P; cotejar historial, saldo, diario y CSV.

## Verificación final

- Candidato de código y tests: `f8caf88b8a888fd3a836a827254e2a9063905c5a`.
- Backend completo: **404 passed**, 18 advertencias de deprecación, 0 fallos y
  0 omisiones obligatorias; incluye SQLite, PostgreSQL, Alembic y concurrencia.
- Frontend: `npm ci` sin vulnerabilidades; lint, TypeScript y build aprobados.
- Playwright UI: **22 passed**.
- Playwright con FastAPI/PostgreSQL/MinIO reales locales: **22 passed**.
- `git diff --check`: aprobado.
- Evidencia local: `.local-verify/20260917T030312Z/` (gitignored).
- Matriz A01–A12, B01–B09, C01–C16 y U01–U09: sin criterios obligatorios
  pendientes en el candidato verificado.

No se ejecutó carga real ni migración en Neon.

## Cierre dirigido H693-03/UI y H693-03/COMMIT (candidato posterior a `a5861fb`)

La reproducción inicial sobre el árbol publicado mostró dos fallos concretos:
`MANUAL_DAY_EXISTS` se conservaba como pendiente de pantalla y el `rollback()`
sin protección sustituía el 503 controlado cuando COMMIT ya había fallado. El
cierre añade `classifyHistoricalOperationResult`/`runHistoricalOperation` y lo
usa en guardar, editar, anular, aprobar, reintentar y consultar una operación
restaurada. Sólo los contratos emitidos por asistencia y el 422 parseado se
liberan como rechazo antes de escribir; red, 404 sin recibo y 503 permanecen
con el mismo DTO/clave. `commit_with_receipt_recovery` limita la recuperación
a errores operacionales/de interfaz, tolera ese mismo fallo en rollback y usa
como máximo una sesión alternativa para un recibo v2 completo. `batch()` deja
pasar el HTTPException controlado sin una segunda limpieza.

| ID | Prueba efectiva | Entorno / resultado dirigido |
|---|---|---|
| E01 | `E01 real: la pantalla libera...` | Playwright + FastAPI/PG/MinIO local: PASS. |
| E02 | `E02 real: una edición rechazada...` | Playwright + FastAPI/PG/MinIO local: PASS. |
| E03 | `E03/E07: un 422 contractual...` | Playwright UI: PASS; conserva otra clave. |
| E04 | `test_e04_closed_edit_is_rejected_then_rectification_allows_the_same_business_change` | HTTP local: PASS. |
| E05 | `E05/E06 real: respuesta perdida...` | Playwright + API local: PASS; consulta 503 conserva el envío. |
| E06 | mismo test E05/E06 | Recarga recupera recibo sin reenviar: PASS. |
| E07 | `E03/E07: ... error tardío...` | Playwright UI: PASS. |
| E08 | `test_e08_http_commit_and_rollback_failures_keep_controlled_unknown` | Ruta HTTP local: PASS, 503 estable. |
| E09 | `test_e09_http_commit_cleanup_failure_recovers_exact_durable_receipt` | Ruta HTTP local: PASS, un recibo/fila/auditoría. |
| E10 | `test_e10_alternative_recovery_connection_failure_is_stable_unknown` | HTTP local: PASS, sin bucle ni éxito supuesto. |
| E11 | tests E08/E09 | Reintento posterior converge en un solo resultado: PASS. |
| E12 | `test_e12_programming_error_is_not_relabelled_as_ambiguous_result` | Unitario local: PASS, conserva ProgrammingError. |

Verificación completa del candidato posterior queda a cargo del cierre final;
esta sección no reemplaza los resultados de `a5861fb` anteriores.
