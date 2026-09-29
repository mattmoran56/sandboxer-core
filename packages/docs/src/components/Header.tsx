// The top bar: what this is, how to search it, and how it looks.
//
// Sticky and solid over a hairline, so the name and the search button stay
// reachable while a long page scrolls under them.
//
// The search *button* is here rather than a bare keyboard shortcut on purpose. A
// shortcut nobody is told about is a feature for the person who wrote it, so the
// button shows ⌘K beside itself and teaches the shortcut to anybody who clicks
// it twice.

import { REPO } from "../lib/route.js";
import { Link } from "../state/router.js";
import { External, Menu, Search as SearchIcon } from "./icons.js";
import { IconButton, Kbd } from "./ui.js";
import { ThemeSwitch } from "./Switches.js";

export const Header = ({
  onSearch,
  onMenu,
}: {
  onSearch: () => void;
  onMenu: () => void;
}) => (
  <header className="sticky top-0 z-20 flex h-14 shrink-0 items-center gap-2 border-b border-line bg-surface px-3 sm:gap-3 sm:px-4">
    <IconButton label="Open navigation" className="lg:hidden" onClick={onMenu}>
      <Menu size={18} />
    </IconButton>

    {/* The plain word and nothing else: the engine has no logo and no brand. */}
    <Link to="/" className="rounded-lg focus-visible:outline-offset-4">
      <span className="text-lg font-semibold leading-none tracking-tight text-ink">sandboxer</span>
    </Link>

    <div className="ml-auto flex items-center gap-2">
      {/*
        A button and not a text input. The input is inside the dialog, and a
        second one out here would be a box that steals focus, cannot show results
        under itself and has to be kept in step with the real one.
      */}
      <button
        type="button"
        onClick={onSearch}
        className="flex h-9 items-center gap-2 rounded-lg border border-line bg-surface px-2.5 text-sm text-ink-subtle transition-colors hover:border-line-strong hover:text-ink"
      >
        <SearchIcon size={15} />
        <span className="hidden sm:inline">Search</span>
        <Kbd className="ml-1 hidden sm:inline">⌘K</Kbd>
      </button>

      <ThemeSwitch />

      <a
        href={REPO}
        target="_blank"
        rel="noreferrer"
        title="sandboxer on GitHub"
        className="hidden h-9 items-center gap-1.5 rounded-lg px-2.5 text-sm text-ink-muted transition-colors hover:bg-hover hover:text-ink md:inline-flex"
      >
        GitHub
        <External size={13} />
      </a>
    </div>
  </header>
);
