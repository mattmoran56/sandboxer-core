/**
 * The slug a worktree was *given*, for the worktrees derivation cannot name
 * uniquely.
 *
 * §3.1 prefers a ticket-style id found anywhere in the worktree directory name
 * over the branch, and that rule is deliberate: it is what makes a slug read as
 * `eng-3941` instead of `feat-eng-3941-labs-answers-page`. Its cost is that
 * **two branches on one ticket derive one slug**:
 *
 *     wt/feat-eng-3941-labs-answers-page   feat/eng-3941-labs-answers-page  -> eng-3941
 *     wt/feat-eng-3941-labs-run-selector   feat/eng-3941-labs-run-selector  -> eng-3941
 *
 * Everything is keyed on `<project>-<slug>`, so that is not two sandboxes with a
 * confusing pair of names — it is one sandbox. The container, all four volumes,
 * the router's host rule, the migration advisory lock and the `state/name` and
 * `state/attach` files are shared, and `up` replaces a container it finds rather
 * than refusing, so starting the second worktree tears the first one's sandbox
 * down and hands its database to a branch that never wrote it.
 *
 * The rule, from §3.1: on collision the second worktree is **given** a slug —
 * `<base>-<token>`, four random characters — rather than refused. Refusing would
 * make the readable-ticket rule a trap in exactly the case it is most useful.
 * The given slug is sized against the *project's* ceiling and not the tool's, so
 * a collision cannot be the thing that pushes a hostname over its DNS label — see
 * `uniqueSlug`.
 *
 * **A random token cannot be re-derived, so it has to be written down.** That is
 * this file. It follows worktree-name.ts's precedent for where mutable host
 * state may live (§4.2, §4.2.1) and passes the same test — it records a decision
 * nothing observes, it names the worktree rather than a container instance, so
 * there is no `sandboxer.created` stamp, and a stale file is inert. Two
 * differences from the display name are worth stating, because both follow from
 * what this value *is*:
 *
 *  - **The key is the worktree's directory name, never its slug.** The slug is
 *    the thing being decided. Keying it on the answer would be circular, and the
 *    directory name is unique by construction where the slug is not.
 *  - **The value is load-bearing where a display name is decoration.** It is the
 *    container name, the hostname and the lock name, so it is validated on the
 *    way in and on the way back out through the same function, and a file that
 *    is not a slug reads as *no recorded slug* — the worktree derives its slug
 *    again, which is the behaviour of every worktree that never collided — rather
 *    than throwing on a listing or putting somebody's hand-edit into a hostname.
 *
 * Every read path must come through `slugFor`. `up`, the dashboard's worktree
 * view and the CLI's listing each used to call `deriveSlug` directly, and one of
 * them still deriving while another read a recorded value is the drift this
 * codebase keeps warning about: the dashboard would show one slug and `up` would
 * start another.
 */

import { open, mkdir, rm, writeFile } from "node:fs/promises";
import { randomInt } from "node:crypto";
import { basename, dirname } from "node:path";

import { workspaceWorktree } from "./config/locate.js";
import { NamingError, SLUG_MAX, deriveSlug, sanitizeSlug, type DeriveSlugInput } from "./naming.js";
import { paths } from "./paths.js";

/**
 * How many characters of randomness a given slug carries.
 *
 * Four, and not a UUID, because the budget it is spending is tight and there are
 * two ceilings on it. `SLUG_MAX` is 31, because the slug ends up inside a MySQL
 * `GET_LOCK` name that truncates at 64 characters; and `slugCeiling` lowers that
 * further for a project whose own name and longest hostname label already spend
 * most of the 63 characters of the single DNS label a sandbox hostname is. A
 * 36-character UUID would blow both outright, and would also destroy the
 * readability the ticket-id rule exists to provide — the point of the rule is
 * that `eng-3941-7k2f` is still a name somebody can read off a screen and type
 * into a URL. Four characters of `[a-z0-9]` is 1.7 million values against the two
 * or three worktrees a ticket ever has at once, and the generator re-rolls
 * against the taken set anyway, so the budget is spent on readability rather
 * than on collision headroom nothing needs.
 */
export const SLUG_TOKEN_LEN = 4;

/**
 * The alphabet a token is drawn from.
 *
 * The same `[a-z0-9]` a sanitised slug is already made of, minus the dash: a
 * token that could contain a dash would make `<base>-<token>` ambiguous to read
 * and could produce a trailing one.
 */
const TOKEN_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** How many times a token is re-rolled before the generator gives up. */
const TOKEN_ATTEMPTS = 64;

