# Private attendance evidence

Only ADMIN and BOSS may read attendance evidence. Both image routes use the existing evidence authorization dependency; successful image responses include `Cache-Control: private, no-store`.

## Metadata and original image

`GET /api/v1/attendance/{record_id}/evidence` retains `record_id`, `check_in`, and `check_out`. Each evidence reference preserves `id`, `captured_at`, `content_type`, and `available`, and adds:

- `marked_at`: the reserved official server time, not a new retrieval or upload time.
- `location`: the frozen preparation coordinates, accuracy, observation time, and optional address.
- `stamped_available`: eligibility for a confirmed, prepared derivative; not a guarantee that rendering or storage is available.

Historical evidence without a preparation has null official time/location and no advertised stamp. Nothing is backfilled or inferred from current employee data.

`GET /api/v1/attendance/evidence/{evidence_id}/image` remains the raw-original route. Stamping never replaces its stored key, hash, or bytes.

## Separate stamped image

`GET /api/v1/attendance/evidence/{evidence_id}/stamped-image` returns a private JPEG. It requires confirmed evidence and its frozen preparation. The renderer uses that preparation's employee identity, action, official time, GPS, accuracy, optional address, and evidence reference. Retrieval performs no reverse geocoding.

The derivative is generated lazily at `attendance/{employee_id}/{nonce}.stamped.jpg`. Reads and writes explicitly use the evidence row's recorded bucket; only a row without a bucket uses the existing store default. A cached derivative is reused. An already-existing derivative is not overwritten. A failed derivative write does not cancel confirmed attendance; a later retrieval may render again.

Failures are explicit, never an original image presented as a stamp:

| Status | Detail |
| --- | --- |
| 409 | `La evidencia aún no está confirmada; no hay imagen sellada` |
| 409 | `La evidencia no tiene preparación de ubicación; no se fabrica sello` |
| 503 | `El sello de evidencia no está disponible; la marcación permanece confirmada` |

Existing not-found and object-store error mapping remain in force. A rendering failure does not undo or duplicate the confirmed event. This change adds no migration, retention policy, provider activation, public photo endpoint, or historical-data rewrite.

## Verification boundary

The eight private HTTP contracts retain the frozen donor's assertions: additive metadata, historical originals, original key/hash/bytes, roles, rendering failure, real JPEG/cache behavior, and the recorded-bucket case. Execution uses synthetic SQLite, in-process Moto and the existing hardened runner, with no configured geocoder or live employee data. It is not PostgreSQL-load, production storage durability, live-provider, physical-phone, or deployment proof.
