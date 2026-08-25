// Íconos SVG de Agua ReNew — un solo sistema: stroke 1.8, round, 24px.
// Sin emojis: toda la UI usa estos íconos.
import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function base({ size = 18, ...props }: IconProps) {
  return {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
    ...props,
  };
}

export const Droplet = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M12 2.7s6 6.4 6 10.6a6 6 0 0 1-12 0C6 9.1 12 2.7 12 2.7Z" />
    <path d="M9.2 14.6a2.8 2.8 0 0 0 2.2 2.7" />
  </svg>
);

export const Clock = (p: IconProps) => (
  <svg {...base(p)}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3.2 1.9" />
  </svg>
);

export const Calendar = (p: IconProps) => (
  <svg {...base(p)}>
    <rect x="3.5" y="5" width="17" height="16" rx="3" />
    <path d="M8 3v4M16 3v4M3.5 10.5h17" />
  </svg>
);

export const Users = (p: IconProps) => (
  <svg {...base(p)}>
    <circle cx="9" cy="8" r="3.4" />
    <path d="M3.2 20a5.8 5.8 0 0 1 11.6 0" />
    <path d="M15.8 4.9a3.4 3.4 0 0 1 0 6.2M17.6 14.4a5.8 5.8 0 0 1 3.2 5.6" />
  </svg>
);

export const User = (p: IconProps) => (
  <svg {...base(p)}>
    <circle cx="12" cy="8" r="3.6" />
    <path d="M4.5 20.5a7.5 7.5 0 0 1 15 0" />
  </svg>
);

export const Briefcase = (p: IconProps) => (
  <svg {...base(p)}>
    <rect x="3" y="7.5" width="18" height="12.5" rx="2.5" />
    <path d="M9 7.5V6a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v1.5M3 12.5h18" />
  </svg>
);

export const Coins = (p: IconProps) => (
  <svg {...base(p)}>
    <circle cx="9" cy="9" r="5.5" />
    <path d="M14.6 6.6a5.5 5.5 0 0 1 2.9 7.9M6 13.3a5.5 5.5 0 0 0 8.2 4.1" />
  </svg>
);

export const Receipt = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M5 3.5h14v17l-2.3-1.6L14.4 20.5l-2.4-1.6-2.4 1.6-2.3-1.6L5 20.5Z" />
    <path d="M9 8.5h6M9 12h6" />
  </svg>
);

export const ClipboardCheck = (p: IconProps) => (
  <svg {...base(p)}>
    <rect x="5" y="4.5" width="14" height="17" rx="2.5" />
    <path d="M9 4.5V3h6v1.5M9 13l2 2 4-4.5" />
  </svg>
);

export const Shield = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M12 3 5 5.8v5.4c0 4.3 3 7.6 7 9.8 4-2.2 7-5.5 7-9.8V5.8Z" />
    <path d="M9.2 12l2 2 3.8-4" />
  </svg>
);

export const Key = (p: IconProps) => (
  <svg {...base(p)}>
    <circle cx="8" cy="15.5" r="4.5" />
    <path d="M11.4 12.1 20 3.5M15.5 8l3 3M17.5 6l2 2" />
  </svg>
);

export const Logout = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M14 4H6.5A1.5 1.5 0 0 0 5 5.5v13A1.5 1.5 0 0 0 6.5 20H14" />
    <path d="M10 12h10M16.5 8.5 20 12l-3.5 3.5" />
  </svg>
);

export const Home = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="m3.5 11 8.5-7 8.5 7" />
    <path d="M5.5 9.5V20h13V9.5M9.5 20v-6h5v6" />
  </svg>
);

export const ChevronRight = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="m9 5.5 6.5 6.5L9 18.5" />
  </svg>
);

export const Check = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="m4.5 12.5 5 5 10-11" />
  </svg>
);

export const X = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M6 6l12 12M18 6 6 18" />
  </svg>
);

export const Alert = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M12 3.5 22 20H2Z" />
    <path d="M12 10v4.5M12 17.2v.1" />
  </svg>
);

export const Search = (p: IconProps) => (
  <svg {...base(p)}>
    <circle cx="10.5" cy="10.5" r="6.5" />
    <path d="m15.5 15.5 5 5" />
  </svg>
);

export const ArrowLeft = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M19 12H5M11 6l-6 6 6 6" />
  </svg>
);

export const Plus = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M12 5v14M5 12h14" />
  </svg>
);

export const Pencil = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M4 20h4.5L20 8.5a2.1 2.1 0 0 0-3-3L5.5 17Z" />
    <path d="m14.5 7 3 3" />
  </svg>
);

export const Refresh = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M20 12a8 8 0 1 1-2.3-5.7" />
    <path d="M20 3.5V8h-4.5" />
  </svg>
);

export const Download = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M12 4v10m0 0 4-4m-4 4-4-4" />
    <path d="M4.5 19.5h15" />
  </svg>
);

export const Zap = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M13 2.5 4.5 13.5H11l-1 8 8.5-11H12Z" />
  </svg>
);

export const Scale = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M12 4v16M7 20h10" />
    <path d="m4.5 8 3-3 3 3M13.5 8l3-3 3 3" />
    <path d="M7.5 5v6a2.5 2.5 0 0 1-3 0V5M16.5 5v6a2.5 2.5 0 0 1-3 0V5" />
  </svg>
);

export const Filter = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M4 6h16M7 12h10M10 18h4" />
  </svg>
);

export const Chart = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M4 20V10M10 20V4M16 20v-7M21 20H3" />
  </svg>
);

export const Gift = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M12 8v12M12 8s-1-4-4-4c-2 0-3 1.5-1 3.5S12 8 12 8Zm0 0s1-4 4-4c2 0 3 1.5 1 3.5S12 8 12 8Z" />
    <path d="M4 12h16v8H4ZM4 8h16v4H4Z" />
  </svg>
);

export const Wallet = (p: IconProps) => (
  <svg {...base(p)}>
    <rect x="3" y="6" width="18" height="13" rx="2.5" />
    <path d="M3 10h18M15.5 14.5h2" />
  </svg>
);

export const Info = (p: IconProps) => (
  <svg {...base(p)}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5M12 7.8v.1" />
  </svg>
);
