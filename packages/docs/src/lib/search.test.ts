// What this covers, one test per rule the ranking promises:
//
//  - every query term has to appear somewhere in the document (the AND)
//  - title beats headings beats description beats body
//  - a page whose title is the query comes first
//  - a whole word beats a prefix beats a match inside a word
//  - dotted, dashed and slashed terms stay findable whole (`sandboxer.yaml`, `--ttl`,
//    `plan.json`, `edit-and-reload`, `/caches/go`) and `--ttl` does not match bare "ttl"
//  - case and diacritics are folded, and the snippet still shows the original
//  - the hit carries the heading whose section matched best, and null when only the
//    title did
//  - the snippet's mark offsets index the snippet's own text
//  - the snippet is cut at word boundaries and ellipsised
//  - the limit, and an empty query
//  - `buildIndex` and `search` agree, and the index is reused
//  - a smoke test over the real pages under `docs/`: no assertions about prose,
//    only that nothing falls over and the offsets stay inside the snippet
//
// The ranking assertions all run against the fixture corpus below rather than the
// real pages, because the real pages are being rewritten and a test that asserted
// on their prose would fail on somebody else's paragraph.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { Heading, SearchDoc } from "../types.js";
import { buildIndex, fold, queryTerms, search } from "./search.js";

const h = (id: string, text: string, depth: 2 | 3 = 2): Heading => ({ depth, id, text });

const doc = (over: Partial<SearchDoc> & { slug: string }): SearchDoc => ({
  title: over.slug,
  description: "",
  headings: [],
  text: "",
  ...over,
});

const slugs = (hits: readonly { slug: string }[]): string[] => hits.map((hit) => hit.slug);

describe("every query term must appear somewhere in the document", () => {
  const corpus = [
    doc({
      slug: "guides/docker-capacity",
      title: "Giving Docker the whole machine",
      description: "How much memory and how many cores Docker may use.",
      headings: [h("how-much-memory", "How much memory")],
      text: "Docker Desktop starts with a fraction of the machine. How much memory it may use is a setting, and eight gigabytes is the floor.",
    }),
    doc({
      slug: "getting-started/install",
      title: "Install it",
      text: "Docker has to be running before anything else here works.",
    }),
  ];

  it("finds the page that has both terms", () => {
    expect(slugs(search(corpus, "docker memory"))).toEqual(["guides/docker-capacity"]);
  });

  it("drops a page that has only one of them", () => {
    const hits = search(corpus, "docker memory");
    expect(slugs(hits)).not.toContain("getting-started/install");
  });
});

it("weights title over headings over description over body", () => {
  const corpus = [
    doc({ slug: "in-body", title: "Alpha", text: "A paragraph that mentions secrets once." }),
    doc({ slug: "in-title", title: "Handling secrets", text: "A paragraph about nothing." }),
    doc({ slug: "in-description", title: "Gamma", description: "One sentence about secrets." }),
    doc({ slug: "in-heading", title: "Delta", headings: [h("where", "Where secrets come from")] }),
  ];

  expect(slugs(search(corpus, "secrets"))).toEqual([
    "in-title",
    "in-heading",
    "in-description",
    "in-body",
  ]);
});

it("puts a page whose title is the query first", () => {
  const corpus = [
    doc({
      slug: "guides/managed-sandboxes",
      title: "Projects, worktrees and lifetimes",
      description: "Databases, worktrees and how long a sandbox lives.",
      headings: [h("databases", "Databases")],
      text: "Databases. ".repeat(80),
    }),
    doc({ slug: "databases", title: "Databases", description: "One database per sandbox." }),
  ];

  expect(slugs(search(corpus, "databases"))[0]).toBe("databases");
});

it("prefers a whole word over a prefix over a match inside a word", () => {
  const corpus = [
    doc({ slug: "inside", title: "Gamma", text: "A catalog of every setting." }),
    doc({ slug: "word", title: "Alpha", text: "The log is written to a file." }),
    doc({ slug: "prefix", title: "Beta", text: "The logs are written to a file." }),
  ];

  expect(slugs(search(corpus, "log"))).toEqual(["word", "prefix", "inside"]);
});

