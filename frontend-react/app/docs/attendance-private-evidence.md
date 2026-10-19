# Private attendance evidence viewer

ADMIN and BOSS keep the existing attendance photo dialog. Other roles do not receive the management viewer; the server's existing evidence authorization remains authoritative for metadata and both image routes.

## Versions and downloads

Prepared, confirmed evidence may advertise a stamped derivative. The dialog loads original and derivative bytes through credentialed private API calls and uses browser object URLs, not public storage URLs.

- The initial image is labeled `Versión con sello` when the derivative loaded successfully.
- `Ver original` / `Ver con sello` switches versions without replacing the stored original.
- `Descargar original` and `Descargar con sello` download the explicitly labeled version.
- If an advertised derivative fails, the dialog states: `No se pudo cargar la versión con sello de esta foto. La imagen mostrada y descargable es la original, sin sello.` No stamped download is offered for that failure.

The API helper keeps the original `/image` route and adds `/stamped-image`; both request `credentials: "include"`. An unsuccessful stamped request raises `ApiError` with `No se pudo cargar la foto con sello`, rather than silently fetching an original as a stamp.

## Official time and location

`Hora oficial` comes from the server-reserved `marked_at` and is displayed in `America/Lima`. GPS, accuracy and optional address come from the frozen preparation, not the administrator's device or a fresh geocoder request.

`Ver en Google Maps` is a user-activated, literal HTTPS Google Maps link containing only the latitude/longitude pair. It uses `target="_blank"` and `rel="noopener noreferrer"`; no map iframe, background Maps request, worker identity, token, evidence ID or address is added to the URL.

Historical evidence lacking new metadata remains explicitly original. It shows `Hora oficial no disponible` and `Ubicación no disponible para este registro.`, without fabricated coordinates, a Maps link or a stamped-image request.

## Verification boundary

The frozen donor's four private API contracts and six admin-viewer contracts are preserved, alongside the existing seven GPS/preparation/API cases. Their assertions cover metadata compatibility, credentialed JPEG downloads, explicit failures, versions, historical evidence, Maps URL privacy and role visibility.

The existing local UI runner is incompatible with this worktree. No replacement runner, dependency installation, environment loading or local Vite/Vitest/build/browser execution is used. Local TypeScript parsing is structural evidence only; functional UI tests, typechecking, build and browser checks require exact-head CI. Physical-phone validation remains the user's post-deployment step. This is not production, hardware, live-provider, restore or storage-durability proof.
