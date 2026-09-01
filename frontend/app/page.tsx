import { ClipboardCheck, Key } from "@/components/Icons";
import Image from "next/image";
import Link from "next/link";

export default function HomePage() {
  return (
    <div className="kiosk">
      <div className="kiosk-brand">
        <Image src="/brand/logo_color.svg" alt="Agua ReNew" width={700} height={190} priority />
      </div>

      <div className="kiosk-card">
        <div style={{ display: "grid", gap: "0.8rem" }}>
          <Link href="/asistencia" className="btn btn-primary kiosk-btn">
            <ClipboardCheck size={18} />
            Marcar asistencia
          </Link>
          <Link href="/admin/login" className="btn btn-outline kiosk-btn">
            <Key size={18} />
            Panel administrativo
          </Link>
        </div>
      </div>
    </div>
  );
}
