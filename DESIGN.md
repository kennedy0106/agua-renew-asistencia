---
name: Agua ReNew Asistencia
description: Sistema operativo claro y acuático para registrar y supervisar asistencia.
colors:
  brand-blue: "#0066cc"
  brand-blue-bright: "#007bff"
  brand-blue-soft: "#67c3f3"
  brand-green: "#00c853"
  present: "#00a047"
  incident: "#b42318"
  brand-ink: "#154399"
  brand-muted: "#3f5f86"
typography:
  headline: { fontFamily: "'Geist Variable', 'Segoe UI', 'Trebuchet MS', sans-serif", fontSize: "clamp(1.85rem, 3vw, 2.4rem)", fontWeight: 740, lineHeight: 1.05, letterSpacing: "-0.035em" }
  title: { fontFamily: "'Geist Variable', 'Segoe UI', 'Trebuchet MS', sans-serif", fontSize: "1.05rem", fontWeight: 720, lineHeight: 1.2, letterSpacing: "-0.03em" }
  body: { fontFamily: "'Geist Variable', 'Segoe UI', 'Trebuchet MS', sans-serif", fontSize: "0.9rem", fontWeight: 400, lineHeight: 1.5 }
  label: { fontFamily: "'Geist Variable', 'Segoe UI', 'Trebuchet MS', sans-serif", fontSize: "0.7rem", fontWeight: 750, lineHeight: 1.2, letterSpacing: "0.055em" }
  time-value: { fontFamily: "'Geist Variable', 'Segoe UI', 'Trebuchet MS', sans-serif", fontSize: "inherit", fontWeight: 740, lineHeight: 1, fontVariantNumeric: "tabular-nums" }
rounded: { control: "0.35rem", panel: "0.85rem", popover: "1rem", badge: "999px" }
spacing: { xs: "0.45rem", sm: "0.65rem", md: "0.85rem", lg: "1.1rem", xl: "1.5rem", workspace: "1.75rem" }
---

# Design System: Agua ReNew Asistencia

## Overview

**North star: “Agua en operación”.** Asistencia identifica a la persona, confirma entrada o salida y permite supervisar incidencias sin distraer de la operación. El agua aporta profundidad detrás de superficies legibles; Geist mantiene una sola voz de interfaz.

## Colors

Azul Agua dirige acciones, navegación, foco y selección. Verde Renew y `present` confirman presencia, éxito y jornadas completas. `incident` señala errores, recuperación requerida y jornadas a revisar. El color nunca comunica un estado por sí solo: se acompaña de texto, icono o posición.

## Typography

Los títulos usan tracking compacto. Hora, duración, fecha y conteos comparables usan el rol **time-value** con números tabulares. Las fechas se expresan en español y la operación de asistencia usa `America/Lima`.

## Layout

El shell desktop reserva barra lateral; móvil usa header y drawer con scrim, Escape, cierre explícito y foco recuperable. El ritmo es `0.45 / 0.65 / 0.85 / 1.1 / 1.5 / 1.75rem`. Los objetivos táctiles miden al menos 44×44px. A zoom o texto 200%, el login puede desplazarse verticalmente para llegar al CTA, nunca lateralmente.

## Elevation & Depth

El material combina vidrio blanco, highlight interior y sombra azul recortada, no bordes pesados. En puntero grueso o `prefers-reduced-transparency`, se retira blur y la superficie se vuelve casi opaca. En `prefers-reduced-motion`, se detiene el movimiento decorativo.

## Shapes

Controles y botones tienen radio contenido; paneles y popovers son más suaves. Solo badges, avatares, gotas y puntos usan cápsula. No convertir CTA o filtros extensos en píldoras.

## Components

- **Kiosco:** reloj Lima legible; DNI, código o QR; una acción inequívoca de entrada/salida y feedback causal.
- **Evidencia:** aparece solo cuando el flujo la exige y explica el estado.
- **Incidencia y recovery PostgreSQL:** explica qué ocurrió y el siguiente paso; conserva identificación y no inventa una confirmación cuando la conexión no está disponible.
- **Panel administrativo:** KPI semánticos, tablas, carga, vacío, error y éxito preservan datos válidos.
- **Calendario:** label persistente, diálogo nombrado no modal, Escape al trigger y días con flechas, Inicio y Fin.
- **Login:** inputs altos, password manager/paste intactos y CTA alcanzable.

## Do’s and Don’ts

**Do:** priorizar una acción primaria, mantener foco visible, usar estados claros y respetar preferencias de movimiento/transparencia.

**Don’t:** apilar vidrio, ocultar columnas críticas para simular responsividad, depender solo del color o alterar rutas, permisos, autenticación y contratos de negocio.
