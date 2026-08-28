// The icons this site needs, as inline SVG.
//
// The same idiom as `packages/web/src/components/icons.tsx`: a 24-unit box,
// `currentColor` strokes, `aria-hidden`, so an icon inherits the colour of the
// text beside it and needs no variant per tone. Sixteen of them rather than the
// dashboard's thirty, and only the ones something here actually renders — an icon
// nobody uses is a shape somebody will reach for wrongly later.
//
// The alert, detail and copy glyphs are **not** here. Those live inside the HTML
// the markdown pipeline emits, because the pipeline runs in Node and has no React
// to render with. See `AUTHORING.md` and the markup vocabulary in the contract.

import type { SVGProps } from "react";

export type IconProps = SVGProps<SVGSVGElement> & { size?: number };

const Svg = ({ size = 16, children, ...rest }: IconProps) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.75}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
    {...rest}
  >
    {children}
  </svg>
);

/** The product mark: three bars of decreasing length — a worktree, a sandbox on it, a hostname in front. */
export const Mark = ({ size = 15 }: { size?: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2.2}
    strokeLinecap="round"
    aria-hidden="true"
    focusable="false"
  >
    <path d="M5 8h14M5 12h9M5 16h11" />
  </svg>
);

export const Search = (props: IconProps) => (
  <Svg {...props}>
    <circle cx="11" cy="11" r="7" />
    <path d="M20 20l-3.5-3.5" />
  </Svg>
);

export const Sun = (props: IconProps) => (
  <Svg {...props}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M18.4 5.6L17 7M7 17l-1.4 1.4" />
  </Svg>
);

export const Moon = (props: IconProps) => (
  <Svg {...props}>
    <path d="M20 14.5A8.5 8.5 0 019.5 4a8.5 8.5 0 1010.5 10.5z" />
  </Svg>
);

export const Monitor = (props: IconProps) => (
  <Svg {...props}>
    <rect x="3" y="4.5" width="18" height="12" rx="1.75" />
    <path d="M9 20h6M12 16.5V20" />
  </Svg>
);

export const External = (props: IconProps) => (
  <Svg {...props}>
    <path d="M14 5h5v5M19 5l-7.5 7.5" />
    <path d="M18 14v4.5A1.5 1.5 0 0116.5 20h-11A1.5 1.5 0 014 18.5v-11A1.5 1.5 0 015.5 6H10" />
  </Svg>
);

export const Close = (props: IconProps) => (
  <Svg {...props}>
    <path d="M6 6l12 12M18 6L6 18" />
  </Svg>
);

export const ChevronLeft = (props: IconProps) => (
  <Svg {...props}>
    <path d="M15 6l-6 6 6 6" />
  </Svg>
);

export const ChevronRight = (props: IconProps) => (
  <Svg {...props}>
    <path d="M9 6l6 6-6 6" />
  </Svg>
);

/** Three lines: the mobile nav's handle, and the one glyph everybody already reads as one. */
export const Menu = (props: IconProps) => (
  <Svg {...props}>
    <path d="M4 7h16M4 12h16M4 17h16" />
  </Svg>
);

/** Two arrows apart: open every collapsed block. */
export const Unfold = (props: IconProps) => (
  <Svg {...props}>
    <path d="M4 12h16" />
    <path d="M9 7l3-3 3 3" />
    <path d="M9 17l3 3 3-3" />
  </Svg>
);

/** Two arrows closing onto one line: fold every block away again. */
export const Fold = (props: IconProps) => (
  <Svg {...props}>
    <path d="M4 12h16" />
    <path d="M9 5l3 3 3-3" />
    <path d="M9 19l3-3 3 3" />
  </Svg>
);

export const Pencil = (props: IconProps) => (
  <Svg {...props}>
    <path d="M4 20h4l10-10-4-4L4 16z" />
    <path d="M14 6l4 4" />
  </Svg>
);

export const Clock = (props: IconProps) => (
  <Svg {...props}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5V12l3 2" />
  </Svg>
);
