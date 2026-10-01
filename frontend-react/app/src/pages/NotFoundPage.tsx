import { Link } from "react-router-dom";
import { ArrowLeft, Home } from "@/components/Icons";

/**
 * Catch-all de rutas desconocidas. Las 17 rutas del frontend Next están
 * migradas, así que este fallback es el 404 real.
 *
 * Extrapolación Stitch: misma identidad visual del shell (tokens, marca y
 * tipografía) sin inventar datos ni acciones.
 */
export default function NotFoundPage() {
  return (
    <main className="notfound">
      <span className="notfound-brand">
        <img src="/brand/logo_color.svg" alt="Agua ReNew" width={700} height={190} />
      </span>
      <span className="notfound-code" aria-hidden>404</span>
      <h1>Página no encontrada</h1>
      <p>La ruta solicitada no existe en el sistema de asistencia.</p>
      <div className="notfound-actions">
        <Link to="/" className="btn btn-primary">
          <Home size={17} /> Volver al inicio
        </Link>
        <Link to="/admin/login" className="btn btn-outline">
          <ArrowLeft size={17} /> Ir al panel
        </Link>
      </div>
    </main>
  );
}
