/**
 * Joins class names, dropping anything falsy.
 *
 * A copy of `packages/web/src/lib/cn.ts` rather than an import of it, and the
 * duplication is deliberate. This site does not depend on `@jef/web` at all —
 * it is the engine's documentation and the dashboard is Jef's, so the only
 * thing the two share is `@sandboxr/tokens`, a package that is one stylesheet.
 * Even if the dependency were allowed, reaching into the dashboard's `src/` from
 * here would make every file it happens to import part of this site's build
 * graph, and the first one to pull in `@xterm/xterm` would put a terminal
 * emulator in the documentation bundle.
 *
 * **The design system is shared, the code is not.** That is the whole boundary:
 * `tokens.css` is imported so the two apps cannot drift on a colour, and eleven
 * lines like these are copied so they cannot drag a dependency across.
 *
 * Deliberately not `clsx` or `tailwind-merge`. Nothing here needs conflict
 * resolution between two competing Tailwind utilities — where two variants of a
 * component would fight over the same property, the component picks one with a
 * conditional instead — and a dependency to concatenate strings is a dependency
 * to audit.
 */
export const cn = (...parts: (string | false | null | undefined)[]): string =>
  parts.filter(Boolean).join(" ");