describe("terms with punctuation in them stay findable whole", () => {
  const corpus = [
    doc({
      slug: "configuration/sandboxer-yaml",
      title: "sandboxer.yaml, field by field",
      text: "Every field of sandboxer.yaml, with its default.",
    }),
    doc({
      slug: "architecture/plan-json",
      title: "plan.json",
      text: "The resolved plan.json is what the driver reads.",
    }),
    doc({
      slug: "reference/cli",
      title: "CLI commands",
      text: "sandboxer up --ttl 12h stops a sandbox once it has sat unused that long.",
    }),
    doc({
      slug: "guides/edit-and-reload",
      title: "The edit-and-reload loop",
      text: "The edit-and-reload loop watches the worktree you are working in.",
    }),
    doc({
      slug: "reference/paths",
      title: "Paths",
      text: "The Go module cache is mounted at /caches/go inside the container.",
    }),
    doc({
      slug: "reference/glossary",
      title: "Glossary",
      text: "A ttl is how long something is allowed to live.",
    }),
  ];

  it.each([
    ["sandboxer.yaml", "configuration/sandboxer-yaml"],
    ["yaml", "configuration/sandboxer-yaml"],
    ["plan.json", "architecture/plan-json"],
    ["--ttl", "reference/cli"],
    ["edit-and-reload", "guides/edit-and-reload"],
    ["/caches/go", "reference/paths"],
  ])("finds %s", (query, slug) => {
    expect(slugs(search(corpus, query))[0]).toBe(slug);
  });

  it("does not let --ttl match a bare ttl", () => {
    expect(slugs(search(corpus, "--ttl"))).not.toContain("reference/glossary");
  });
});

describe("case and diacritics are folded", () => {
  const corpus = [
    doc({
      slug: "cafe",
      title: "Naïve defaults",
      text: "The résumé of a sandbox is its labels. Written in a café.",
    }),
  ];

  it("matches regardless of case", () => {
    expect(slugs(search(corpus, "NAÏVE DEFAULTS"))).toEqual(["cafe"]);
  });

  it("matches an unaccented query against accented text", () => {
    expect(slugs(search(corpus, "resume cafe"))).toEqual(["cafe"]);
  });

  it("shows the accented original in the snippet", () => {
    const hit = search(corpus, "cafe")[0];
    expect(hit?.snippet.text).toContain("café");
    const mark = hit?.snippet.marks[0];
    expect(mark && hit?.snippet.text.slice(mark[0], mark[1])).toBe("café");
  });
});

describe("the hit carries the heading whose section matched best", () => {
  const page = doc({
    slug: "reference/paths",
    title: "Paths",
    description: "Where sandboxer puts things.",
    headings: [
      h("what-happens-first", "What happens first"),
      h("the-go-module-cache", "The Go module cache"),
      h("where-to-go-next", "Where to go next"),
    ],
    text:
      "What happens first The container starts and the entrypoint runs. " +
      "The Go module cache The cache is mounted from the host at /caches/go so a rebuild is not a download. " +
      "Where to go next Read the reference.",
  });

  it("picks the heading whose own text matches", () => {
    expect(search([page], "go module cache")[0]?.heading?.id).toBe("the-go-module-cache");
  });

  it("picks the heading a body-only match sits under", () => {
    expect(search([page], "/caches/go")[0]?.heading?.id).toBe("the-go-module-cache");
  });

  it("returns null when only the title matched", () => {
    const hit = search([page], "paths")[0];
    expect(hit?.slug).toBe("reference/paths");
    expect(hit?.heading).toBeNull();
  });
});

describe("the snippet", () => {
  const filler = "alpha beta gamma delta ".repeat(60);
  const page = doc({
    slug: "long",
    title: "A long page",
    text: `${filler}the needle is here ${filler}`,
  });

  it("marks offsets that index its own text", () => {
    const hit = search([page], "needle")[0];
    expect(hit?.snippet.marks.length).toBe(1);
    for (const [from, to] of hit?.snippet.marks ?? []) {
      expect(hit?.snippet.text.slice(from, to)).toBe("needle");
    }
  });

  it("is cut at a word boundary and ellipsised at both ends", () => {
    const hit = search([page], "needle")[0];
    const text = hit?.snippet.text ?? "";
    expect(text.startsWith("…")).toBe(true);
    expect(text.endsWith("…")).toBe(true);
    const words = text.replace(/…/g, "").trim().split(/\s+/);
    expect(words.every((word) => ["alpha", "beta", "gamma", "delta", "the", "needle", "is", "here"].includes(word))).toBe(
      true,
    );
  });

  it("marks every term of a multi-term query in one window", () => {
    const hit = search([page], "the needle")[0];
    const marked = (hit?.snippet.marks ?? []).map(([from, to]) => hit?.snippet.text.slice(from, to));
    expect(marked).toContain("needle");
    expect(marked).toContain("the");
  });

  it("falls back to the description when nothing in the body matched", () => {
    const only = doc({
      slug: "titled",
      title: "Secrets",
      description: "How a secret reaches a sandbox without being written down.",
      text: "This body says nothing about it.",
    });
    const hit = search([only], "secrets")[0];
    expect(hit?.snippet.text).toBe("How a secret reaches a sandbox without being written down.");
    expect(hit?.snippet.marks).toEqual([]);
  });
});

