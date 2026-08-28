// The foot of a page: where to go next, and where this text came from.
//
// The prev/next pair is `neighbours()` from `src/nav.ts`, which is the site's
// reading order and deliberately does not stop at a group boundary — the page
// after the last of "Getting started" is the first of the next group, and that is
// exactly the step a first-time reader should be offered.
//
// Every page's prose is also supposed to end with its own `**Next:**` line, and
// these links do not replace it. That line says *why* you would read the next
// page; this pair says what is literally next, and is the same shape on every
// page so a reader who has learned where it is can stop reading the prose.

import { neighbours } from "../nav.js";
import { editHref, pathOfSlug, sourceHref } from "../lib/route.js";
import { Link } from "../state/router.js";
import { ChevronLeft, ChevronRight, Clock, External, Pencil } from "./icons.js";

/**
 * The last-commit date, as a person would write it.
 *
 * `undefined` locale rather than a fixed one, so it reads the way the reader's own
 * machine writes dates. `null` is a real answer from the build and not a failure —
 * a page that has been written but not committed has no date — and the row is
 * simply absent then rather than saying "unknown".
 */
const readable = (iso: string): string | null => {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  return at.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
};

const STEP =
  "group flex min-w-0 flex-1 items-center gap-3 rounded-card border border-line bg-surface " +
  "px-4 py-3 transition-colors hover:border-line-strong hover:bg-surface-2";

export const PageFooter = ({
  slug,
  file,
  lastUpdated,
}: {
  slug: string;
  /** The page's path under `docs/`, for the two links to GitHub. */
  file: string;
  lastUpdated: string | null;
}) => {
  const { prev, next } = neighbours(slug);
  const updated = lastUpdated ? readable(lastUpdated) : null;

  return (
    <footer className="mt-14 border-t border-line pt-8">
      {prev || next ? (
        <nav aria-label="Nearby pages" className="flex flex-col gap-3 sm:flex-row">
          {prev ? (
            <Link to={pathOfSlug(prev.slug)} className={STEP} rel="prev">
              <ChevronLeft size={16} className="shrink-0 text-ink-subtle group-hover:text-brand" />
              <span className="min-w-0">
                <span className="block text-[0.6875rem] uppercase tracking-wider text-ink-subtle">
                  Previous
                </span>
                <span className="block truncate text-sm text-ink">{prev.label}</span>
              </span>
            </Link>
          ) : (
            // A spacer so the "next" card stays on the right on a two-card row.
            // Without it the first page of the site puts its only link on the
            // left, which reads as "previous".
            <span className="hidden flex-1 sm:block" aria-hidden="true" />
          )}

          {next ? (
            <Link to={pathOfSlug(next.slug)} className={`${STEP} sm:justify-end`} rel="next">
              <span className="min-w-0 sm:text-right">
                <span className="block text-[0.6875rem] uppercase tracking-wider text-ink-subtle">
                  Next
                </span>
                <span className="block truncate text-sm text-ink">{next.label}</span>
              </span>
              <ChevronRight size={16} className="shrink-0 text-ink-subtle group-hover:text-brand" />
            </Link>
          ) : null}
        </nav>
      ) : null}

      <div className="mt-6 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-ink-subtle">
        <a
          href={editHref(file)}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1.5 transition-colors hover:text-brand"
        >
          <Pencil size={13} />
          Edit this page on GitHub
        </a>
        {/*
          A second link to the same file, read-only. The docs are plain Markdown so
          that they read on GitHub without a build, and somebody who wants the
          source of a page — an agent, usually — should not have to open an edit
          form to get at it.
        */}
        <a
          href={sourceHref(file)}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1.5 transition-colors hover:text-brand"
        >
          View the Markdown
          <External size={12} />
        </a>
        {updated ? (
          <span className="inline-flex items-center gap-1.5" title={`last commit: ${lastUpdated}`}>
            <Clock size={13} />
            Last changed {updated}
          </span>
        ) : null}
      </div>
    </footer>
  );
};
