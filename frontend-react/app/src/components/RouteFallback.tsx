import { Spinner } from "@/components/Loading";

/**
 * Fallback accesible mientras se descarga el chunk de una ruta perezosa.
 * Anuncia el estado a lectores de pantalla y mantiene la geometría a pantalla
 * completa.
 */
export default function RouteFallback() {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy="true"
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: "0.6rem",
        color: "#1f2933",
        fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif",
      }}
    >
      <Spinner size={20} />
      <span>Cargando…</span>
    </div>
  );
}
