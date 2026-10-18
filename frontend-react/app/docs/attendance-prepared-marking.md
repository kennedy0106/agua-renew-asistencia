# Browser preparation and recovery (B4)

The React kiosk uses DNI/internal code/AR identification and a photo without login or manual device pairing. DNI retains the app keypad/input-mode hint; code/AR retains normal text entry. Private staff administration is unchanged.

## Ordered flow

1. Before calling identification for a DNI/code or decoded QR, acquire one browser position: high accuracy, no cached position and an independent 20-second deadline. Reject unsupported/denied/unavailable/invalid or worse-than-50-metre results without identification, opening the attendance photo camera or writes; never infer the physical GPS switch state.
2. Valid identification establishes/reuses the signed browser context and returns an attempt token. Open the attendance photo camera and capture locally; the photo has not been uploaded yet.
3. Before upload, compute location age with the monotonic clock and refresh the position if older than 60 seconds. Prepare that same attempt on the server, then persist its trusted refreshed token and prepared stage. If preparation or persistence fails, do not upload or mark.
4. Upload the required photo and mark using that token. Display the official server-reserved time, not upload completion or an asserted local capture timestamp. Upload latency and read-only recovery do not move an already reserved instant.

The fixed five-minute window starts at server preparation, after local capture and before upload. Once created, retake/reload/recovery must not restart the same snapshot's deadline. The 60-second freshness limit applies when preparing the snapshot; no location watcher or continuous tracking runs, and the browser's wall clock is not official marking time.

## Recovery boundaries

Recovery consumes the real nested `preparation` snapshot and a same-attempt replacement token. It must not accept another employee/action/nonce or manufacture flat location/time fields. Existing prepared time, coordinates and expiry are retained; confirmed, cancelled and expired outcomes follow server state. A recovered status cannot authorize an expired write.

Address text is nullable and no provider lookup is active in B4. Private stamped/original comparison and coordinate-only Maps are B6. No face recognition, geofence or guarantee of physical presence is implied by a location reading.

Local syntax checks are not UI/typecheck/build or hardware proof. Repository CI uses synthetic camera/geolocation fixtures and protects its production artifact from camera bypass; the physical-phone keyboard/camera/GPS test is reserved for the user after the complete production rollout.
