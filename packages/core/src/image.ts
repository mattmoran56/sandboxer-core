/**
 * The per-project image layer.
 *
 * `container/project/Dockerfile.template` is a generic Dockerfile with two kinds
 * of hole in it — blocks that are kept or deleted, and `{{VALUES}}` — and this is
 * the half that fills them in. The split is deliberate: installing a toolchain is
 * full of architecture switches and vendor-specific traps, so it lives next to
 * the other container concerns, and the decision about *which* toolchains a
 * project needs lives here, where there is a schema and a type checker.
 *
 * The build context holds only manifests, never source. A source change must
 * never re-run a dependency install, and the worktree is bind-mounted at run time
 * anyway.
 */

import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

import type { ResolvedConfig } from "./config/types.js";
import { archBuildArgs, docker as defaultDocker, type Docker } from "./docker.js";
import { containerDir } from "./install.js";
import { TOOL_VERSION } from "./tool-version.js";

export class ImageError extends Error {
  override readonly name = "ImageError";
}

/** Block names the template understands, in the order they appear in it. */
export const BLOCKS = ["go", "node", "mysql", "sqlite", "gomod", "deps"] as const;
export type Block = (typeof BLOCKS)[number];

/** The MySQL series the template has a pinned patch release for. */
const DEFAULT_MYSQL = "8.4";

/**
 * Keeps the enabled blocks and deletes the rest, guard lines included.
 *
 * Line-based rather than a regular expression over the whole file: a block's
 * body contains `#` comments and shell that a multi-line pattern would have to
 * be careful of, and the guards are the only thing this needs to recognise.
 */
export function applyBlocks(template: string, enabled: ReadonlySet<string>): string {
  const out: string[] = [];
  let skipping: string | null = null;

  for (const line of template.split("\n")) {
    const open = /^#\s*>>>\s*sandboxr:block\s+(\S+)\s*$/.exec(line);
    if (open) {
      const name = open[1] as string;
      if (!enabled.has(name)) skipping = name;
      continue;
    }
    const close = /^#\s*<<<\s*sandboxr:block\s+(\S+)\s*$/.exec(line);
    if (close) {
      if (skipping === close[1]) skipping = null;
      continue;
    }
    if (skipping === null) out.push(line);
  }

  if (skipping !== null) throw new ImageError(`the template's "${skipping}" block is never closed`);
  return out.join("\n");
}

/**
 * Fills in `{{NAME}}` holes.
 *
 * A missing value is an error rather than an empty string: a silently empty
 * version pin produces an image that builds and then cannot run, which is a much
 * worse failure than a template that refuses to render.
 */
export function applyValues(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_match, name: string) => {
    const value = values[name];
    if (value === undefined || value === "") {
      throw new ImageError(`the template needs a value for {{${name}}} and none was supplied`);
    }
    return value;
  });
}

export interface RenderInput {
  config: ResolvedConfig;
  /** Whether a Go module was found to stage. */
  gomod: boolean;
  /** Whether a dependency manifest set was found to stage. */
  deps: boolean;
}

/** Which template blocks this project's config turns on. */
export function blocksFor(input: RenderInput): Set<Block> {
  const { config } = input;
  const enabled = new Set<Block>();
  if (config.toolchain.go) enabled.add("go");
  if (config.toolchain.node) enabled.add("node");
  if (config.database.driver === "mysql") enabled.add("mysql");
  // A d1 database is SQLite underneath, and the CLI is what applies fixtures,
  // snapshots the schema and backs `db shell`.
  if (config.database.driver === "sqlite" || config.database.driver === "d1") enabled.add("sqlite");
  if (enabled.has("go") && input.gomod) enabled.add("gomod");
  if (enabled.has("node") && input.deps) enabled.add("deps");
  return enabled;
}

/** The `{{VALUES}}` this project's config supplies. Only the enabled blocks' ones are needed. */
export function valuesFor(input: RenderInput): Record<string, string> {
  const { config } = input;
  const values: Record<string, string> = {};
  if (config.toolchain.go) values.GO_VERSION = config.toolchain.go;
  if (config.toolchain.node) values.NODE_VERSION = config.toolchain.node;
  if (config.database.driver === "mysql") values.MYSQL_VERSION = config.database.version ?? DEFAULT_MYSQL;
  if (config.deps) {
    values.DEPS_INSTALL = config.deps.install;
    values.DEPS_LOCKFILE = config.deps.lockfile;
  }
  return values;
}

export function renderDockerfile(template: string, input: RenderInput): string {
  return applyValues(applyBlocks(template, blocksFor(input)), valuesFor(input));
}

/** One staged file: where it came from and where it lands in the context. */
export interface StagedFile {
  source: string;
  /** Path inside the build context. */
  target: string;
}

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "out", ".next", ".wrangler"]);

/**
 * Finds the manifests that describe a dependency tree.
 *
 * Every `package.json` under the dependency root, plus the lockfile. The
 * workspace layout is preserved because npm resolves a workspace by the path in
 * its `workspaces` globs, and a flattened context installs the root package
 * alone.
 */
