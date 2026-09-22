// Search, written by hand, because it is the thing the site would otherwise lose.
//
// Starlight came with search. Nothing else here does, and a reference site whose
// search is worse than the browser's find-in-page is a reference site nobody
// looks anything up in. So this file is deliberately more than a `includes()`
// filter, and every rule in it exists because of a query that would otherwise
// have answered badly.
//
// **Nothing is tokenised.** The obvious implementation splits the text into words
// and the query into words and intersects them, and it cannot find any of the
// terms this documentation is mostly made of: a word-splitter turns
// `sandboxer.yaml` into `sandboxer` + `yaml`, `--ttl` into `ttl`, `plan.json` into
// two, and `edit-and-reload` into three — so a reader who types the string they
// are looking at gets nothing, which is the worst possible failure for a docs
// search. Instead the whole folded text is scanned for the term as typed, and a
// *word boundary* is any non-alphanumeric character. That gives dotted and
// hyphenated terms both halves: `sandboxer.yaml` is one findable string, and
// `yaml` still matches it as a whole word because `.` is a boundary.
//
// **Every query term has to appear somewhere in the document.** `docker memory`
// finds the page about giving Docker the whole machine and not the twenty pages
// that say "Docker" once. Ranking cannot fix a result set that is too big; only
// an AND can.
//
// **Speed.** The corpus is about forty pages and half a megabyte, and `search`
// runs on every keystroke. Three things keep that cheap: the case/diacritic fold
// is done once per document and memoised on the document object (see
// `buildIndex`), scoring is `indexOf` scans that stop at the first whole-word
// match, and the expensive part — choosing a heading and cutting a snippet — is
// done only for the handful of documents that survived the sort.

import type { Heading, SearchDoc } from "../types.js";

export interface Hit {
  slug: string;
  title: string;
  /** The heading whose section matched best, when one did. */
  heading: Heading | null;
  /** One line of context with the matched terms marked, as plain text plus ranges. */
  snippet: { text: string; marks: [number, number][] };
  score: number;
}

/* --- folding ------------------------------------------------------------- */

const MARKS = /\p{M}+/gu;

const foldChar = (char: string): string => {
  const code = char.charCodeAt(0);
  if (code >= 65 && code <= 90) return String.fromCharCode(code + 32);
  const stripped = char.normalize("NFD").replace(MARKS, "").toLowerCase();
  // One character in, one character out, always. Every offset this module
  // returns is an index into the *original* string, so the folded copy has to
  // line up with it character for character — a fold that expanded "ß" to "ss"
  // would leave every snippet after the first one cut in the wrong place. Where
  // folding cannot preserve the length the character is left alone instead.
  return stripped.length === 1 ? stripped : (stripped[0] ?? char);
};

/**
 * Case-folded, diacritic-stripped, and exactly as long as it went in.
 *
 * Only the characters that can change are visited, so folding a page of ASCII
 * costs one regex pass with no replacements.
 */
export const fold = (text: string): string => text.replace(/[A-Z]|[^\u0000-\u007f]/g, foldChar);

/** True for a character that can be *inside* a word. Everything else is a boundary. */
const isWordCode = (code: number): boolean =>
  (code >= 97 && code <= 122) || (code >= 48 && code <= 57) || code > 127;

/* --- the query ----------------------------------------------------------- */

