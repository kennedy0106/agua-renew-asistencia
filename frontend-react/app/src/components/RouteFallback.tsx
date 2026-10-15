import { Spinner } from "@/components/Loading";

/**
 * Fallback accesible mientras se descarga el chunk de una ruta perezosa.
 * Anuncia el estado a lectores de pantalla con una marca circular clara; los
 * estilos viven en clases CSS (sin estilos inline) para poder respetar
 * `prefers-reduced-motion` en un único lugar.
 */
export default function RouteFallback() {
  return (
    <div className="route-fallback" role="status" aria-live="polite" aria-busy="true">
      <span className="route-fallback-badge" aria-hidden>
        <img src="/brand/logo_gotita.svg" alt="" width={754} height={1065} />
      </span>
      <Spinner size={20} />
      <span className="route-fallback-label">Cargando…</span>
    </div>
  );
}