/**
 * A slug that has been written down, or null when the value is not one.
 *
 * Never throws, and is the same check on the way in and on the way back out.
 * The shape it enforces is exactly `sanitizeSlug`'s output — that is what makes
 * a recorded slug substitutable for a derived one everywhere a slug is used.
 */
export function normaliseRecordedSlug(raw: string): string | null {
  const slug = raw.trim();
  if (slug === "" || slug.length > SLUG_MAX) return null;
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) return null;
  return slug;
}

/**
 * How many bytes of the file are worth reading.
 *
 * Bounded rather than a `readFile`, for worktree-name.ts's reason: this is a
 * path in somebody's home directory and nothing stops a file appearing there
 * with a gigabyte in it. A slug is ASCII by construction, so the ceiling plus
 * room for a trailing newline is the whole budget — a file that fills the buffer
 * is known to be longer than a slug may be and is refused rather than truncated
 * into a different slug than the file contains.
 */
const READ_LIMIT = SLUG_MAX + 8;

/** The slug written down for one worktree, or null when it has none. */
export async function readRecordedSlug(
  project: string,
  worktreeDir: string,
  env?: NodeJS.ProcessEnv,
): Promise<string | null> {
  let handle;
  try {
    handle = await open(paths(env).slugFile(project, worktreeDir), "r");
  } catch {
    return null;
  }

  try {
    const buffer = Buffer.alloc(READ_LIMIT);
    const { bytesRead } = await handle.read(buffer, 0, READ_LIMIT, 0);
    if (bytesRead === READ_LIMIT) return null;
    return normaliseRecordedSlug(buffer.toString("utf8", 0, bytesRead));
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => {});
  }
}

/**
 * Writes down the slug one worktree is to be addressed by.
 *
 * Throws for a value that is not a slug, which is the one place this file is
 * strict: everything downstream builds a container name and a hostname out of
 * it, and a bad value written here would be read back as *no slug* on the next
 * call and silently move the sandbox.
 */
