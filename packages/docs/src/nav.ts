// The sidebar, by hand.
//
// **This list is the site's table of contents and nothing derives it.** A page
// that exists under `docs/` and is not named here renders at its URL and is
// reachable by nobody; a name here with no file behind it is a dead link in every
// sidebar on the site. `nav.test.ts` fails on either, which is the only reason it
// is safe to maintain a list by hand at all.
//
// It is a list rather than a filesystem walk because order is editorial. "Install
// it" comes before "Your first sandbox" because you cannot do the second without
// the first, and no sorting rule knows that. The order here is also the order of
// the prev/next links at the foot of each page, so it is the reading order of the
// whole site.
//
// **A label must equal the page's `title` frontmatter** — see AUTHORING.md. The
// sidebar and the page heading disagreeing is how a reader ends up unsure whether
// they clicked the right thing.

/** One page in the sidebar. `slug` is the empty string for the front page. */
export interface NavPage {
  slug: string;
  label: string;
}

/**
 * A run of pages under one heading.
 *
 * `label: null` is a group of loose pages rendered without a heading, which is
 * what the front matter of the site and the two or three standalone pages want —
 * a heading over a single page is a heading that says nothing.
 */
export interface NavGroup {
  label: string | null;
  pages: NavPage[];
}

export const NAV: readonly NavGroup[] = [
  {
    label: null,
    pages: [
      { slug: "", label: "Welcome" },
      { slug: "introduction", label: "What sandboxr is" },
      { slug: "how-it-works", label: "How it works, in five steps" },
    ],
  },
  {
    label: "Getting started",
    pages: [
      { slug: "getting-started", label: "Start here" },
      { slug: "getting-started/install", label: "Install it" },
      { slug: "getting-started/first-sandbox", label: "Your first sandbox" },
      { slug: "getting-started/demo-project", label: "Run the demo project" },
      { slug: "getting-started/every-worktree", label: "Every worktree at once" },
    ],
  },
  {
    label: "Choosing a setup",
    pages: [
      { slug: "setups", label: "Which setup is yours" },
      { slug: "setups/cli-only", label: "Just the CLI, on my laptop" },
      { slug: "setups/dashboard-on-a-laptop", label: "The dashboard on my laptop" },
      { slug: "setups/shared-server", label: "On a server, for a team" },
      { slug: "setups/one-repo-many-worktrees", label: "One repo, many branches" },
      { slug: "setups/many-projects", label: "Several repositories at once" },
    ],
  },
  {
    label: "Using it day to day",
    pages: [
      { slug: "guides", label: "Day to day" },
      { slug: "guides/lifecycle", label: "Start, stop, list, clean up" },
      { slug: "guides/edit-and-reload", label: "The edit–reload loop" },
      { slug: "guides/logs-and-shells", label: "Logs, shells and terminals" },
      { slug: "guides/dashboard", label: "The dashboard" },
      { slug: "guides/managed-sandboxes", label: "Projects, worktrees and lifetimes" },
      { slug: "guides/testing-a-migration", label: "Testing a migration" },
      { slug: "guides/agents-in-a-sandbox", label: "Your own agent in a sandbox" },
      { slug: "guides/agent-sessions", label: "Agent sessions in the dashboard" },
      { slug: "guides/docker-capacity", label: "Giving Docker the whole machine" },
    ],
  },
  {
    label: "Describing your project",
    pages: [
      { slug: "configuration", label: "Build your config, step by step" },
      { slug: "configuration/sandboxr-yaml", label: "sandboxr.yaml, field by field" },
      { slug: "configuration/rules", label: "The rules a config must obey" },
      { slug: "configuration/runtime-kinds", label: "The three runtime kinds" },
      { slug: "configuration/secrets", label: "Secrets" },
      { slug: "configuration/examples", label: "Worked examples" },
    ],
  },
  {
    label: null,
    pages: [
      { slug: "databases", label: "Databases" },
      { slug: "access", label: "Access and security" },
    ],
  },
  {
    label: "How it is built",
    pages: [
      { slug: "architecture", label: "The shape of it" },
      { slug: "architecture/packages", label: "Package by package" },
      { slug: "architecture/request-path", label: "How a request arrives" },
      { slug: "architecture/startup", label: "The startup graph" },
      { slug: "architecture/plan-json", label: "plan.json" },
      { slug: "architecture/state", label: "State lives in labels" },
      { slug: "architecture/decisions", label: "Design decisions" },
    ],
  },
  {
    label: "Look it up",
    pages: [
      { slug: "reference", label: "Reference" },
      { slug: "reference/cheat-sheet", label: "Cheat sheet" },
      { slug: "reference/cli", label: "CLI commands" },
      { slug: "reference/environment", label: "Environment variables" },
      { slug: "reference/paths", label: "Paths" },
      { slug: "reference/glossary", label: "Glossary" },
      { slug: "reference/agent-prompts", label: "Every agent prompt" },
      { slug: "reference/status", label: "What is built" },
    ],
  },
  {
    label: null,
    pages: [{ slug: "troubleshooting", label: "Troubleshooting" }],
  },
];

/** Every page in sidebar order: the site's reading order, and prev/next. */
export const NAV_ORDER: readonly NavPage[] = NAV.flatMap((group) => group.pages);

/** The label the sidebar gives a slug, or undefined if the nav does not list it. */
export const labelOf = (slug: string): string | undefined =>
  NAV_ORDER.find((page) => page.slug === slug)?.label;

/**
 * What comes before and after a page in the reading order.
 *
 * Group boundaries are deliberately not walls. "Every worktree at once" is the
 * last page of Getting started and "Which setup is yours" is the first of the next
 * group, and that is exactly the step a first-time reader should be offered — a
 * next link that stopped at the end of a group would strand them there.
 */
export const neighbours = (slug: string): { prev: NavPage | null; next: NavPage | null } => {
  const at = NAV_ORDER.findIndex((page) => page.slug === slug);
  if (at < 0) return { prev: null, next: null };
  return {
    prev: NAV_ORDER[at - 1] ?? null,
    next: NAV_ORDER[at + 1] ?? null,
  };
};
