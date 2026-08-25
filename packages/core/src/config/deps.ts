/**
 * Finding a project's Node dependency tree.
 *
 * The shared dependency volume is mounted at exactly one path, and that path is
 * the directory holding the lockfile — which is not always the directory holding
 * the packages. A project can say where it is; this works it out when the config
 * does not, because the alternative is a sandbox installing into the worktree.
 */

import { stat } from "node:fs/promises";
import { join } from "node:path";

import type { DepsConfig, ResolvedConfig } from "./types.js";

/** Lockfiles, in the order a project with more than one would want them tried. */
export const LOCKFILES = [
  { file: "package-lock.json", install: "npm ci --no-audit --no-fund" },
  { file: "pnpm-lock.yaml", install: "pnpm install --frozen-lockfile" },
  { file: "yarn.lock", install: "yarn install --immutable" },
  { file: "bun.lockb", install: "bun install --frozen-lockfile" },
] as const;

/**
 * The directories a lockfile might plausibly be in, nearest first.
 *
 * The repo root is the common case. A monorepo whose packages live under
 * `web/packages` usually keeps its lockfile at `web`, so the first segment of
 * the declared front-end root is tried before the root itself.
 */
export function candidateRoots(config: ResolvedConfig): string[] {
  const roots = ["."];
  const frontendRoot = config.frontendRoot;
  if (frontendRoot !== "") {
    const first = frontendRoot.split("/")[0];
    if (first && first !== ".") roots.push(first);
    if (frontendRoot !== first) roots.push(frontendRoot);
  }
  return roots;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolves the dependency tree for a project.
 *
 * An explicit `deps` block always wins — a project that has said where its
 * lockfile is has settled the question. Otherwise the candidates are searched,
 * and a project with no lockfile at all gets no dependency volume, which costs
 * an install rather than breaking.
 */
export async function resolveDeps(config: ResolvedConfig, worktree: string): Promise<DepsConfig | undefined> {
  if (config.deps) return config.deps;

  for (const root of candidateRoots(config)) {
    for (const { file, install } of LOCKFILES) {
      const path = root === "." ? join(worktree, file) : join(worktree, root, file);
      if (await exists(path)) return { root, lockfile: file, install };
    }
  }
  return undefined;
}
