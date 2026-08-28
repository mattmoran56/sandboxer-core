// The icons this pipeline injects, as inline SVG strings.
//
// Strings rather than React components because these are not rendered by React:
// they are baked into the HTML at build time and arrive in the browser through
// `dangerouslySetInnerHTML`, so there is no component to mount. They still follow
// `packages/web/src/components/icons.tsx` exactly — a 24-unit box, `currentColor`
// strokes and `aria-hidden`, so an icon takes the colour of the text beside it
// and is invisible to a screen reader reading the title next to it.
//
// Inline for the same hard reason the dashboard's are: nothing may be fetched
// from another origin, at build time or after it, so an icon font or a sprite is
// not an option.
//
// Attribute names are the HTML ones (`stroke-width`, not `strokeWidth`). This is
// a string going into a document, not JSX, and React's spelling would be dropped
// silently by the parser.

/** One icon. `size` is in CSS pixels; the geometry is always the 24-unit box. */
const svg = (className: string, body: string, size = 16): string =>
  `<svg class="${className}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none"` +
  ` stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"` +
  ` aria-hidden="true" focusable="false">${body}</svg>`;

/**
 * The five GitHub alert kinds.
 *
 * Each is the shape GitHub itself uses for that alert, near enough that a reader
 * who saw the page on GitHub first recognises it: an `i` for a note, a bulb for a
 * tip, a megaphone for something important, a triangle for a warning and an
 * octagon for a caution. The shape carries the meaning for anybody who cannot
 * tell the colours apart, which is why the icon exists at all rather than the
 * border colour doing the whole job.
 */
export const ALERT_ICONS: Readonly<Record<string, string>> = {
  note: svg("sbx-alert__icon", `<circle cx="12" cy="12" r="9" /><path d="M12 11v5" /><path d="M12 7.75h.01" />`),
  tip: svg(
    "sbx-alert__icon",
    `<path d="M9 18h6" /><path d="M10 21h4" /><path d="M12 3a6 6 0 00-3.5 10.9V18h7v-4.1A6 6 0 0012 3z" />`,
  ),
  important: svg(
    "sbx-alert__icon",
    `<path d="M3 10.5v3a1.5 1.5 0 001.5 1.5H7l6 4V6.5l-6 4H4.5A1.5 1.5 0 003 12z" /><path d="M17 9.5a4 4 0 010 5" /><path d="M19.5 7a7.5 7.5 0 010 10" />`,
  ),
  warning: svg(
    "sbx-alert__icon",
    `<path d="M12 4.5l8.5 14.5h-17z" /><path d="M12 10v4.25" /><path d="M12 16.75h.01" />`,
  ),
  caution: svg(
    "sbx-alert__icon",
    `<path d="M8.5 3h7L21 8.5v7L15.5 21h-7L3 15.5v-7z" /><path d="M12 8v4.5" /><path d="M12 15.75h.01" />`,
  ),
};

/**
 * The four `<details>` kinds.
 *
 * A terminal prompt for the block written for an agent, a life ring for the one
 * about things going wrong, a question mark for the reasoning, and a list for a
 * fact sheet. The reader learns four shapes and then knows, closed, whether the
 * block is worth opening — which is the whole point of the convention.
 */
export const DETAIL_ICONS: Readonly<Record<string, string>> = {
  agent: svg("sbx-detail__icon", `<rect x="3" y="4" width="18" height="16" rx="2" /><path d="M7 9.5l2.5 2.5L7 14.5" /><path d="M12.5 15h4.5" />`),
  failure: svg("sbx-detail__icon", `<circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="3.75" /><path d="M5.5 5.5l3.9 3.9M18.5 5.5l-3.9 3.9M18.5 18.5l-3.9-3.9M5.5 18.5l3.9-3.9" />`),
  why: svg("sbx-detail__icon", `<circle cx="12" cy="12" r="9" /><path d="M9.5 9.5a2.5 2.5 0 114 2.1c-.9.6-1.5 1.1-1.5 2.15" /><path d="M12 17.25h.01" />`),
  facts: svg("sbx-detail__icon", `<path d="M5 6h14M5 12h14M5 18h9" />`),
};

/** The chevron a `<summary>` carries, so its open state is visible without a marker. */
export const CHEVRON_ICON = svg("sbx-detail__chevron", `<path d="M6 9l6 6 6-6" />`);

/** Two sheets, on the copy button of a code block and of a prompt. */
export const COPY_ICON = svg(
  "sbx-copy__icon",
  `<rect x="9" y="9" width="11" height="11" rx="2" /><path d="M15 5.5A1.5 1.5 0 0013.5 4h-8A1.5 1.5 0 004 5.5v8A1.5 1.5 0 005.5 15" />`,
  14,
);

/**
 * The prompt card's mark: a spark.
 *
 * A prompt is the one element on the site that is addressed to a machine rather
 * than to the reader, and the spark is the only icon here that says "this goes
 * somewhere else" rather than naming a category.
 */
export const PROMPT_ICON = svg(
  "sbx-prompt__icon",
  `<path d="M12 3l1.8 4.9L18.7 9.7l-4.9 1.8L12 16.4l-1.8-4.9L5.3 9.7l4.9-1.8z" /><path d="M18 16.5l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9z" />`,
);
