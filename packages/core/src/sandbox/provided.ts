/**
 * A `/workspace` somebody else resolved.
 *
 * `up` ordinarily finds a git worktree on the host, reads the project out of it
 * and bind-mounts it. That is the engine's own story and it is not going
 * anywhere. But some embedders keep the code somewhere the host has no checkout
 * of — Jef puts a session's clones on a Docker volume (its §9.5), and on
 * macOS that volume is inside a VM and is not a host path at all.
 *
 * **The inversion is the point.** The engine used to take a `RuntimeRequest`, a
 * session id and a repo name, and stage the checkout itself — which meant it
 * knew what a session was, what a work volume was, and how to read one. It now
 * takes a *resolved workspace*: mounts, git facts, a slug and a directory of
 * manifests. Everything a session changes about starting a sandbox is one of
 * these fields, and the engine can no longer tell whose they are.
 *
 * Three things are worth saying about the shape.
 *
 * **`manifests` is never mounted anywhere.** It is a host directory holding a
 * copy of the project's `sandboxr.yaml`, its lockfiles and its `package.json`s,
 * for the host to read and for `ensureProjectImage` to build from. Whoever made
 * it disposes of it; a stale copy would be a second opinion about what the
 * project is.
 *
 * **`facts` is handed in rather than read**, because there is no checkout on
 * the host to run `git` against. They go on `sandboxr.branch`, `sandboxr.commit`
 * and `sandboxr.dirty` exactly as a worktree's do (§3.4), and they are the
 * caller's to get right.
 *
 * **`mounts` replaces the worktree bind and `gitMounts` outright.** `gitMounts`
 * exists because a linked worktree's `.git` is a one-line file naming an
 * absolute host path, so the repository has to be mounted at the identical path
 * inside and out. A workspace the caller resolved is its own business: if it is
 * a self-contained clone, git works inside it with no second mount, and the
 * engine must not add one on a guess about what is there.
 */

import type { GitFacts } from "../git.js";

export interface ProvidedWorkspace {
  /**
   * The slug this sandbox is addressed by. Replaces `slugFor`.
   *
   * The caller's, because the derivation `slugFor` does is about a worktree —
   * a directory name, a branch, and a collision token written down in
   * `state/slug/` when two worktrees derived the same name. None of that exists
   * for a workspace the host has no checkout of.
   *
   * It still has to fit the project's ceiling (§3.1): the slug shares one DNS
   * label with the longest hostname label and the project name, and `up` names
   * a container, four volumes, a host rule and a migration lock with it.
   */
  slug: string;
  /** A host directory holding the project's manifests. Never mounted anywhere. */
  manifests: string;
  /** What `/workspace` *is*, as a name. Goes on `sandboxr.worktree`. */
  workspace: string;
  /** Branch, commit and dirtiness, since the host has no checkout to read. */
  facts: GitFacts;
  /** `docker run` args that put something at `/workspace`. */
  mounts: readonly string[];
  /**
   * Extra container labels — a group id, say. Merged over the engine's.
   *
   * Over rather than under, deliberately: an embedder that wants to correct one
   * of the engine's own labels is doing something the engine cannot anticipate,
   * and refusing it here would only move the workaround somewhere less visible.
   */
  labels?: Record<string, string> | undefined;
  /**
   * What `Starting <slug> from …` says. Defaults to `<branch>@<commit>`.
   *
   * The default is true but unhelpful when the branch is one of several in a
   * group: "main@abc1234" says nothing about which of four checkouts this is.
   */
  from?: string | undefined;
}
