import { useRef } from "react";
import AppDialog, { AppDialogCloseButton } from "@/components/AppDialog";
import { Info } from "@/components/Icons";
import { locationFailureCopy, type LocationFailure } from "@/lib/attendance-location";

const TITLE_ID = "kiosk-location-dialog-title";
const DESCRIPTION_ID = "kiosk-location-dialog-description";

/**
 * Alerta previa a identificar: explica por qué el kiosco no obtuvo la
 * ubicación y ofrece un único reintento explícito o volver al formulario.
 * No afirma causas que el navegador no demuestra (p. ej. GPS apagado) ni
 * promete abrir ajustes del sistema.
 */
export default function AttendanceLocationDialog({
  failure,
  busy,
  onRetry,
  onClose,
  onCloseRequest,
}: {
  failure: LocationFailure;
  busy: boolean;
  onRetry: () => void;
  onClose: () => void;
  onCloseRequest: () => void;
}) {
  const copy = locationFailureCopy(failure);
  // El cierre se marca antes de invalidar el intento en el padre. Es un ref
  // para que Escape, backdrop y Volver bloqueen Reintentar en el mismo evento,
  // incluso mientras la ventana sigue montada durante la animación de salida.
  const closingRef = useRef(false);

  function handleCloseRequest() {
    closingRef.current = true;
    onCloseRequest();
  }

  function handleClose() {
    closingRef.current = true;
    onClose();
  }

  function handleRetry() {
    if (closingRef.current || busy) return;
    onRetry();
  }

  return (
    <AppDialog
      labelledBy={TITLE_ID}
      describedBy={DESCRIPTION_ID}
      role="alertdialog"
      onClose={handleClose}
      onCloseRequest={handleCloseRequest}
      className="attendance-location-dialog"
    >
      <div className="attendance-location-dialog-copy">
        <span className="attendance-location-dialog-icon" aria-hidden>
          <Info size={20} />
        </span>
        <div>
          <h2 id={TITLE_ID} data-testid="kiosk-location-dialog-title">
            {copy.title}
          </h2>
          <p id={DESCRIPTION_ID} data-testid="kiosk-location-dialog-description">
            {copy.description}
          </p>
          <p className="attendance-location-dialog-help">{copy.help}</p>
        </div>
      </div>
      <div className="app-dialog-actions attendance-location-dialog-actions">
        <button
          type="button"
          className="btn btn-primary kiosk-btn"
          onClick={handleRetry}
          // `aria-disabled` conserva el foco dentro del alertdialog durante la
          // lectura; el click se bloquea en el handler y en los locks del flujo.
          aria-disabled={busy}
          style={busy ? { opacity: 0.72, cursor: "progress" } : undefined}
          data-testid="kiosk-location-retry"
        >
          {busy ? "Comprobando ubicación…" : "Reintentar"}
        </button>
        <AppDialogCloseButton
          type="button"
          className="btn btn-outline kiosk-btn"
          data-autofocus
          data-testid="kiosk-location-back"
        >
          Volver
        </AppDialogCloseButton>
      </div>
    </AppDialog>
  );
}
