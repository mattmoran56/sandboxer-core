/**
 * A worktree's display name: one file holding a label a person chose.
 *
 * A worktree is addressed by its slug and shown by its branch (contracts §3.1,
 * §4.1.1), and both are derived. Neither is a sentence anybody wrote — a row
 * reading `feat-4821` says which ticket it is and nothing about what is being
 * done in it. This file lets somebody call that worktree "the checkout flow
 * rewrite" and see it under that name.
 *
 * **The name is presentation and nothing else.** It never reaches the slug, the
 * hostname, the container name, a route or a URL: those are derived from the
 * branch and the directory, they are load-bearing, and a label somebody can
 * retype at any moment must not be able to move them. Renaming a worktree
 * changes one line on a screen and no address anywhere.
 *
 * It is written to `~/.sandboxer/state/name/<project>/<slug>`, following the
 * keep-alive marker's precedent for where mutable host state may live
 * (contracts §4.2, §4.2.1). Two differences from that file are deliberate:
 *
 *  - **The key's `<project>` is the workspace *directory* name**, the one §4.1
 *    calls the key and the one every worktree route already uses — not the
 *    `project:` a sandboxer.yaml declares, which is what labels a container. The
 *    two are allowed to differ, and this file names a directory on disk.
 *  - **There is no `sandboxer.created` stamp**, and there must not be one. The
 *    keep marker names a *container instance* because keeping a dead sandbox's
 *    successor alive would be wrong; a name belongs to the worktree, which is
 *    the thing that persists. Stamping it would throw the name away every time
 *    the sandbox on it was stopped and recreated — a rename that quietly undoes
 *    itself the next time somebody presses Rebuild.
 *
 * The file is read back through the same validation it is written through,
 * because it is a plain text file in somebody's home directory and the value
 * ends up on a page. A file that has been edited by hand into something that is
 * not a name reads as *no name*, so the worktree shows its branch again — which
 * is visible, harmless and undoable, rather than silently rewritten on disk.
 */

import { mkdir, open, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { paths } from "./paths.js";

/**
 * How long a display name may be, in code points.
 *
 * It sits in a sidebar row beside a slug and a branch, so this is about as much
 * as can be read at a glance. Longer than this is not a name, it is a note, and
 * a note has nowhere to be displayed. Counted in code points and not UTF-16
 * units so that an emoji or an accented letter costs one character rather than
 * two.
 */
export const DISPLAY_NAME_MAX = 60;

/**
 * Characters a name may not contain, whoever typed them.
 *
 * C0 and C1 controls, plus U+2028 and U+2029. All of them are refused for one
 * reason: every one is a line break or an invisible instruction to *something*
 * downstream — a terminal, a JSON parser, a browser's line breaker — and a
 * label is a single line of text on a screen. The two separators are here
 * rather than covered by `\n` because a browser breaks a line on them and most
 * "no newlines" checks do not.
 */
const FORBIDDEN = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/;

export class DisplayNameError extends Error {
  override readonly name = "DisplayNameError";
}

/**
 * What will actually be stored for a typed name, or null for "clear it".
 *
 * The empty string is not an error and not a name: it is how a person says
 * "take my label off, go back to the branch". A form's cleared field arrives as
 * `""`, and refusing it would leave the only way to undo a rename being to
 * delete a file by hand.
 *
 * Trimming first is what makes that work, and is also why the file can be
 * written with a trailing newline like every other one sandboxer writes.
 */
export function normaliseDisplayName(raw: string): string | null {
  const name = raw.trim();
  if (name === "") return null;
  if (FORBIDDEN.test(name)) {
    throw new DisplayNameError("a name is one line of text: it cannot contain control characters");
  }
  if ([...name].length > DISPLAY_NAME_MAX) {
    throw new DisplayNameError(`a name may be at most ${DISPLAY_NAME_MAX} characters`);
  }
  return name;
}

/**
 * How many bytes of the file are worth reading.
 *
 * A bound rather than a `readFile`, because this is a path in somebody's home
 * directory and nothing stops a file appearing there with a gigabyte in it. The
 * budget is the character limit at UTF-8's worst case, plus room for the
 * trailing newline and a couple of bytes of slack — so a file that fills the
 * buffer is *known* to be longer than a name may be, and is refused rather than
 * silently truncated into a different name than the file contains.
 */
const READ_LIMIT = DISPLAY_NAME_MAX * 4 + 8;

/**
 * The name somebody gave this worktree, or null when it has none.
 *
 * Never throws. A missing file, a missing directory and a file holding
 * something that is not a usable name all read the same way — as "no name" —
 * because all three mean the same thing to a reader: show the branch.
 */
export async function readDisplayName(
  project: string,
  slug: string,
  env?: NodeJS.ProcessEnv,
): Promise<string | null> {
  let handle;
  try {
    handle = await open(paths(env).nameFile(project, slug), "r");
  } catch {
    return null;
  }

  try {
    const buffer = Buffer.alloc(READ_LIMIT);
    const { bytesRead } = await handle.read(buffer, 0, READ_LIMIT, 0);
    // The buffer filled, so there is more file than a name can be. Decoding it
    // would also risk cutting a multi-byte character in half and inventing a
    // replacement character nobody typed.
    if (bytesRead === READ_LIMIT) return null;
    return normaliseDisplayName(buffer.toString("utf8", 0, bytesRead));
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => {});
  }
}

/**
 * Names one worktree, or takes its name off when the value is empty.
 *
 * One entry point for both, because they are one instruction from a person: a
 * rename field that has been cleared and submitted is a request to go back to
 * the branch name, and splitting it into two calls would let a browser send the
 * empty one to the wrong endpoint. Answers what is now stored, which is null
 * when the name was cleared.
 *
 * Throws `DisplayNameError` for a value that is not a name at all — see
 * `normaliseDisplayName`.
 */
export async function writeDisplayName(
  project: string,
  slug: string,
  raw: string,
  env?: NodeJS.ProcessEnv,
): Promise<string | null> {
  const name = normaliseDisplayName(raw);
  if (name === null) {
    await removeDisplayName(project, slug, env);
    return null;
  }

  const file = paths(env).nameFile(project, slug);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${name}\n`, "utf8");
  return name;
}

/**
 * Hands a worktree back to its branch name.
 *
 * Doing so to one that was never named is not an error, so removing a worktree
 * can call this unconditionally rather than looking first.
 */
export async function removeDisplayName(project: string, slug: string, env?: NodeJS.ProcessEnv): Promise<void> {
  await rm(paths(env).nameFile(project, slug), { force: true });
}