// Trimmed off the ends of a term, never out of the middle. `--ttl` keeps its
// dashes and `.gitignore` keeps its dot, because a leading punctuation mark is
// usually part of the thing being looked for; a trailing one almost never is, so
// "plan.json." and "docker," find what they meant to.
const LEADING = /^[\s"'“”‘’(),;:!?]+/;
const TRAILING = /[\s"'“”‘’(),;:!?.]+$/;

/** How many terms are honoured. Past this, a query is prose and not a query. */
const MAX_TERMS = 8;

/** The query, as the terms every result must contain. Folded, deduplicated. */
export const queryTerms = (query: string): string[] => {
  const terms: string[] = [];
  for (const raw of query.split(/\s+/)) {
    const term = fold(raw.replace(LEADING, "").replace(TRAILING, ""));
    if (term.length === 0 || terms.includes(term)) continue;
    terms.push(term);
    if (terms.length === MAX_TERMS) break;
  }
  return terms;
};

/* --- the index ----------------------------------------------------------- */

/** One heading, its folded text, and the run of body text underneath it. */
interface Section {
  heading: Heading;
  folded: string;
  /** Where the section starts in the folded body, or -1 if it could not be located. */
  start: number;
  end: number;
}

/** A document with everything folded once, ready to be scanned. */
export interface IndexedDoc {
  doc: SearchDoc;
  title: string;
  description: string;
  text: string;
  sections: Section[];
}

export type SearchIndex = readonly IndexedDoc[];

// Memoised on the document object rather than kept in an array, so `search` stays
// a pure function of its arguments: the same corpus and query always give the
// same answer, and the cache is only a promise not to fold the same half
// megabyte twice. A WeakMap because the corpus is build output the app may drop.
const folded = new WeakMap<SearchDoc, IndexedDoc>();

/**
 * Fold a corpus, or return the fold made earlier.
 *
 * Exported so a caller can pay for it once — the search dialog does it as soon as
 * the corpus module resolves, which is off the keystroke path — but `search`
 * calls it too, so nobody has to remember.
 */
export const buildIndex = (documents: readonly SearchDoc[]): SearchIndex =>
  documents.map((doc) => {
    const already = folded.get(doc);
    if (already) return already;
    const made = prepare(doc);
    folded.set(doc, made);
    return made;
  });

/**
 * Where each heading's section begins, by finding the heading's own text.
 *
 * The corpus has the body as one line of plain text and the headings as a
 * separate list, with no offsets between them — so the sections are recovered by
 * walking the headings in order and looking for each one's text after the last
 * one found. It is a heuristic and it says so: a heading whose text cannot be
 * located keeps its own text searchable and simply owns no body, which costs a
 * slightly worse anchor and never a wrong one.
 */
const prepare = (doc: SearchDoc): IndexedDoc => {
  const text = fold(doc.text);
  const found = doc.headings.map((heading) => {
    const value = fold(heading.text);
    return { heading, folded: value, start: -1 };
  });

  let cursor = 0;
  for (const entry of found) {
    if (entry.folded.length === 0) continue;
    const at = text.indexOf(entry.folded, cursor);
    if (at < 0) continue;
    entry.start = at;
    cursor = at + entry.folded.length;
  }

  const sections: Section[] = found.map((entry, index) => {
    if (entry.start < 0) return { ...entry, end: -1 };
    let end = text.length;
    for (let next = index + 1; next < found.length; next++) {
      const start = found[next]?.start ?? -1;
      if (start >= 0) {
        end = start;
        break;
      }
    }
    return { ...entry, end };
  });

  return { doc, title: fold(doc.title), description: fold(doc.description), text, sections };
};

/* --- matching ------------------------------------------------------------ */

/** How good a match is: a whole word beats a prefix beats anything inside a word. */
const WORD = 3;
const PREFIX = 2;
const INSIDE = 1;

/** Which field the match was in. A body match can never outweigh a title match. */
const FIELD = { title: 12, heading: 6, description: 4, body: 1 } as const;

/**
 * How far a scan will look for a better occurrence of one term in one field.
 *
 * A common word appears thousands of times in half a megabyte and the tenth
 * occurrence tells the ranking nothing the first fifty did not.
 */
const SCAN_CAP = 128;

interface Match {
  kind: number;
  at: number;
  end: number;
}

const kindAt = (hay: string, at: number, length: number): number => {
  const before = at === 0 || !isWordCode(hay.charCodeAt(at - 1));
  const after = at + length >= hay.length || !isWordCode(hay.charCodeAt(at + length));
  if (before && after) return WORD;
  return before ? PREFIX : INSIDE;
};

/** The best occurrence of `needle` in `hay[from, to)`, or null. */
const bestMatch = (hay: string, needle: string, from = 0, to = hay.length): Match | null => {
  if (needle.length === 0 || from >= to) return null;
  let best: Match | null = null;
  let at = hay.indexOf(needle, from);
  let seen = 0;
  while (at >= 0 && at < to && seen < SCAN_CAP) {
    const kind = kindAt(hay, at, needle.length);
    if (!best || kind > best.kind) best = { kind, at, end: at + needle.length };
    // Nothing beats a whole word, so there is no reason to keep looking.
    if (kind === WORD) break;
    seen++;
    at = hay.indexOf(needle, at + 1);
  }
  return best;
};

/* --- scoring ------------------------------------------------------------- */

/**
 * What a page whose title *is* the query gets.
 *
 * Large enough to be unanswerable: a rival page can collect at most a title, a
 * heading, a description and a body match per term, and the page whose title
 * matches exactly has all of those too.
 */
const EXACT_TITLE = 400;
const TITLE_STARTS = 80;
const PHRASE = { title: 40, description: 12, body: 8 } as const;

/** The whole document's score, or null if some term is missing from it. */
const scoreDoc = (entry: IndexedDoc, terms: readonly string[], phrase: string): number | null => {
  let score = 0;

  for (const term of terms) {
    const inTitle = bestMatch(entry.title, term);
    const inDescription = bestMatch(entry.description, term);
    const inBody = bestMatch(entry.text, term);

    let headingKind = 0;
    for (const section of entry.sections) {
      const inHeading = bestMatch(section.folded, term);
      if (inHeading && inHeading.kind > headingKind) headingKind = inHeading.kind;
      if (headingKind === WORD) break;
    }

    // The AND. A page that does not contain this term is not a result at all,
    // however well it matched the others.
    if (!inTitle && !inDescription && !inBody && headingKind === 0) return null;

    score += inTitle ? FIELD.title * inTitle.kind : 0;
    score += FIELD.heading * headingKind;
    score += inDescription ? FIELD.description * inDescription.kind : 0;
    score += inBody ? FIELD.body * inBody.kind : 0;
  }

  if (entry.title === phrase) score += EXACT_TITLE;
  else if (entry.title.startsWith(phrase)) score += TITLE_STARTS;

  // The terms next to each other, in that order, are worth more than the same
  // terms scattered over a long page — "agent sessions" should find the page
  // about agent sessions rather than the page that mentions agents and sessions
  // in different paragraphs.
  if (terms.length > 1) {
    if (entry.title.includes(phrase)) score += PHRASE.title;
    if (entry.description.includes(phrase)) score += PHRASE.description;
    if (entry.text.includes(phrase)) score += PHRASE.body;
  }

  return score;
};

/* --- the heading a hit points at ---------------------------------------- */

/**
 * The section that matched best, so a hit can link to `#anchor`.
 *
 * This is most of the value of search on a reference site: the pages are long,
 * and an answer that lands a reader at the top of "sandboxer.yaml, field by field"
 * has told them almost nothing. A section counts as matching if the terms are in
 * its heading *or* anywhere in the body underneath it, which is why searching for
 * a value that only appears in a table still lands on the right heading.
 */
const bestHeading = (entry: IndexedDoc, terms: readonly string[]): Heading | null => {
  let best: Heading | null = null;
  let bestScore = 0;

  for (const section of entry.sections) {
    let matched = 0;
    let score = 0;
    for (const term of terms) {
      const inHeading = bestMatch(section.folded, term);
      const inBody =
        section.start >= 0 ? bestMatch(entry.text, term, section.start, section.end) : null;
      if (!inHeading && !inBody) continue;
      matched++;
      score += inHeading ? FIELD.heading * inHeading.kind : 0;
      score += inBody ? FIELD.body * inBody.kind : 0;
    }
    if (matched === 0) continue;
    // A section holding more of the query always wins, however strongly a rival
    // section matched one term.
    const total = matched * 1000 + score;
    if (total > bestScore) {
      bestScore = total;
      best = section.heading;
    }
  }

  return best;
};

/* --- the snippet --------------------------------------------------------- */

/** Roughly one line at the width the results list is read at. */
const WIDTH = 170;
/** How much context to keep before the match the snippet is built around. */
const LEAD = 60;
/** How near two terms have to be to count as being in the same window. */
const NEAR = 90;
/** Occurrences considered per term when choosing where to cut. */
const SPOTS_PER_TERM = 24;

const ELLIPSIS = "…";

interface Spot {
  term: number;
  at: number;
}

const spotsIn = (hay: string, terms: readonly string[]): Spot[] => {
  const spots: Spot[] = [];
  for (let term = 0; term < terms.length; term++) {
    const needle = terms[term] ?? "";
    if (needle.length === 0) continue;
    let at = hay.indexOf(needle);
    let taken = 0;
    while (at >= 0 && taken < SPOTS_PER_TERM) {
      spots.push({ term, at });
      taken++;
      at = hay.indexOf(needle, at + needle.length);
    }
  }
  return spots;
};

/**
 * Where to cut, so the snippet shows as much of the query at once as it can.
 *
 * A two-term query whose terms are a paragraph apart has to pick one, and the
 * useful pick is the occurrence with the most *other* terms beside it: for
 * `docker memory` that is the sentence about Docker's memory, not the first
 * mention of Docker on the page.
 */
const anchorOf = (spots: readonly Spot[], termCount: number): number => {
  let bestAt = spots[0]?.at ?? 0;
  let bestCover = -1;
  for (const spot of spots) {
    const near = new Set<number>();
    for (const other of spots) {
      if (Math.abs(other.at - spot.at) <= NEAR) near.add(other.term);
    }
    const cover = near.size;
    if (cover > bestCover) {
      bestCover = cover;
      bestAt = spot.at;
    }
    if (cover === termCount) break;
  }
  return bestAt;
};

const mergeMarks = (marks: [number, number][]): [number, number][] => {
  marks.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: [number, number][] = [];
  for (const mark of marks) {
    const last = merged[merged.length - 1];
    if (last && mark[0] <= last[1]) last[1] = Math.max(last[1], mark[1]);
    else merged.push([mark[0], mark[1]]);
  }
  return merged;
};

/**
 * One line of context, cut at word boundaries, with the matched ranges as offsets.
 *
 * Offsets and not HTML: a library that returned `<mark>` tags would be a library
 * that decides how a hit looks, and the component would have to trust it with
 * `dangerouslySetInnerHTML` over text it did not escape.
 */
const windowOf = (
  raw: string,
  hay: string,
  terms: readonly string[],
  anchor: number,
): Hit["snippet"] => {
  let start = Math.max(0, anchor - LEAD);
  if (start > 0) {
    // Forward to the start of the next whole word, so a snippet never opens
    // half way through one.
    const space = hay.indexOf(" ", start);
    if (space >= 0 && space < anchor) start = space + 1;
  }

  let end = Math.min(hay.length, start + WIDTH);
  if (end < hay.length) {
    const space = hay.lastIndexOf(" ", end);
    if (space > anchor) end = space;
  }

  const head = start > 0 ? ELLIPSIS : "";
  const tail = end < hay.length ? ELLIPSIS : "";
  const shift = head.length - start;

  const marks: [number, number][] = [];
  for (const term of terms) {
    if (term.length === 0) continue;
    let at = hay.indexOf(term, start);
    while (at >= 0 && at < end) {
      marks.push([at + shift, Math.min(at + term.length, end) + shift]);
      at = hay.indexOf(term, at + term.length);
    }
  }

  return { text: head + raw.slice(start, end) + tail, marks: mergeMarks(marks) };
};

const snippetOf = (entry: IndexedDoc, terms: readonly string[]): Hit["snippet"] => {
  const inBody = spotsIn(entry.text, terms);
  if (inBody.length > 0) {
    return windowOf(entry.doc.text, entry.text, terms, anchorOf(inBody, terms.length));
  }
  // Nothing in the body: the match was in the title or a heading, and the
  // description is what a reader wants to see instead of the page's first line.
  if (entry.description.length > 0) {
    const inDescription = spotsIn(entry.description, terms);
    return windowOf(
      entry.doc.description,
      entry.description,
      terms,
      anchorOf(inDescription, terms.length),
    );
  }
  return windowOf(entry.doc.text, entry.text, terms, 0);
};

/* --- the search ---------------------------------------------------------- */

/** How many hits a caller gets if it does not say. */
const LIMIT = 10;

export const search = (
  documents: readonly SearchDoc[],
  query: string,
  limit: number = LIMIT,
): Hit[] => {
  const terms = queryTerms(query);
  if (terms.length === 0 || limit <= 0) return [];

  const phrase = fold(query.trim().replace(/\s+/g, " "));
  const scored: { entry: IndexedDoc; score: number }[] = [];

  for (const entry of buildIndex(documents)) {
    const score = scoreDoc(entry, terms, phrase);
    if (score !== null && score > 0) scored.push({ entry, score });
  }

  scored.sort(
    (a, b) =>
      b.score - a.score ||
      a.entry.doc.title.localeCompare(b.entry.doc.title) ||
      a.entry.doc.slug.localeCompare(b.entry.doc.slug),
  );

  // Headings and snippets only for the hits that survived. They are the
  // expensive half of this file, and a page that came 30th is never shown.
  return scored.slice(0, limit).map(({ entry, score }) => ({
    slug: entry.doc.slug,
    title: entry.doc.title,
    heading: bestHeading(entry, terms),
    snippet: snippetOf(entry, terms),
    score,
  }));
};
