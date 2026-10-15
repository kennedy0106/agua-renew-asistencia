import { Link } from "react-router-dom";
import { ClipboardCheck, Key } from "@/components/Icons";

/**
 * `/` — portada tipo kiosco. Paridad visual/funcional con la pantalla original.
 */
export default function HomePage() {
  return (
    <div className="kiosk kiosk-home">
      <div className="kiosk-brand">
        {/* El logo es un SVG: se sirve tal cual, sin optimizador de imágenes. */}
        <img src="/brand/logo_color.svg" alt="Agua ReNew" width={700} height={190} />
      </div>

      <div className="kiosk-card kiosk-home-card">
        <div style={{ display: "grid", gap: "0.8rem" }}>
          <Link to="/asistencia" className="btn btn-primary kiosk-btn">
            <ClipboardCheck size={18} />
            Marcar asistencia
          </Link>
          <Link to="/admin/login" className="btn btn-outline kiosk-btn">
            <Key size={18} />
            Panel administrativo
          </Link>
        </div>
      </div>
    </div>
  );
}
