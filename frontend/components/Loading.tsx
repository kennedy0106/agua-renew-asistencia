// Skeletons de carga con shimmer — pantallas de carga consistentes con la marca.
"use client";

export function Skeleton({ width, height, round }: { width?: number | string; height?: number | string; round?: boolean }) {
  return (
    <div
      className="skeleton"
      style={{
        width: width ?? "100%",
        height: height ?? 14,
        borderRadius: round ? 999 : undefined,
      }}
    />
  );
}

/** Filas de esqueleto para tablas mientras cargan datos. */
export function TableSkeleton({ rows = 5, cols = 6 }: { rows?: number; cols?: number }) {
  return (
    <>
      {Array.from({ length: rows }).map((_, i) => (
        <tr key={i} style={{ background: i % 2 ? "var(--gray-100)" : undefined }}>
          {Array.from({ length: cols }).map((__, j) => (
            <td key={j} style={{ padding: "0.85rem 1rem" }}>
              <Skeleton width={j === 0 ? "70%" : "55%"} height={12} />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

/** Tarjetas de estadística de esqueleto. */
export function StatSkeleton({ count = 5 }: { count?: number }) {
  return (
    <div className="stat-grid">
      {Array.from({ length: count }).map((_, i) => (
        <div className="stat-card" key={i} style={{ borderColor: "transparent" }}>
          <Skeleton width={110} height={11} />
          <div style={{ marginTop: "0.6rem" }}>
            <Skeleton width={70} height={22} />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Botón con indicador de carga (spinner SVG + texto). */
export function Spinner({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden className="spin">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}
