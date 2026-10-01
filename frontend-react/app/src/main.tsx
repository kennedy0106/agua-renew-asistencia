import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "@/App";
// Fuentes autoalojadas (Stitch): Plus Jakarta Sans para titulares y Inter para
// interfaz/tablas. Se empaquetan en el bundle, sin CDN ni proveedor externo.
import "@fontsource-variable/plus-jakarta-sans";
import "@fontsource-variable/inter";
import "@/styles/fonts.css";
import "@/styles/utilities.css";
import "@/styles/globals.css";
// Capa Stitch (Renew Operations & Assistance): se carga al final para
// remapear los tokens del sistema anterior a la identidad corporativa.
import "@/styles/stitch.css";

const container = document.getElementById("root");
if (!container) {
  throw new Error("No se encontró el elemento #root en index.html");
}

createRoot(container).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
