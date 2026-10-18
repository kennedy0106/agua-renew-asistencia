# Browser preparation and recovery (B4)

The React kiosk uses DNI/internal code/AR identification and a photo without login or manual device pairing. DNI retains the app keypad/input-mode hint; code/AR retains normal text entry. Private staff administration is unchanged.

## Ordered flow

1. Valid identification establishes/reuses the signed browser context and returns an attempt token.
2. Acquire one browser position with high accuracy, no cached position and an independent 20-second deadline. Reject unsupported/denied/unavailable/invalid or worse-than-50-metre results with the existing explicit UI error; never infer the physical GPS switch state.
3. Compute location age with the monotonic clock and prepare that attempt on the server. Only after successful preparation proceed to the camera/photo step. No location watcher or continuous tracking runs.
4. Upload the required photo and mark using the current token. Display the official server-reserved time; upload/camera latency does not move it. The fixed preparation window is five minutes, not restarted by a retake, reload or recovery.

The 60-second freshness limit applies when preparing the snapshot; the snapshot then has its separate fixed five-minute lifetime. The browser's wall clock is not used as official marking time.

## Recovery boundaries

Recovery consumes the real nested `preparation` snapshot and a same-attempt replacement token. It must not accept another employee/action/nonce or manufacture flat location/time fields. Existing prepared time, coordinates and expiry are retained; confirmed, cancelled and expired outcomes follow server state. A recovered status cannot authorize an expired write.

Address text is nullable and no provider lookup is active in B4. Private stamped/original comparison and coordinate-only Maps are B6. No face recognition, geofence or guarantee of physical presence is implied by a location reading.

Local syntax checks are not UI/typecheck/build or hardware proof. Repository CI uses synthetic camera/geolocation fixtures and protects its production artifact from camera bypass; the physical-phone keyboard/camera/GPS test is reserved for the user after the complete production rollout.