describe("the result set", () => {
  const corpus = Array.from({ length: 6 }, (_, index) =>
    doc({ slug: `p${index}`, title: `Page ${index}`, text: "docker is mentioned here" }),
  );

  it("honours the limit", () => {
    expect(search(corpus, "docker", 2)).toHaveLength(2);
    expect(search(corpus, "docker", 0)).toEqual([]);
  });

  it("is empty for a query with no terms in it", () => {
    expect(search(corpus, "")).toEqual([]);
    expect(search(corpus, "   ")).toEqual([]);
    expect(search(corpus, "  ,  ")).toEqual([]);
  });

  it("finds nothing rather than everything for a term nobody has", () => {
    expect(search(corpus, "kubernetes")).toEqual([]);
  });
});

describe("buildIndex and search are a pair", () => {
  const corpus = [
    doc({ slug: "a", title: "Alpha", text: "docker and memory" }),
    doc({ slug: "b", title: "Beta", text: "docker only" }),
  ];

  it("folds each document once and reuses it", () => {
    const first = buildIndex(corpus);
    const second = buildIndex(corpus);
    expect(first).toHaveLength(2);
    expect(second[0]).toBe(first[0]);
    expect(first[0]?.title).toBe("alpha");
  });

  it("gives the same answer whether or not the index was built first", () => {
    const cold = search([...corpus], "docker memory");
    buildIndex(corpus);
    expect(search(corpus, "docker memory")).toEqual(cold);
  });
});

describe("the query and the fold, on their own", () => {
  it("keeps a term's length through folding, so offsets line up", () => {
    for (const sample of ["Café", "naïve", "RÉSUMÉ", "sandboxer.yaml", "ß", "æther", "日本語"]) {
      expect(fold(sample)).toHaveLength(sample.length);
    }
  });

  it("trims punctuation off the ends of a term but never the middle", () => {
    expect(queryTerms("plan.json. (docker),")).toEqual(["plan.json", "docker"]);
    expect(queryTerms("--ttl .gitignore")).toEqual(["--ttl", ".gitignore"]);
  });

  it("drops duplicate terms", () => {
    expect(queryTerms("docker Docker DOCKER")).toEqual(["docker"]);
  });
});

/* --- the real pages, as a smoke test ------------------------------------- */

const DOCS = fileURLToPath(new URL("../../../../docs/", import.meta.url));

const walk = (dir: string, prefix = ""): string[] =>
  readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return walk(full, `${prefix}${name}/`);
    return name.endsWith(".md") ? [`${prefix}${name}`] : [];
  });

/** The crudest possible stand-in for the build's plain-text extraction. */
const plainish = (body: string): string =>
  body
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/[*_`>#|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const realCorpus = (): SearchDoc[] =>
  walk(DOCS).map((file) => {
    const source = readFileSync(join(DOCS, file), "utf8");
    const body = source.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "");
    const title = /^title:\s*(.+)$/m.exec(source)?.[1]?.trim() ?? file;
    const description = /^description:\s*(.+)$/m.exec(source)?.[1]?.trim() ?? "";
    const headings: Heading[] = [...body.matchAll(/^(##|###)\s+(.+)$/gm)].map((match) => ({
      depth: match[1] === "##" ? 2 : 3,
      id: (match[2] ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
      text: (match[2] ?? "").replace(/[`*_]/g, ""),
    }));
    return {
      slug: file.replace(/\.md$/, "").replace(/(^|\/)index$/, ""),
      title,
      description,
      headings,
      text: plainish(body),
    };
  });

describe("the real pages under docs/", () => {
  const corpus = realCorpus();

  it("has pages to search", () => {
    expect(corpus.length).toBeGreaterThan(20);
  });

  it("answers a spread of queries without falling over", () => {
    const queries = [
      "sandboxer.yaml",
      "docker memory",
      "--ttl",
      "traefik hostname",
      "plan.json",
      "secrets",
      "worktree",
      "dashboard login",
      "postgres",
      "zzzznothing",
    ];
    for (const query of queries) {
      const hits = search(corpus, query);
      expect(hits.length).toBeLessThanOrEqual(10);
      for (const hit of hits) {
        expect(hit.score).toBeGreaterThan(0);
        for (const [from, to] of hit.snippet.marks) {
          expect(from).toBeGreaterThanOrEqual(0);
          expect(to).toBeLessThanOrEqual(hit.snippet.text.length);
          expect(fold(hit.snippet.text.slice(from, to))).toHaveLength(to - from);
        }
      }
    }
  });

  // A guard against an accidental quadratic, not a benchmark: the real budget is
  // one keystroke, and the measured figure is in the commit message. Deliberately
  // generous so it cannot flake on a loaded machine.
  it("runs a keystroke's worth of queries well inside a frame budget", () => {
    const started = performance.now();
    for (const query of "giving docker the whole machine".split("")) search(corpus, query);
    expect(performance.now() - started).toBeLessThan(2000);
  });
});
