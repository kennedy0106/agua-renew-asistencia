import { ClipboardCheck, Key } from "@/components/Icons";

export default function HomePage() {
  return (
    <div className="kiosk">
      <div className="kiosk-brand">
        <img src="/brand/logo_color.svg" alt="Agua ReNew" />
        <span className="tagline">Agua que renueva, superior que transforma</span>
      </div>

      <div className="kiosk-card">
        <div style={{ display: "grid", gap: "0.8rem" }}>
          <a href="/asistencia" className="btn btn-green kiosk-btn">
            <ClipboardCheck size={18} />
            Marcar asistencia
          </a>
          <a href="/admin/login" className="btn btn-primary kiosk-btn">
            <Key size={18} />
            Panel administrativo
          </a>
        </div>
      </div>
    </div>
  );
}
