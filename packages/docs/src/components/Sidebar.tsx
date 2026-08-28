// The left column: every page on the site, in reading order.
//
// The order and the grouping come from `src/nav.ts` and nothing here derives
// them. That list is editorial — "Install it" precedes "Your first sandbox"
// because you cannot do the second without the first, and no sorting rule knows
// that — so a sidebar that arranged itself would be a second, worse opinion about
// the shape of the documentation.
//
// **A page in the nav with no file behind it renders dimmed and unclickable.**
// That is the build's "warn and skip rather than throw" rule showing through to
// the reader: content is written concurrently with the site, and a nav entry that
// has run ahead of its Markdown must not become a link into a 404. It is not a
// silent state either — the entry says what is wrong when you point at it, which
// is how an author notices they have a page to write.

import { NAV } from "../nav.js";
import { pathOfSlug } from "../lib/route.js";
import { Link } from "../state/router.js";
import { cn } from "../lib/cn.js";

export interface NavTreeProps {
  /** The page being read, so exactly one entry can be marked current. */
  slug: string;
  /** The slugs the build actually produced a page for. */
  known: ReadonlySet<string>;
  /** Called after a link is followed, so the mobile drawer can close itself. */
  onNavigate?: () => void;
}

const ROW =
  "block rounded-lg py-1.5 pl-3 pr-2 text-[0.8125rem] leading-snug transition-colors " +
  "border-l-2 -ml-px";

const NavRow = ({
  slug,
  label,
  current,
  known,
  onNavigate,
}: {
  slug: string;
  label: string;
  current: boolean;
  known: boolean;
  onNavigate?: () => void;
}) => {
  if (!known) {
    return (
      <li>
        <span
          aria-disabled="true"
          title="This page is in the sidebar but has not been written yet."
          className={cn(ROW, "cursor-not-allowed border-l-transparent text-ink-subtle opacity-45")}
        >
          {label}
        </span>
      </li>
    );
  }

  return (
    <li>
      <Link
        to={pathOfSlug(slug)}
        aria-current={current ? "page" : undefined}
        onClick={() => onNavigate?.()}
        className={cn(
          ROW,
          current
            ? "border-l-brand bg-brand-soft font-medium text-brand"
            : "border-l-transparent text-ink-muted hover:bg-hover hover:text-ink",
        )}
      >
        {label}
      </Link>
    </li>
  );
};

/**
 * The list itself, with no column around it.
 *
 * Separate from `Sidebar` because the mobile drawer renders the same tree, and a
 * mobile nav that was the desktop sidebar with `display: none` lifted off it is
 * the thing this site is not allowed to have.
 */
export const NavTree = ({ slug, known, onNavigate }: NavTreeProps) => (
  <nav aria-label="Documentation" className="space-y-5">
    {NAV.map((group, index) => (
      <div key={group.label ?? `loose-${index}`}>
        {group.label ? (
          <h2 className="mb-1.5 px-3 text-[0.6875rem] font-semibold uppercase tracking-wider text-ink-subtle">
            {group.label}
          </h2>
        ) : null}
        {/*
          The rule is the group's left edge, and the current row's own left border
          sits on top of it. That is what makes the marker read as a position in a
          list rather than as a decoration stuck to one row.
        */}
        <ul className={cn("space-y-px", group.label && "border-l border-line")}>
          {group.pages.map((page) => (
            <NavRow
              key={page.slug}
              slug={page.slug}
              label={page.label}
              current={page.slug === slug}
              known={known.has(page.slug)}
              {...(onNavigate ? { onNavigate } : {})}
            />
          ))}
        </ul>
      </div>
    ))}
  </nav>
);

/**
 * The desktop column.
 *
 * Sticky under the header and scrolling on its own, so the nav does not travel
 * with a long reference page — `100dvh` rather than `100vh` because on a phone in
 * landscape the two differ by the height of the browser's own chrome, and the
 * bottom entries would be under it.
 */
export const Sidebar = ({ slug, known }: Omit<NavTreeProps, "onNavigate">) => (
  <aside className="sticky top-14 hidden h-[calc(100dvh-3.5rem)] w-[16.5rem] shrink-0 overflow-y-auto border-r border-line py-8 pl-4 pr-3 lg:block">
    <NavTree slug={slug} known={known} />
  </aside>
);