export async function writeRecordedSlug(
  project: string,
  worktreeDir: string,
  slug: string,
  env?: NodeJS.ProcessEnv,
): Promise<string> {
  const recorded = normaliseRecordedSlug(slug);
  if (recorded === null) throw new NamingError(`"${slug}" is not a slug and cannot be recorded`);

  const file = paths(env).slugFile(project, worktreeDir);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${recorded}\n`, "utf8");
  return recorded;
}

/**
 * Forgets a worktree's recorded slug.
 *
 * Tidiness rather than correctness, like `removeDisplayName`: a record left
 * behind names a directory that is gone, and nothing reads it until a worktree
 * of that directory name exists again.
 */
export async function removeRecordedSlug(project: string, worktreeDir: string, env?: NodeJS.ProcessEnv): Promise<void> {
  await rm(paths(env).slugFile(project, worktreeDir), { force: true });
}

/** Four characters of `[a-z0-9]`. `uniqueSlug` takes it as an argument so a test can pin it. */
export function slugToken(): string {
  let token = "";
  // `randomInt` rather than `randomBytes` modulo the alphabet: 36 does not
  // divide 256, so the modulo would quietly favour the first twenty letters.
  for (let index = 0; index < SLUG_TOKEN_LEN; index += 1) token += TOKEN_ALPHABET[randomInt(TOKEN_ALPHABET.length)];
  return token;
}

/**
 * A slug that reads like `base` and is not in `taken`.
 *
 * **`max` is the project's ceiling, not the tool's, and passing the wrong one
 * breaks a hostname rather than a name.** `slugCeiling` lowers `SLUG_MAX` for a
 * project whose name and longest hostname label already spend the 63 characters
 * of the one DNS label a sandbox hostname is (contracts §3.1, §3.2). A given
 * slug is subject to that budget exactly like a derived one — it is the same
 * slug, in the same hostname — so sizing `<base>-<token>` against a flat 31 here
 * would let a collision be the one thing that pushes a label over 63. The
 * symptom of that is a hostname that resolves to nothing, which reads as a
 * broken router and not as a naming bug.
 *
 * Clamped rather than trusted, the way `sanitizeSlug` clamps: a caller handing
 * in a DNS budget that happens to exceed `SLUG_MAX` must not raise the lock-name
 * ceiling.
 *
 * Trailing dashes are stripped from the trimmed base so the join never produces
 * `--` — which, since the hostname became one flat label, is the separator
 * between its components and has no reading inside one.
 */
export function uniqueSlug(
  base: string,
  taken: Iterable<string>,
  token: () => string = slugToken,
  max: number = SLUG_MAX,
): string {
  const used = new Set(taken);
  const ceiling = Math.min(max, SLUG_MAX);
  const room = ceiling - (SLUG_TOKEN_LEN + 1);
  const trimmed = base.slice(0, room).replace(/-+$/, "");
  if (trimmed === "") throw new NamingError(`cannot build a unique slug from "${base}"`);

  for (let attempt = 0; attempt < TOKEN_ATTEMPTS; attempt += 1) {
    const candidate = `${trimmed}-${token()}`;
    if (!used.has(candidate)) return candidate;
  }
  throw new NamingError(`could not find a free slug for "${base}" after ${TOKEN_ATTEMPTS} attempts`);
}

export interface SlugForInput {
  /** An explicit slug, which always wins — over a recorded one too. */
  explicit?: string | undefined;
  /** Absolute path to the top of the worktree. */
  worktree?: string | undefined;
  /**
   * The workspace project *directory* name, when the caller already knows it.
   *
   * Optional because it can be read back out of the path for a worktree inside
   * the workspace, which is the only kind that has a record at all.
   */
  project?: string | undefined;
  branch?: string | undefined;
  ticketPattern?: RegExp | undefined;
  /**
   * The project's slug ceiling, from `slugCeilingFor`. Absent means `SLUG_MAX`.
   *
   * Passed rather than looked up, for `DeriveSlugInput.max`'s reason: it is a
   * property of the project's config, and this module resolves slugs for
   * worktrees whose config it has deliberately not read.
   */
  max?: number | undefined;
  env?: NodeJS.ProcessEnv | undefined;
}

export interface WorktreeKey {
  /** The workspace project *directory* name. */
  project: string;
  /** The worktree directory's basename. */
  worktreeDir: string;
}

/**
 * What identifies one worktree in the store, or undefined for a worktree that
 * cannot have a record.
 *
 * The path is matched against the workspace rather than split by hand, so a
 * caller standing several directories deep inside a worktree still keys on the
 * worktree itself.
 *
 * **A checkout outside the workspace has no key, and that is the scope of the
 * whole mechanism.** sandboxer only cuts worktrees under `<workspace>/<project>/wt`
 * (§4.1), so those are the only ones it can have detected a collision for. A
 * worktree somebody keeps in their own `.worktrees/` is theirs, sandboxer never
 * created it, and keying it on some enclosing directory's name would invent a
 * record for a directory this code has never seen — and read it back into a
 * hostname.
 */
export function worktreeKey(
  worktree: string | undefined,
  project: string | undefined,
  env?: NodeJS.ProcessEnv,
): WorktreeKey | undefined {
  if (worktree === undefined || worktree === "") return undefined;
  const managed = workspaceWorktree(worktree, env);
  if (!managed) return undefined;
  return { project: project ?? managed.project, worktreeDir: basename(managed.worktree) };
}

/**
 * The slug one worktree is addressed by: explicit, then recorded, then derived.
 *
 * `deriveSlug` stays pure — it is the rule, and a rule that did IO could not be
 * reasoned about or tested as one. This is the resolver every read path goes
 * through instead, so `up`, the dashboard and the CLI cannot disagree about
 * which sandbox a worktree owns.
 */
export async function slugFor(input: SlugForInput): Promise<string> {
  // The ceiling applies to a name somebody passed too. `sanitizeSlug` clamps it
  // to `SLUG_MAX`, so handing it through unconditionally is safe.
  if (input.explicit !== undefined && input.explicit.trim() !== "") {
    return sanitizeSlug(input.explicit, input.max ?? SLUG_MAX);
  }

  const key = worktreeKey(input.worktree, input.project, input.env);
  if (key) {
    const recorded = await readRecordedSlug(key.project, key.worktreeDir, input.env);
    if (recorded) return recorded;
  }

  return deriveSlug(slugInputFor(input));
}

/**
 * The derivation input for one worktree.
 *
 * `"?"` is folded to undefined here rather than at each call site. It is what
 * `Worktree.branch` and `gitFacts` report for a branch nothing could recover,
 * and `deriveSlug` would sanitise it to the empty string and throw — `up` and
 * the CLI already dropped it by hand and the dashboard did not, which is one
 * derivation of a slug behaving differently from another.
 */
export function slugInputFor(input: SlugForInput): DeriveSlugInput {
  return {
    worktreeDir: input.worktree === undefined || input.worktree === "" ? undefined : basename(input.worktree),
    branch: input.branch === undefined || input.branch === "?" || input.branch === "" ? undefined : input.branch,
    ticketPattern: input.ticketPattern,
    max: input.max,
  };
}