export async function findManifests(root: string, lockfile: string, depth = 5): Promise<StagedFile[]> {
  const staged: StagedFile[] = [];
  const lock = join(root, lockfile);
  if (existsSync(lock)) staged.push({ source: lock, target: lockfile });

  const walk = async (dir: string, level: number): Promise<void> => {
    let entries: Array<{ name: string; isFile(): boolean; isDirectory(): boolean }>;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isFile() && entry.name === "package.json") {
        staged.push({ source: path, target: relative(root, path) });
      } else if (entry.isDirectory() && level < depth && !SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")) {
        await walk(path, level + 1);
      }
    }
  };
  await walk(root, 0);
  return staged.sort((a, b) => a.target.localeCompare(b.target));
}

/** The Go module manifests, when the project has one. */
export async function findGoModule(worktree: string, workdir?: string): Promise<StagedFile[]> {
  const root = workdir ? join(worktree, workdir) : worktree;
  const staged: StagedFile[] = [];
  for (const name of ["go.mod", "go.sum"]) {
    const path = join(root, name);
    if (existsSync(path)) staged.push({ source: path, target: name });
  }
  // go.sum alone is not a module, and `go mod download` on a context without a
  // go.mod fails in a way that reads as a broken image rather than a missing file.
  return staged.some((file) => file.target === "go.mod") ? staged : [];
}

/**
 * The image tag for a project.
 *
 * Content-addressed on everything the build reads — the rendered Dockerfile, the
 * staged manifests, and this tool's version — so an image is rebuilt exactly when
 * one of those changes and reused otherwise.
 */
export async function imageTag(project: string, dockerfile: string, staged: StagedFile[]): Promise<string> {
  const hash = createHash("sha256").update(TOOL_VERSION).update("\0").update(dockerfile);
  for (const file of staged) {
    hash.update("\0").update(file.target).update("\0");
    hash.update(await readFile(file.source));
  }
  return `sandboxr/${project}:${hash.digest("hex").slice(0, 12)}`;
}

export interface BuildImageOptions {
  config: ResolvedConfig;
  /** The project root, which is what `/workspace` will be. */
  worktree: string;
  docker?: Docker | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  log?: ((line: string) => void) | undefined;
  /** The base image this layer sits on. */
  baseImage?: string | undefined;
  rebuild?: boolean | undefined;
}

export interface BuiltImage {
  tag: string;
  /** False when the tag was already present and nothing was built. */
  built: boolean;
  dockerfile: string;
}

/**
 * Builds (or reuses) the project's image layer.
 *
 * Reuse is the common case and the reason the tag is content-addressed: a
 * sandbox for a second branch of the same project starts against an image that
 * already exists, which is the difference between seconds and minutes.
 */
export async function ensureProjectImage(options: BuildImageOptions): Promise<BuiltImage> {
  const { config } = options;
  const docker = options.docker ?? defaultDocker;
  const env = options.env ?? process.env;
  const log = options.log ?? (() => undefined);

  const templatePath = join(containerDir(env), "project", "Dockerfile.template");
  const template = await readFile(templatePath, "utf8");

  const deps = config.deps;
  const manifests = deps
    ? await findManifests(deps.root === "." ? options.worktree : join(options.worktree, deps.root), deps.lockfile)
    : [];
  const gomod = config.toolchain.go
    ? await findGoModule(options.worktree, config.database.migrate?.workdir ?? config.backends[0]?.workdir)
    : [];

  const dockerfile = renderDockerfile(template, {
    config,
    gomod: gomod.length > 0,
    deps: manifests.length > 0,
  });

  const staged: StagedFile[] = [
    ...manifests.map((file) => ({ source: file.source, target: join("manifests", file.target) })),
    ...gomod.map((file) => ({ source: file.source, target: join("gomod", file.target) })),
  ];

  const tag = await imageTag(config.project, dockerfile, staged);
  if (!options.rebuild && (await docker.imageExists(tag))) {
    log(`Image ${tag} is current`);
    return { tag, built: false, dockerfile };
  }

  const context = await mkdtemp(join(tmpdir(), "sandboxr-build-"));
  try {
    await writeFile(join(context, "Dockerfile"), dockerfile);
    for (const file of staged) {
      const target = join(context, file.target);
      await mkdir(dirname(target), { recursive: true });
      await cp(file.source, target);
    }

    log(`Building ${tag}`);
    const args = ["build", "-f", join(context, "Dockerfile"), "-t", tag];
    if (options.baseImage) args.push("--build-arg", `BASE_IMAGE=${options.baseImage}`);
    // The architecture is passed rather than left to the builder: the dashboard
    // builds without buildx, and BuildKit is the only thing that sets
    // TARGETARCH. The rendered Dockerfile falls back to `uname -m` on its own —
    // it has to, so a hand-run `docker build` still works — and this is the
    // second belt.
    args.push(...archBuildArgs());
    args.push(context);
    await docker.ok(args, { timeoutMs: 45 * 60_000 });
    log(`Built ${tag}`);
    return { tag, built: true, dockerfile };
  } finally {
    await rm(context, { recursive: true, force: true });
  }
}
