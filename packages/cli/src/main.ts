/**
 * `sandboxr` — dispatch and argument handling only; the work lives in
 * @sandboxr/core.
 *
 * Every command returns an exit code rather than calling `process.exit`, so the
 * whole surface can be driven from a test without ending the test run.
 */

import { spawn } from "node:child_process";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import { Writable } from "node:stream";

import {
  CONFIG_FILENAME,
  ConfigError,
  TOOL_VERSION,
  accessStatus,
  addWorktree,
  allowsRealCredentials,
  checkSecrets,
  cloneProject,
  containerName,
  declaredNames,
  describeProjectSecrets,
  deriveSlug,
  docker,
  down,
  driverContext,
  editProjectSecrets,
  envNameRefusal,
  expire,
  fetchProject,
  findProject,
  formatBytes,
  formatTtl,
  gc,
  getDriver,
  ghAvailable,
  gitFacts,
  importSecrets,
  initAccess,
  isKeptAlive,
  list,
  listProjects,
  listPullRequests,
  listRemoteRepos,
  listWorktrees,
  loadConfig,
  locateConfig,
  matchesOrigin,
  parseEnvFile,
  parseTtl,
  paths,
  persistenceAdvice,
  prune,
  readProjectSecrets,
  reload,
  removeKeep,
  removeWorktree,
  repoSlugFromUrl,
  sanitizeSlug,
  startSandbox,
  status,
  stopSandbox,
  teardownAccess,
  up,
  writeKeep,
  type Project,
  type ResolvedConfig,
  type Sandbox,
} from "@sandboxr/core";

import { flagBoolean, flagList, flagNumber, flagString, parseArgs, type ParsedArgs } from "./args.js";
import { Output, processWriter, type Writer } from "./output.js";

export const USAGE = `sandboxr — one container per git worktree, on its own hostname

SETUP
  init                         Set this machine up: router, certificate, dashboard
     --no-tls                  Serve plain http even if a trusted CA is present
     --tls                     Insist on https even if the CA is not trusted yet
     --rebuild                 Rebuild the base image
     --bind ADDR               Publish the router here instead of 127.0.0.1
     --http-port N             Publish http here instead of 80
     --https-port N            ...and https here instead of 443
  teardown [--network]         Stop the router and the dashboard

SANDBOX
  up [slug]                    Start a sandbox from this worktree
     --worktree PATH           ...or from another one
     --project NAME            ...or from a project in the workspace
     --branch NAME             Which branch of it to run
     --base REF                Create that branch off this ref first
     --ttl 12h|never           Stop it again once it has sat unused this long
     --with a,b                Also start these optional runtimes
     --seed local|file|fixtures  Force a seed source
     --detach                  Do not wait for it to come up
  down [slug] [--keep]         Remove it, and its database and uploads
  stop <slug> [--project N]    Stop the container, keep everything else
  start <slug> [--project N]   Start a stopped one again
  keep <slug> [--project N]    Exempt it from the idle clock
  unkeep <slug> [--project N]  Hand it back to the clock
  ls [--project NAME]          Every sandbox: state, ttl, branch, worktree
  status [slug]                One sandbox in detail
  logs [slug] [--tail N] [-f]  The container's own log stream
  shell [slug]                 A shell inside the sandbox
  reload [slug] --go [name]    Rebuild a backend and restart it
                --web <label|all|built>   Rebuild a front-end
                --migrate      Re-run this sandbox's migrations
  expire [--dry-run]           Stop every sandbox past its idle limit
     --project NAME            ...of one project only
  gc [--dry-run]               Reap sandboxes whose worktree is gone
  prune [--yes]                Reclaim disk: orphaned volumes, replaced images
     --build-cache             ...and Docker's build cache, which is not only ours

PROJECTS
  project ls                   Every project in the workspace
  project available            Repositories you could add, as gh can see them
  project clone <url>          Put one there, as a bare mirror
     --name NAME               ...under this name, not the url's
  project fetch <name>         Bring its remote-tracking branches up to date
  project prs <name>           Open pull requests, as gh reports them

WORKTREES
  worktree ls <project>        Every worktree cut from a project
  worktree add <project> <branch>   Cut one for a branch
     --base REF                ...creating the branch off this ref
  worktree rm <project> <branch>    Remove one
     --force                   ...even with uncommitted work in it

DATABASE
  db seed [--seed SOURCE]      Produce or refresh the seed artifact
  db migrate [slug]            Run the project's migrations against the copy
  db snapshot [slug]           Print the schema
  db shell [slug]              An interactive database shell

SECRETS
  secrets list                 Every credential the project carries, by name
  secrets set NAME             Set one; the value is read from a prompt or stdin
  secrets unset NAME           Remove one
  secrets edit                 Open the whole file in $EDITOR, checked on save
  secrets import               Merge the project's .env files into the file
     --replace                 Build the file from them instead, discarding
                               anything set by hand or by an earlier import
  secrets check                Say which credentials are missing, by name

No secrets command prints a value. list gives a name, the last four characters
and the length; edit is the exception, and opens the file in your own editor.

OTHER
  config                       Where the config is, and what it resolved to
  doctor                       Check the local setup
  version                      Print the version
  help                         This message

Human-readable output goes to stderr; --json puts the result on stdout.
`;

/** The seed sources `--seed` accepts, in the order the usage lists them. */
const SEED_SOURCES = ["local", "file", "fixtures"] as const;
type SeedSource = (typeof SEED_SOURCES)[number];

export interface RunContext {
  writer?: Writer | undefined;
  /** The directory commands resolve a config from. */
  cwd?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  /**
   * Where `secrets set` reads a value from, defaulting to the process's stdin.
   *
   * Injected for the same reason `writer` is: the one command that reads a
   * credential has to be drivable from a test, and the real stream cannot be
   * reattached once a test run has taken it.
   */
  stdin?: Stdin | undefined;
}

/**
 * Just enough of `process.stdin` for `secrets set`.
 *
 * `isTTY` decides which of the two ways in is being used — a person typing, or
 * a script piping — and it is optional because a plain `Readable` (a test, a
 * closed stdin) has neither the property nor a terminal behind it.
 */
export type Stdin = Readable & { isTTY?: boolean | undefined };

export async function main(argv: string[], context: RunContext = {}): Promise<number> {
  const args = parseArgs(argv);
  const out = new Output(context.writer ?? processWriter, flagBoolean(args, "json"));
  const cwd = context.cwd ?? process.cwd();
  const env = context.env ?? process.env;

  // Asking for help is a request that succeeded, whether or not a command came
  // with it. Only being given nothing at all is a failure, because then usage is
  // a complaint rather than an answer.
  const askedForHelp = flagBoolean(args, "help") || flagBoolean(args, "h");
  if (args.command === "" || askedForHelp) {
    out.line(USAGE);
    return askedForHelp ? 0 : 1;
  }

  try {
    switch (args.command) {
      case "help":
        out.line(USAGE);
        return 0;
      case "version":
        out.data({ version: TOOL_VERSION });
        return 0;
      case "up":
        return await cmdUp(args, out, cwd, env);
      case "down":
        return await cmdDown(args, out, cwd, env);
      case "ls":
      case "list":
        return await cmdList(args, out, env);
      case "stop":
        return await cmdPower(args, out, cwd, env, "stop");
      case "start":
        return await cmdPower(args, out, cwd, env, "start");
      // `pin` and `unpin` are the names these had before the concept was called
      // keep-alive. Kept as undocumented aliases rather than removed: they are
      // in people's shell history and in scripts, and the cost of honouring
      // them is two lines.
      case "keep":
      case "pin":
        return await cmdKeep(args, out, cwd, env, true);
      case "unkeep":
      case "unpin":
        return await cmdKeep(args, out, cwd, env, false);
      case "expire":
        return await cmdExpire(args, out, env);
      case "project":
        return await cmdProject(args, out, env);
      case "worktree":
        return await cmdWorktree(args, out, env);
      case "status":
        return await cmdStatus(args, out, cwd, env);
      case "logs":
        return await cmdLogs(args, out, cwd, env);
      case "shell":
        return await cmdShell(args, out, cwd, env);
      case "reload":
        return await cmdReload(args, out, cwd, env);
      case "gc":
        return await cmdGc(args, out, env);
      case "prune":
        return await cmdPrune(args, out, env);
      case "db":
        return await cmdDb(args, out, cwd, env);
      case "secrets":
        return await cmdSecrets(args, out, cwd, env, context.stdin ?? process.stdin);
      case "init":
        return await cmdInit(args, out, env);
      case "teardown":
        return await cmdTeardown(args, out, env);
      case "config":
        return await cmdConfig(args, out, cwd, env);
      case "doctor":
        return await cmdDoctor(args, out, cwd, env);
      default:
        out.error(`unknown command: ${args.command}`);
        out.line(USAGE);
        return 1;
    }
  } catch (error) {
    // A config error already names the file and the field, so it is printed as
    // written rather than wrapped in something less specific.
    if (error instanceof ConfigError) {
      out.error(error.message);
      return 2;
    }
    out.error((error as Error).message);
    return 1;
  }
}

/** Resolves the project's config, and the slug a command applies to. */
/**
 * The worktree a named sandbox was started from, if exactly one answers to it.
 *
 * Undefined for no match, for an ambiguous one, and for a docker that will not
 * answer — every one of which means "I cannot improve on the current directory",
 * which is the caller's fallback. It never throws for the same reason: this is
 * a convenience on the way to a command that has its own error to report.
 */
async function sandboxWorktree(
  slug: string,
  project: string | undefined,
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  try {
    const matches = (await list({ project, env })).filter((sandbox) => sandbox.slug === slug);
    const [only] = matches;
    return matches.length === 1 && only && only.worktree !== "" ? only.worktree : undefined;
  } catch {
    return undefined;
  }
}

async function target(
  args: ParsedArgs,
  cwd: string,
  env: NodeJS.ProcessEnv,
  positionalIndex = 0,
): Promise<{ config: ResolvedConfig; slug: string; worktree: string }> {
  const named = args.positional[positionalIndex] ?? flagString(args, "slug");
  const declared = flagString(args, "worktree");

  // A named sandbox knows where it came from, so ask it rather than the current
  // directory. Without this, `sandboxr status <slug>` only worked from inside a
  // configured directory — which for a project sandboxr checked out itself is
  // backwards: the slug identifies it, and the worktree is on its label.
  //
  // Only when a slug was actually named and no `--worktree` overrides it, so the
  // explicit forms keep meaning exactly what they meant.
  if (named !== undefined && named !== "" && declared === undefined) {
    const found = await sandboxWorktree(named, flagString(args, "project"), env);
    if (found) {
      try {
        return {
          config: await loadConfig(found, { enforceAccess: false, env }),
          slug: named,
          worktree: found,
        };
      } catch {
        // A worktree that has moved on, or lost its config, is a fine reason to
        // fall back to the current directory — and a poor reason to refuse.
      }
    }
  }

  const worktree = declared ?? cwd;
  // `env` is what names the workspace, so it is what decides whether this
  // worktree may fall back to its project's config. Passing process.env by
  // accident would make the CLI and the dashboard disagree about one worktree.
  const config = await loadConfig(worktree, { enforceAccess: false, env });
  const facts = await gitFacts(worktree);
  const slug = deriveSlug({
    explicit: args.positional[positionalIndex] ?? flagString(args, "slug"),
    worktreeDir: facts.directory,
    branch: facts.branch === "?" ? undefined : facts.branch,
  });
  return { config, slug, worktree: facts.worktree };
}

async function cmdUp(args: ParsedArgs, out: Output, cwd: string, env: NodeJS.ProcessEnv): Promise<number> {
  const project = flagString(args, "project");
  // With `--project` there is no worktree yet — core finds one for the branch,
  // or cuts it — so there is nothing here to load a config from, and the cwd is
  // whatever directory the person happened to be standing in. Without it the
  // behaviour is exactly as it was: this worktree, or the one `--worktree` names.
  const worktree = flagString(args, "worktree") ?? (project === undefined ? cwd : undefined);
  // Enforced here rather than in `target`: this is the one command that decides
  // to *start* something, so it is where a §5.3 refusal belongs. When core
  // resolves the worktree it loads the config the same way, so the refusal still
  // happens — one step later, on the worktree that actually got picked.
  const config = worktree === undefined ? undefined : await loadConfig(worktree, { env });

  const seed = flagString(args, "seed");
  // Checked rather than cast: an unrecognised source would otherwise be handed
  // to the driver, match no branch, and look like the config was at fault.
  if (seed !== undefined && !SEED_SOURCES.includes(seed as SeedSource)) {
    out.error(`--seed ${seed} is not a source — one of ${SEED_SOURCES.join(", ")}`);
    return 1;
  }

  // Refused here as well as in core, and before anything is seeded or built:
  // core throws on a lifetime it cannot read, but by then the worktree is cut
  // and the seed is taken, so the person gets a stack of work undone over a
  // typo they could have been told about immediately. See parseTtl on why it
  // will not guess.
  const ttl = flagString(args, "ttl");
  if (ttl !== undefined && parseTtl(ttl) === undefined) {
    out.error(`--ttl ${ttl} is not a duration — a span like 30m, 12h or 7d, or never`);
    return 1;
  }

  const result = await up({
    config,
    worktree,
    project,
    branch: flagString(args, "branch"),
    base: flagString(args, "base"),
    ttl,
    slug: args.positional[0] ?? flagString(args, "slug"),
    with: flagList(args, "with"),
    seed: seed as SeedSource | undefined,
    detach: flagBoolean(args, "detach"),
    timeoutSeconds: flagNumber(args, "timeout"),
    env,
    log: (line) => out.step(line),
  });

  if (result.migrationFailure) {
    out.warn(result.migrationFailure);
    out.dim(`      sandboxr logs ${result.sandbox.slug}`);
    out.dim(`      sandboxr db shell ${result.sandbox.slug}`);
  } else {
    out.ok(`Sandbox ${result.sandbox.slug} is ${result.sandbox.state}`);
  }
  out.line();
  for (const [label, url] of Object.entries(result.urls)) out.line(`  ${label.padEnd(12)} ${url}`);
  out.line();

  if (out.json) out.data(result);
  return result.sandbox.state === "degraded" ? 3 : 0;
}

async function cmdDown(args: ParsedArgs, out: Output, cwd: string, env: NodeJS.ProcessEnv): Promise<number> {
  const { config, slug } = await target(args, cwd, env);
  await down(config.project, slug, { keep: flagBoolean(args, "keep"), env, log: (line) => out.ok(line) });
  if (out.json) out.data({ project: config.project, slug, removed: true });
  return 0;
}

async function cmdList(args: ParsedArgs, out: Output, env: NodeJS.ProcessEnv): Promise<number> {
  const sandboxes = await list({ project: flagString(args, "project"), env });
  if (out.json) {
    out.data(sandboxes);
    return 0;
  }
  if (sandboxes.length === 0) {
    out.line("No sandboxes. Create one with: sandboxr up");
    return 0;
  }
  // One column for two facts, because they answer the same question — when does
  // this go away? `kept` is shown instead of the ttl rather than beside it: it
  // is what the clock will actually do to this sandbox, and a row reading `12h`
  // next to a keep-alive invites exactly the wrong conclusion.
  const lifetimes = await Promise.all(
    sandboxes.map(async (sandbox) => {
      if (await isKeptAlive(sandbox, env)) return "kept";
      const ttl = parseTtl(sandbox.ttl);
      return ttl === undefined ? "-" : formatTtl(ttl);
    }),
  );

  out.table(
    ["PROJECT", "SLUG", "STATE", "TTL", "BRANCH", "WORKTREE"],
    sandboxes.map((sandbox, index) => [
      sandbox.project,
      sandbox.slug,
      sandbox.state,
      lifetimes[index] ?? "-",
      // The star is the only place `dirty` shows, and it is worth the character:
      // a sandbox built from uncommitted work is not reproducible from its
      // commit alone.
      sandbox.dirty ? `${sandbox.branch}*` : sandbox.branch,
      sandbox.worktree,
    ]),
  );
  // Only when something is actually starred: a legend for a mark that is not in
  // the table reads as though it were, and sends you looking for it.
  if (sandboxes.some((sandbox) => sandbox.dirty)) {
    out.line();
    out.dim("* uncommitted changes when the sandbox started");
  }
  return 0;
}

async function cmdStatus(args: ParsedArgs, out: Output, cwd: string, env: NodeJS.ProcessEnv): Promise<number> {
  const { config, slug } = await target(args, cwd, env);
  const result = await status(config.project, slug, { config, env });
  if (out.json) {
    out.data(result);
    return 0;
  }
  out.bold(`${result.project}/${result.slug}`);
  out.line(`  state       ${result.state}`);
  out.line(`  branch      ${result.branch}@${result.commit}${result.dirty ? " (dirty)" : ""}`);
  out.line(`  driver      ${result.driver}`);
  out.line(`  migrations  ${result.migrations}`);
  out.line(`  access      ${result.access}`);
  out.line(`  worktree    ${result.worktree}${result.worktreeMissing ? " (GONE)" : ""}`);
  if (result.built.length > 0) out.line(`  built       ${result.built.join(", ")}`);
  out.line();
  for (const service of result.services) {
    out.line(`  ${service.up ? "up  " : "down"}  ${service.name.padEnd(16)} ${service.url}`);
  }
  return result.state === "degraded" ? 3 : 0;
}

async function cmdLogs(args: ParsedArgs, out: Output, cwd: string, env: NodeJS.ProcessEnv): Promise<number> {
  const { config, slug } = await target(args, cwd, env);
  const container = containerName(config.project, slug);
  const tail = flagNumber(args, "tail") ?? 200;

  // A followed log has no end, so it is streamed rather than collected: buffering
  // it would hold every line and print none until the container died.
  if (flagBoolean(args, "f") || flagBoolean(args, "follow")) {
    return docker.logsFollow(container, { tail });
  }

  const result = await docker.logs(container, { tail });
  const text = result.stdout + result.stderr;
  if (out.json) {
    out.data({ container, lines: text === "" ? [] : text.replace(/\n$/, "").split("\n") });
    return result.code;
  }
  // The log is the result here, not decoration, so it goes to stdout whether or
  // not --json was asked for: `sandboxr logs > today.txt` is the whole point.
  out.raw(text);
  return result.code;
}

async function cmdShell(args: ParsedArgs, out: Output, cwd: string, env: NodeJS.ProcessEnv): Promise<number> {
  const { config, slug } = await target(args, cwd, env);
  void out;
  // Anything after a bare `--` is the command to run instead of a login shell,
  // which is what makes `sandboxr shell -- go test ./...` work from a script.
  const command = args.rest.length > 0 ? args.rest : ["bash"];
  return docker.execInteractive(containerName(config.project, slug), command, { workdir: "/workspace" });
}

async function cmdReload(args: ParsedArgs, out: Output, cwd: string, env: NodeJS.ProcessEnv): Promise<number> {
  const { config, slug } = await target(args, cwd, env);

  const kind = flagBoolean(args, "migrate")
    ? "migrate"
    : args.flags.web !== undefined
      ? "frontend"
      : args.flags.go !== undefined || args.flags.backend !== undefined
        ? "backend"
        : undefined;
  if (!kind) {
    out.error("what should be reloaded? --go [name] | --web <label|all|built> | --migrate");
    return 1;
  }

  const flagTarget =
    kind === "frontend"
      ? typeof args.flags.web === "string"
        ? args.flags.web
        : "all"
      : typeof args.flags.go === "string"
        ? args.flags.go
        : typeof args.flags.backend === "string"
          ? args.flags.backend
          : "all";

  const result = await reload(config.project, slug, {
    kind,
    target: flagTarget,
    config,
    env,
    log: (line) => out.step(line),
  });

  if (out.json) out.data(result);
  for (const name of result.built) out.ok(`${name} rebuilt`);
  for (const name of result.failed) out.error(`${name} failed`);
  if (result.failed.length > 0) {
    out.dim(result.output.split("\n").slice(-20).join("\n"));
    return 1;
  }
  return 0;
}

async function cmdGc(args: ParsedArgs, out: Output, env: NodeJS.ProcessEnv): Promise<number> {
  const plan = await gc({
    dryRun: flagBoolean(args, "dry-run"),
    env,
    log: (line) => out.ok(line),
  });
  if (out.json) out.data(plan);
  else if (flagBoolean(args, "dry-run")) {
    for (const { sandbox, reason } of plan.reap) out.line(`  would reap ${sandbox.slug} — ${reason}`);
    for (const volume of plan.volumes) out.line(`  would remove volume ${volume}`);
  }
  return 0;
}

/**
 * `prune` reports by default and removes with `--yes`, which is the other way
 * round from `gc --dry-run`.
 *
 * The asymmetry is the point rather than an inconsistency: `gc` removes things
 * whose loss costs a restart, and this removes images, where the cost of taking
 * one that was still wanted is a toolchain rebuild on somebody's next `up`.
 */
async function cmdPrune(args: ParsedArgs, out: Output, env: NodeJS.ProcessEnv): Promise<number> {
  const apply = flagBoolean(args, "yes") || flagBoolean(args, "y");
  const buildCache = flagBoolean(args, "build-cache");
  const result = await prune({ apply, buildCache, env, log: (line) => out.ok(line) });

  if (out.json) {
    out.data(result);
    return 0;
  }

  const removed = new Set([...result.removed.volumes, ...result.removed.images]);
  const rows = [
    ...result.volumes.map((volume) => ["volume", volume.name, formatBytes(volume.size), "nothing owns it"]),
    ...result.images.map((image) => ["image", image.reference, formatBytes(image.size), image.reason]),
  ];

  if (rows.length > 0) {
    out.table([apply ? "REMOVED" : "WOULD REMOVE", "NAME", "SIZE", "WHY"], rows);
    out.line();
  }

  if (apply) {
    // Named one by one rather than counted: a refusal is nearly always a
    // container started against the image since the plan was made, and the
    // reader needs to know *which* thing did not go before re-running.
    const refused = [...result.volumes.map((volume) => volume.name), ...result.images.map((image) => image.reference)]
      .filter((name) => !removed.has(name));
    for (const name of refused) out.warn(`${name} is still in use — left alone`);
    // Summed over what actually went, not over the plan. Quoting the plan's
    // total after a refusal would report disk that is still occupied.
    const reclaimed = [
      ...result.volumes.filter((volume) => removed.has(volume.name)),
      ...result.images.filter((image) => removed.has(image.reference)),
    ].reduce((total, entry) => total + entry.size, 0);
    if (reclaimed > 0) out.ok(`Reclaimed about ${formatBytes(reclaimed)}`);
    if (result.buildCache.inScope) {
      out.ok(`Reclaimed ${formatBytes(result.removed.buildCacheBytes)} of build cache`);
    }
  } else if (rows.length === 0) {
    out.line("Nothing to reclaim.");
  } else {
    out.line(`About ${formatBytes(result.freed)} in total. Add --yes to remove it.`);
  }

  // Always said, whether or not it is in scope. On a machine that has run out of
  // room the cache is usually the largest number on the page, and a report that
  // left it out would read as the whole answer.
  if (!result.buildCache.inScope && result.buildCache.size > 0) {
    out.line();
    out.dim(
      `Docker's build cache holds ${result.buildCache.records} unused records, ` +
        `${formatBytes(result.buildCache.size)} of which no image is also holding.`,
    );
    out.dim("Every project on this daemon built into it, and the next build of each is a cold one.");
    out.dim("  sandboxr prune --build-cache --yes");
  }
  return 0;
}

/**
 * Resolves the project a slug belongs to, for the commands that name a sandbox
 * rather than stand in one.
 *
 * `list` is asked first because it is the same ground truth `sandboxr ls`
 * prints, so a slug copied out of that table resolves from anywhere — which is
 * the whole point of `stop`, `start` and `keep`: they are things you do to
 * somebody else's sandbox from wherever you happen to be. The config in the
 * current worktree is the fallback rather than the first answer, because it
 * names the project you are *standing in*, not the sandbox you asked for.
 *
 * `--project` beats both, and is the way out of an ambiguous slug: slugs come
 * from ticket ids, so two projects sharing a `tkt-4821` is ordinary rather than
 * exotic, and picking one of them would be a coin toss with a container at stake.
 */
async function sandboxTarget(
  args: ParsedArgs,
  out: Output,
  cwd: string,
  env: NodeJS.ProcessEnv,
  usage: string,
): Promise<{ project: string; slug: string; sandbox: Sandbox | undefined } | undefined> {
  const slug = args.positional[0] ?? flagString(args, "slug");
  if (slug === undefined || slug === "") {
    out.error(usage);
    return undefined;
  }

  const wanted = flagString(args, "project");
  const matches = (await list({ project: wanted, env })).filter((sandbox) => sandbox.slug === slug);

  const [first] = matches;
  if (first && matches.length === 1) return { project: first.project, slug, sandbox: first };
  if (matches.length > 1) {
    const projects = [...new Set(matches.map((sandbox) => sandbox.project))].join(", ");
    out.error(`${slug} is a sandbox of ${projects} — say which with --project`);
    return undefined;
  }
  if (wanted !== undefined) return { project: wanted, slug, sandbox: undefined };

  try {
    const config = await loadConfig(flagString(args, "worktree") ?? cwd, { enforceAccess: false, env });
    return { project: config.project, slug, sandbox: undefined };
  } catch {
    // Deliberately swallowed: a config that will not load is a fine reason to be
    // unable to *guess* the project, but a poor reason to refuse a command that
    // only needed a name — which `--project` supplies.
    out.error(`no sandbox called ${slug} on this machine — name its project with --project`);
    return undefined;
  }
}

/** Stops or starts one container. Everything else about the sandbox survives. */
async function cmdPower(
  args: ParsedArgs,
  out: Output,
  cwd: string,
  env: NodeJS.ProcessEnv,
  action: "stop" | "start",
): Promise<number> {
  const found = await sandboxTarget(args, out, cwd, env, `usage: sandboxr ${action} <slug> [--project NAME]`);
  if (!found) return 1;

  // core says one line about what it did, and it is held rather than printed as
  // it arrives: "No sandbox called x" comes back through the same log as
  // "Stopped x", and only the return value says which of them this was. Printed
  // straight through, a failure would appear under the green ok marker.
  let said = "";
  const log = (line: string): void => {
    said = line;
  };
  const changed =
    action === "stop"
      ? await stopSandbox(found.project, found.slug, { env, log })
      : await startSandbox(found.project, found.slug, { env, log });

  // The two false answers do not mean the same thing. Stopping something that
  // was already stopped is the state being asked for, so it succeeds; starting
  // something that does not exist cannot be, so it fails.
  const worked = action === "stop" || changed;
  const key = action === "stop" ? "stopped" : "started";
  if (out.json) out.data({ project: found.project, slug: found.slug, [key]: changed });
  if (said !== "") {
    if (worked) out.ok(said);
    else out.error(said);
  }
  return worked ? 0 : 1;
}

/** Exempts one sandbox from the idle clock, or hands it back. */
async function cmdKeep(
  args: ParsedArgs,
  out: Output,
  cwd: string,
  env: NodeJS.ProcessEnv,
  keepAlive: boolean,
): Promise<number> {
  const verb = keepAlive ? "keep" : "unkeep";
  const found = await sandboxTarget(args, out, cwd, env, `usage: sandboxr ${verb} <slug> [--project NAME]`);
  if (!found) return 1;

  if (!keepAlive) {
    await removeKeep(found.project, found.slug, env);
    if (out.json) out.data({ project: found.project, slug: found.slug, keepAlive: false });
    out.ok(`${found.slug} is back on the clock`);
    return 0;
  }

  // The marker holds the `sandboxr.created` of the container it was written
  // for, so there has to be a container to read it from. Writing one anyway
  // would leave a file that keeps nothing alive now and silently keeps whatever
  // next takes the name.
  if (!found.sandbox) {
    out.error(`no sandbox called ${found.slug} in ${found.project} — keep one that exists`);
    out.dim("      sandboxr ls");
    return 1;
  }
  if (found.sandbox.created === "") {
    out.error(`${found.slug} carries no created label, so a keep-alive could not tell it from its successor`);
    out.dim("      sandboxr down and up again to relabel it");
    return 1;
  }

  await writeKeep(found.sandbox.project, found.sandbox.slug, found.sandbox.created, env);
  if (out.json) out.data({ project: found.sandbox.project, slug: found.sandbox.slug, keepAlive: true });
  out.ok(`${found.sandbox.slug} will not expire until it is unkept`);
  return 0;
}

/** Stops every sandbox that has sat unused past its limit. */
async function cmdExpire(args: ParsedArgs, out: Output, env: NodeJS.ProcessEnv): Promise<number> {
  const dryRun = flagBoolean(args, "dry-run");
  const plan = await expire({
    dryRun,
    project: flagString(args, "project"),
    env,
    log: (line) => out.ok(line),
  });

  if (out.json) out.data(plan);
  else if (dryRun) {
    // The reason, not just the name: "ran for 9h, past its 8h ttl" is what makes
    // the plan checkable before anything is stopped for real.
    for (const { sandbox, reason } of plan.stop) out.line(`  would stop ${sandbox.slug} — ${reason}`);
    if (plan.stop.length === 0) out.line("Nothing to expire.");
  }
  return 0;
}

async function cmdProject(args: ParsedArgs, out: Output, env: NodeJS.ProcessEnv): Promise<number> {
  const sub = args.positional[0] ?? "";
  const name = args.positional[1];

  if (sub === "ls" || sub === "list") {
    const projects = await listProjects({ env });
    if (out.json) {
      out.data(projects);
      return 0;
    }
    if (projects.length === 0) {
      out.line("No projects yet. Clone one with: sandboxr project clone <url>");
      return 0;
    }
    out.table(
      ["PROJECT", "BASE", "ORIGIN"],
      projects.map((project) => [project.name, project.base, project.origin === "" ? "-" : project.origin]),
    );
    return 0;
  }

  if (sub === "available") {
    return await projectAvailable(out, env);
  }

  if (sub === "clone") {
    const url = name;
    if (url === undefined) {
      out.error("usage: sandboxr project clone <url> [--name NAME]");
      return 1;
    }
    const project = await cloneProject(url, {
      env,
      name: flagString(args, "name"),
      log: (line) => out.step(line),
    });
    if (out.json) out.data(project);
    out.ok(`${project.name} is in the workspace, on ${project.base}`);
    out.dim(`      sandboxr worktree add ${project.name} <branch>`);
    return 0;
  }

  if (sub === "fetch" || sub === "prs") {
    if (name === undefined) {
      out.error(`usage: sandboxr project ${sub} <name>`);
      return 1;
    }
    const project = await findProject(name, { env });
    if (!project) return noProject(out, name);
    return sub === "fetch" ? await projectFetch(project, out) : await projectPulls(project, out);
  }

  out.error("usage: sandboxr project ls|available|clone|fetch|prs");
  return 1;
}

/**
 * The repositories you could add, and which ones you already have.
 *
 * Adding a project used to mean knowing a clone URL and typing it. This is the
 * same list the dashboard offers, from the same call, so the two faces cannot
 * disagree about what is on offer or about which rows are already here.
 *
 * `added` is core's origin join rather than a string comparison: a project
 * cloned over ssh records `git@github.com:owner/repo.git` while the listing
 * gives the https URL, and comparing those would offer to clone something that
 * is already in the workspace.
 */
async function projectAvailable(out: Output, env: NodeJS.ProcessEnv): Promise<number> {
  const [repos, projects] = await Promise.all([
    // The cap is core's, and it keeps the most recently updated. Said out loud
    // rather than silently truncating: a repository missing from a list you are
    // picking from reads as "gh cannot see it", which is a different problem.
    listRemoteRepos({ log: (line) => out.warn(line) }),
    listProjects({ env }),
  ]);

  const rows = repos.map((repo) => ({ ...repo, added: projects.some((project) => matchesOrigin(project, repo)) }));

  if (out.json) {
    out.data(rows);
    return 0;
  }

  // An empty list has two causes and only one of them is "your account has no
  // repositories". core answers both the same way on purpose — a missing forge
  // must not take the dashboard down — which leaves telling them apart to
  // whoever is talking to a person. Not a failure either way: a machine without
  // gh is an ordinary machine, and `project clone <url>` still works on it.
  if (rows.length === 0) {
    if (!(await ghAvailable())) {
      out.line("gh is not installed here, or is not logged in, so there are no repositories to list.");
      out.dim("      brew install gh && gh auth login");
    } else {
      out.line("gh can see no repositories for this account.");
    }
    return 0;
  }

  out.table(
    ["REPOSITORY", "VISIBILITY", "UPDATED", "STATUS"],
    rows.map((repo) => [
      repo.fork ? `${repo.fullName}*` : repo.fullName,
      repo.visibility,
      // The date alone: the time of day is never why you pick one of these, and
      // a full timestamp costs the column that the repository name wants.
      repo.updated === "" ? "-" : repo.updated.slice(0, 10),
      repo.added ? "added" : "-",
    ]),
  );

  // Only when something is actually starred, for cmdList's reason: a legend for
  // a mark that is not in the table sends you looking for it.
  if (rows.some((repo) => repo.fork)) {
    out.line();
    out.dim("* a fork");
  }
  out.line();
  out.dim("      sandboxr project clone <url>");
  return 0;
}

async function projectFetch(project: Project, out: Output): Promise<number> {
  await fetchProject(project);
  if (out.json) out.data({ project: project.name, origin: project.origin, fetched: true });
  out.ok(`fetched ${project.name}${project.origin === "" ? "" : ` from ${project.origin}`}`);
  return 0;
}

async function projectPulls(project: Project, out: Output): Promise<number> {
  const pulls = await listPullRequests(project);
  if (out.json) {
    out.data(pulls);
    return 0;
  }

  // An empty list has four causes and only one of them is "nothing is open", so
  // it is worth one extra call to say which. core answers all four the same way
  // on purpose — a missing forge must not take the dashboard down — which leaves
  // telling them apart to whoever is talking to a person.
  if (pulls.length === 0) {
    if (!repoSlugFromUrl(project.origin)) {
      const origin = project.origin === "" ? "no origin" : project.origin;
      out.line(`${project.name} is not a GitHub repo (${origin}),`);
      out.line("so there are no pull requests to read.");
    } else if (!(await ghAvailable())) {
      out.line("gh is not installed here, or is not logged in, so pull requests cannot be read.");
      out.dim("      brew install gh && gh auth login");
    } else {
      out.line(`No open pull requests on ${project.name}.`);
    }
    return 0;
  }

  // The title goes last so a long one runs off the end rather than pushing the
  // branch — the column you copy into `worktree add` — off the screen.
  out.table(
    ["#", "BRANCH", "AUTHOR", "TITLE"],
    pulls.map((pull) => [
      pull.draft ? `${pull.number}*` : `${pull.number}`,
      pull.branch,
      pull.author,
      pull.title,
    ]),
  );
  out.line();
  out.dim("* draft");
  return 0;
}

async function cmdWorktree(args: ParsedArgs, out: Output, env: NodeJS.ProcessEnv): Promise<number> {
  const sub = args.positional[0] ?? "";
  const name = args.positional[1];
  const branch = args.positional[2];

  if (sub !== "ls" && sub !== "list" && sub !== "add" && sub !== "rm" && sub !== "remove") {
    out.error("usage: sandboxr worktree ls|add|rm <project> [branch]");
    return 1;
  }
  if (name === undefined) {
    out.error(`usage: sandboxr worktree ${sub} <project>${sub === "ls" || sub === "list" ? "" : " <branch>"}`);
    return 1;
  }

  const project = await findProject(name, { env });
  if (!project) return noProject(out, name);

  if (sub === "ls" || sub === "list") {
    const worktrees = await listWorktrees(project);
    if (out.json) {
      out.data(worktrees);
      return 0;
    }
    if (worktrees.length === 0) {
      out.line(`No worktrees yet. Cut one with: sandboxr worktree add ${project.name} <branch>`);
      return 0;
    }
    out.table(
      ["BRANCH", "HEAD", "PATH"],
      worktrees.map((worktree) => [
        // Detached is not a defect — it is how a branch somebody else has open
        // gets run — so it is a mark on the branch rather than a column of its own.
        worktree.detached ? `${worktree.branch}~` : worktree.branch,
        worktree.head,
        worktree.exists ? worktree.path : `${worktree.path} (GONE)`,
      ]),
    );
    if (worktrees.some((worktree) => worktree.detached)) {
      out.line();
      out.dim("~ detached, because the branch is checked out somewhere else");
    }
    return 0;
  }

  if (branch === undefined) {
    out.error(`usage: sandboxr worktree ${sub} ${project.name} <branch>`);
    return 1;
  }

  if (sub === "add") {
    const worktree = await addWorktree({
      project,
      branch,
      base: flagString(args, "base"),
      log: (line) => out.warn(line),
    });
    if (out.json) out.data(worktree);
    out.ok(`${worktree.branch} at ${worktree.path}`);
    out.dim(`      sandboxr up --project ${project.name} --branch ${worktree.branch}`);
    return 0;
  }

  // Removal takes a branch but core takes a path, and the mapping is looked up
  // in the listing rather than rebuilt from the branch name: a worktree cut
  // before the naming changed, or one added by hand, still has to be removable.
  const worktrees = await listWorktrees(project);
  const found =
    worktrees.find((worktree) => worktree.branch === branch) ??
    worktrees.find((worktree) => basename(worktree.path) === sanitizeSlug(branch));
  if (!found) {
    out.error(`no worktree for ${branch} in ${project.name}`);
    out.dim(`      sandboxr worktree ls ${project.name}`);
    return 1;
  }

  await removeWorktree(project, found.path, { force: flagBoolean(args, "force") });
  if (out.json) out.data({ project: project.name, branch: found.branch, path: found.path, removed: true });
  out.ok(`removed ${found.path}`);
  return 0;
}

function noProject(out: Output, name: string): number {
  out.error(`no project called ${name} in the workspace`);
  out.dim("      sandboxr project ls");
  return 1;
}

async function cmdDb(args: ParsedArgs, out: Output, cwd: string, env: NodeJS.ProcessEnv): Promise<number> {
  const sub = args.positional[0] ?? "";
  const { config, slug, worktree } = await target(args, cwd, env, 1);
  const driver = getDriver(config.database.driver);

  // The driver context is built through core's own factory, which is what wires
  // `exec` to this sandbox's container — so every destructive operation lands on
  // the copy inside it.
  const ctx = driverContext(config, { slug, worktree, env, log: (line: string) => out.step(line) });

  switch (sub) {
    case "seed": {
      const artifact = await driver.prepareSeed(ctx);
      if (out.json) out.data(artifact);
      else out.ok(`${artifact.kind} from ${artifact.source} (${artifact.key})`);
      return 0;
    }
    case "migrate": {
      const result = await driver.migrate(ctx);
      if (out.json) out.data(result);
      if (result.healed?.length) out.warn(`healed in the copy: ${result.healed.join(", ")}`);
      if (result.ok) {
        out.ok(`${result.applied.length} migration(s) applied`);
        return 0;
      }
      out.error(`migration failed${result.failed ? ` at ${result.failed}` : ""}`);
      out.dim(`      the database is left exactly as it is, for you to inspect`);
      if (result.baseline) out.dim(`      schema before: ${result.baseline}`);
      return 1;
    }
    case "snapshot": {
      const schema = await driver.snapshot(ctx);
      // The schema is the result here rather than a description of it, so it
      // goes to stdout unaltered whether or not --json was asked for:
      // `sandboxr db snapshot > before.sql` has to produce a usable file.
      if (out.json) out.data({ project: config.project, slug, schema });
      else out.raw(schema.endsWith("\n") ? schema : `${schema}\n`);
      return 0;
    }
    case "shell":
      await driver.shell(ctx);
      return 0;
    default:
      out.error("usage: sandboxr db seed|migrate|snapshot|shell [slug]");
      return 1;
  }
}

/* --- secrets ------------------------------------------------------------------
 *
 * The rule the whole group is built around: **no command here prints a value.**
 * `revealProjectSecret` exists in core and is deliberately never called from the
 * CLI, because this is the surface that gets run in a screen share, pasted into
 * a ticket, and handed to an agent whose transcript nobody reads. `list` prints
 * the name, the last four characters and the length — enough to tell two keys
 * apart and to spot a paste that lost its tail.
 *
 * `edit` is the one exception, and it is a different kind of act: it opens the
 * file in the editor the person already uses, which is the same trust as opening
 * that file by hand. Nothing is printed, so nothing lands in a transcript.
 */

async function cmdSecrets(
  args: ParsedArgs,
  out: Output,
  cwd: string,
  env: NodeJS.ProcessEnv,
  stdin: Stdin,
): Promise<number> {
  const sub = args.positional[0] ?? "";
  const config = await loadConfig(flagString(args, "worktree") ?? cwd, { enforceAccess: false, env });

  if (sub === "import") {
    // A merge by default. `--replace` is the old whole-file behaviour, which now
    // has to be asked for: the file holds hand-set values too, and rebuilding it
    // from .env files would drop every one of them without saying so.
    const replace = flagBoolean(args, "replace");
    const report = await importSecrets(config, { env, replace });
    if (out.json) out.data(report);
    for (const file of report.sources) out.ok(`read ${file}`);
    for (const file of report.missing) out.warn(`not found: ${file}`);
    out.ok(`${replace ? "wrote" : "merged"} ${report.count} credential(s) into ${report.file}`);
    // Names only, never values: this output is meant to be safe to show anyone.
    out.line("  imported (names only):");
    for (const name of report.names) out.line(`      ${name}`);
    return 0;
  }

  if (sub === "check") {
    const check = await checkSecrets(config, { env });
    if (out.json) out.data(check);
    if (!check.exists) {
      // Both ways in, because `import` alone is the wrong advice for the case
      // this feature exists for: a fresh checkout whose `.env` files are all
      // `.env.example` has nothing to import *from*, and being told to run a
      // command that reads nothing is worse than being told nothing.
      out.warn("no secrets file yet");
      out.dim("      set one by hand:            sandboxr secrets set " + (check.absent[0] ?? "NAME"));
      out.dim("      or take them from .env:     sandboxr secrets import");
      return 1;
    }
    for (const name of check.present) out.ok(name);
    for (const name of check.absent) out.warn(`${name} is missing`);
    return check.absent.length === 0 ? 0 : 1;
  }

  if (sub === "list" || sub === "ls") {
    const view = await describeProjectSecrets(config.project, config, { env });
    if (out.json) out.data(view);

    out.bold(view.file);
    if (view.vars.length === 0) {
      out.line(view.exists ? "  no credentials in it yet" : "  no secrets file yet");
    } else {
      out.table(
        ["NAME", "ENDS", "CHARS"],
        // The tail, never the value. `-` for a value too short to spare four
        // characters, which core decides rather than this table.
        view.vars.map((entry) => [entry.name, entry.hint ? `…${entry.hint}` : "-", String(entry.chars)]),
      );
    }

    for (const name of view.absent) out.warn(`${name} is declared in ${CONFIG_FILENAME} and not set`);
    if (view.absent.length > 0) out.dim(`      sandboxr secrets set ${view.absent[0] ?? "NAME"}`);
    warnShadowed(out, view.shadowed);
    warnIfNotEditable(out, config, view.exists);

    // A listing, so an empty one succeeds — `secrets check` is the command whose
    // exit code is meant to be read, and it is the one `doctor` and CI call.
    return 0;
  }

  if (sub === "set") {
    const name = args.positional[1];
    if (name === undefined) {
      out.error("usage: sandboxr secrets set NAME   (the value is read from a prompt or stdin)");
      return 1;
    }
    // Refused on the name alone before anything is asked for: making somebody
    // type a key in and then telling them the name was never allowed is the
    // one ordering that wastes a paste from a password manager.
    const nameRefusal = envNameRefusal(name, "", config);
    if (nameRefusal !== undefined) {
      out.error(`${name} ${nameRefusal}`);
      return 1;
    }

    const value = await readSecretValue(stdin, out, name);
    if (value === "") {
      // An empty value is not "set to nothing": the file's reader drops a blank
      // name, so it would look like the command had silently done nothing.
      out.error(`no value given, so ${name} is unchanged`);
      return 1;
    }

    // Checked here rather than left to the write: core collects a refusal and
    // saves the rest, which is right for a pasted file and wrong for one typed
    // name — it would leave a secrets file that exists and holds nothing, and
    // "no secrets file yet" is a different sentence from "nothing in it".
    const refusal = envNameRefusal(name, value, config);
    if (refusal !== undefined) {
      out.error(`${name} ${refusal}`);
      return 1;
    }

    const report = await editProjectSecrets(config.project, config, { set: { [name]: value } }, { env });
    if (out.json) out.data(report);

    const entry = report.vars.find((candidate) => candidate.name === name);
    const shape = entry ? ` — ${entry.chars} chars${entry.hint ? `, ends …${entry.hint}` : ""}` : "";
    out.ok(`${report.updated.includes(name) ? "updated" : "set"} ${name} in ${report.file}${shape}`);
    warnShadowed(out, report.shadowed.filter((shadow) => shadow === name));
    warnIfNotEditable(out, config, true);
    return 0;
  }

  if (sub === "unset") {
    const name = args.positional[1];
    if (name === undefined) {
      out.error("usage: sandboxr secrets unset NAME");
      return 1;
    }

    // Asked first rather than after the write, for two reasons: an edit that
    // removes nothing would still rewrite the file — creating one where there
    // was none — and the report could not tell "removed" from "was never there".
    const current = await readProjectSecrets(config.project, { env });
    if (!current.has(name)) {
      const file = paths(env).secretsFile(config.project);
      if (out.json) out.data({ file, name, removed: false });
      out.warn(`${name} is not set in ${file}, so there was nothing to remove`);
      // Not a failure: the file is in the state that was asked for, and a script
      // clearing a list of names should not have to know which were set.
      return 0;
    }

    const report = await editProjectSecrets(config.project, config, { unset: [name] }, { env });
    if (out.json) out.data(report);
    out.ok(`removed ${name} from ${report.file}`);
    return 0;
  }

  if (sub === "edit") {
    return await editSecretsFile(config, out, env);
  }

  out.error("usage: sandboxr secrets list|set|unset|edit|import|check");
  return 1;
}

/**
 * Says which of these names the project's own `env:` map will overwrite.
 *
 * A warning rather than a refusal, because core reports it as one and is right
 * to: the value is not wrong, it is simply not the one the sandbox will use.
 * Said out loud here because nothing else will say it — the variable has a
 * value, nothing fails, and it is the wrong value.
 */
function warnShadowed(out: Output, shadowed: string[]): void {
  for (const name of shadowed) {
    out.warn(`${name} is also in this project's env: map, which is exported last — the value here is ignored`);
  }
}

/**
 * Says when a file of real credentials is the thing stopping `up`.
 *
 * A public project may not carry them, and core enforces that by refusing to
 * start at all (sandbox/index.ts) rather than by quietly substituting dummies.
 * So the moment to say so is here, while somebody is putting a key in — not
 * later, as a sandbox that will not start for a reason two commands away.
 */
function warnIfNotEditable(out: Output, config: ResolvedConfig, exists: boolean): void {
  if (!exists || allowsRealCredentials(config)) return;
  out.warn(`${config.project} serves public apps, so \`up\` refuses to start while this file exists`);
  out.dim(`      set access.credentials to real, or access.apps to private, in ${CONFIG_FILENAME}`);
}

/**
 * One credential, from a person or from a pipe.
 *
 * Never from argv, which is the whole point: an argument is in the shell history
 * and in every `ps` on the machine for as long as the command runs. A pipe is
 * the form a server operator actually uses — `printf '%s' "$KEY" | sandboxr
 * secrets set ORQ_API_KEY` — so a non-terminal stdin is read rather than
 * refused.
 */
async function readSecretValue(stdin: Stdin, out: Output, name: string): Promise<string> {
  if (stdin.isTTY !== true) return stripOneNewline(await readAll(stdin));

  out.prompt(`value for ${name} (not shown): `);
  // readline echoes what is typed to its `output`; a sink that throws the echo
  // away is what makes this hidden, because while readline holds a terminal it
  // puts it in raw mode and the terminal is not echoing either.
  const discard = new Writable({ write: (_chunk, _encoding, done) => done() });
  const reader = createInterface({ input: stdin, output: discard, terminal: true });
  try {
    // No newline to strip on this path: readline hands over the line without the
    // ending that finished it.
    return await new Promise<string>((resolve) => {
      // Ctrl-C and Ctrl-D close the reader instead of answering it. Resolving
      // empty rather than rejecting sends both down the same path as an empty
      // answer, which the caller already reports as "nothing changed".
      reader.on("close", () => resolve(""));
      reader.question("", resolve);
    });
  } finally {
    reader.close();
    // The Enter that ended the read was not echoed, so the next line of output
    // would otherwise start halfway along the prompt.
    out.line();
  }
}

async function readAll(input: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of input) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Removes the line ending a pipe added, and nothing else.
 *
 * One newline, because `echo` adds exactly one and a credential that ends in a
 * newline is not the credential. Everything else is left alone: leading and
 * trailing spaces can be part of a value, and guessing costs more than it saves.
 * The `\r` goes with the `\n` it belongs to — a value carrying one would be
 * refused by core, with a message about a name rather than about line endings.
 */
function stripOneNewline(value: string): string {
  return value.replace(/\r?\n$/, "");
}

/**
 * Opens the project's secrets file in the person's editor.
 *
 * The exception to "nothing prints a value", and it is a different act: this is
 * the file, in the editor they would have opened it in by hand, with the same
 * trust. Nothing goes through the terminal, so nothing lands in a transcript.
 *
 * The editor is given a copy rather than the file itself, so that the save can
 * be *checked*: a refused name has to stay out of the file, and editing in place
 * would mean it was already in it by the time anything looked. The copy lives
 * beside the real file, not in the system temporary directory — it holds the
 * same values, and it should be under the same 0600 directory rather than
 * somewhere every process on the machine can read.
 */
async function editSecretsFile(config: ResolvedConfig, out: Output, env: NodeJS.ProcessEnv): Promise<number> {
  const file = paths(env).secretsFile(config.project);
  const before = await readProjectSecrets(config.project, { env });
  const draft = `${file}.editing`;

  const starting = await startingText(file, config, before.size);
  await mkdir(dirname(draft), { recursive: true });
  // 0600, because the draft holds exactly what the file holds. Core writes the
  // real file the same way, and a draft anyone could read would undo that.
  await writeFile(draft, starting, { encoding: "utf8", mode: 0o600 });

  let edited: string;
  try {
    const editor = editorCommand(env);
    out.dim(`      ${editor.join(" ")} — names are sorted and comments are dropped when it is saved`);
    const code = await runEditor(editor, draft, env);
    if (code !== 0) {
      out.error(`${editor[0]} exited ${code}, so nothing was changed`);
      return 1;
    }
    edited = await readFile(draft, "utf8");
  } finally {
    await unlink(draft).catch(() => undefined);
  }

  if (edited === starting) {
    out.ok(`no changes to ${file}`);
    return 0;
  }

  const kept = parseEnvFile(edited);
  const report = await editProjectSecrets(
    config.project,
    config,
    // A name the editor no longer has is a removal — including one left with an
    // empty value, which the file's own reader drops anyway, so `NAME=` and a
    // deleted line mean the same thing here as they do in an import.
    { text: edited, unset: [...before.keys()].filter((name) => !kept.has(name)) },
    { env },
  );
  if (out.json) out.data(report);

  // Named, not dropped: a refused line stays in the person's head as "I typed
  // that", and a save that quietly kept nineteen of twenty names is worse than
  // one that says which one it would not take.
  for (const refusal of report.refused) out.error(`${refusal.name} ${refusal.reason}`);
  for (const name of report.added) out.ok(`set ${name}`);
  for (const name of report.updated) out.ok(`updated ${name}`);
  for (const name of report.removed) out.ok(`removed ${name}`);
  out.ok(`${report.vars.length} credential(s) in ${file}`);
  warnShadowed(out, report.shadowed);
  warnIfNotEditable(out, config, report.exists);
  return report.refused.length === 0 ? 0 : 1;
}

/**
 * What the editor opens with.
 *
 * An existing file is offered exactly as it is. An empty one gets the names the
 * project declares, commented out, because the case `edit` exists for is a fresh
 * checkout whose `.env` files are all examples: there is nothing to import from,
 * and a blank buffer does not say which keys the project is waiting for.
 */
async function startingText(file: string, config: ResolvedConfig, count: number): Promise<string> {
  if (count > 0) {
    try {
      return await readFile(file, "utf8");
    } catch {
      // Unreadable but non-empty cannot happen in practice; falling through to
      // the template is still better than failing to open an editor at all.
    }
  }

  const declared = declaredNames(config);
  return [
    `# ${config.project}'s third-party credentials, for sandboxr. NAME=value, one per line.`,
    "#",
    "# Comments and order are not kept: the file is rewritten sorted by name.",
    "# Nothing describing where a service runs belongs here — a sandbox works out",
    "# its own database, storage and inter-service URLs.",
    ...(declared.length > 0
      ? ["#", `# ${CONFIG_FILENAME} says this project needs:`, ...declared.map((name) => `${name}=`)]
      : []),
    "",
  ].join("\n");
}

/**
 * The editor to open, in the order a Unix machine expects to be asked.
 *
 * `VISUAL` before `EDITOR` because the two mean "full-screen editor" and "line
 * editor", and this is a file somebody is reading. `vi` last because it is the
 * one editor POSIX requires to exist, so the fallback cannot itself fail.
 *
 * Split on whitespace rather than run through a shell: `EDITOR="code -w"` has to
 * work, and a value containing a shell metacharacter must not be interpreted.
 */
function editorCommand(env: NodeJS.ProcessEnv): string[] {
  const chosen = (env.VISUAL ?? env.EDITOR ?? "").trim();
  return chosen === "" ? ["vi"] : chosen.split(/\s+/);
}

/**
 * Runs the editor attached to this terminal, and waits for it to be closed.
 *
 * Given the environment the command itself was given rather than the process's,
 * so that the editor an injected env names is the editor that runs — the same
 * seam every other command reads `SANDBOXR_HOME` through.
 */
async function runEditor(command: string[], file: string, env: NodeJS.ProcessEnv): Promise<number> {
  const [program, ...rest] = command as [string, ...string[]];
  return await new Promise<number>((resolve, reject) => {
    const child = spawn(program, [...rest, file], { stdio: "inherit", env });
    // A clearer failure than "spawn code ENOENT", which reads as a bug in
    // sandboxr rather than as a variable pointing at something not installed.
    child.on("error", () =>
      reject(new Error(`could not start ${program} — set VISUAL or EDITOR to an editor on this machine`)),
    );
    // A killed editor has no exit code. Counted as a failure rather than as a
    // save, because there is nothing to say the buffer was written.
    child.on("close", (code) => resolve(code ?? 1));
  });
}

/**
 * Sets the machine up so a sandbox can be reached.
 *
 * Everything here is idempotent, because this is also how you change the
 * domain, rotate the password, or pick TLS up after installing mkcert's root.
 */
async function cmdInit(args: ParsedArgs, out: Output, env: NodeJS.ProcessEnv): Promise<number> {
  const tls = args.flags.tls === undefined ? undefined : flagBoolean(args, "tls");
  const http = flagNumber(args, "http-port");
  const https = flagNumber(args, "https-port");
  const report = await initAccess({
    env,
    tls,
    rebuild: flagBoolean(args, "rebuild"),
    bind: flagString(args, "bind"),
    ports: { ...(http ? { http } : {}), ...(https ? { https } : {}) },
    log: (line) => out.step(line),
  });

  if (out.json) out.data(report);
  out.ok(`Ready on ${report.domain}`);
  out.line();
  out.line(`  dashboard   ${report.dashboardUrl}`);
  const suffix = report.dashboardUrl.slice(`${report.scheme}://${report.domain}`.length);
  out.line(`  sandboxes   ${report.scheme}://<slug>.<label>.<project>.${report.domain}${suffix}`);
  out.line();
  // `.localhost` resolves to the loopback address with no configuration at all,
  // which is the whole reason it is the default — saying so once here saves the
  // reader wondering what they were supposed to have set up.
  out.dim(`  Any name under ${report.domain} resolves to 127.0.0.1 on its own. Nothing to configure.`);
  for (const note of report.notes) {
    out.line();
    out.warn(note);
  }
  out.line();
  out.dim("  Next: cd into a project with a sandboxr.yaml and run `sandboxr up`.");
  return 0;
}

/** Stops the shared plumbing. Sandboxes are `down`'s business, not this. */
async function cmdTeardown(args: ParsedArgs, out: Output, env: NodeJS.ProcessEnv): Promise<number> {
  const result = await teardownAccess({
    env,
    network: flagBoolean(args, "network"),
    log: (line) => out.ok(line),
  });
  if (out.json) out.data(result);
  if (result.removed.length === 0) out.line("Nothing to tear down.");
  else out.dim("  Sandboxes are left alone. Use `sandboxr down` for those.");
  return 0;
}

async function cmdConfig(args: ParsedArgs, out: Output, cwd: string, env: NodeJS.ProcessEnv): Promise<number> {
  const from = flagString(args, "worktree") ?? cwd;
  // locateConfig rather than findConfig, and the whole location rather than just
  // the file: a managed worktree may be governed by a config that is not in it,
  // and handing the file back to loadConfig on its own would lose the root.
  const location = await locateConfig(from, { env });
  if (!location) {
    out.error(`no sandboxr.yaml here or in any parent of ${from}`);
    return 2;
  }
  const config = await loadConfig(from, { enforceAccess: false, env });
  if (out.json) {
    out.data(config);
    return 0;
  }
  out.bold(config.project);
  out.line(`  file        ${config.file}`);
  out.line(`  root        ${config.root}`);
  // Said out loud, never inferred. A project running from a config that is not
  // in its own repository is exactly the thing somebody must not have to guess
  // at when a path in it resolves somewhere they did not expect.
  if (config.origin === "project") {
    out.line("  origin      the workspace project directory, not this worktree");
    out.warn(`this worktree has no ${CONFIG_FILENAME} of its own, so the project-level one applies`);
    out.dim("  Commit one to the repository and it wins over this file from then on.");
  } else {
    out.line("  origin      this checkout");
  }
  out.line(`  driver      ${config.database.driver}`);
  out.line(`  access      apps ${config.access.apps}, credentials ${config.access.credentials}`);
  out.line(`  backends    ${config.backends.map((backend) => backend.label).join(", ") || "none"}`);
  out.line(
    `  frontends   ${config.frontends.map((app) => `${app.label} (${app.kind})`).join(", ") || "none"}`,
  );
  return 0;
}

/**
 * Checks the local setup and says what is missing.
 *
 * Every check names the fix, because "docker is not running" without "start
 * Docker Desktop" is a diagnosis with no next step.
 */
async function cmdDoctor(args: ParsedArgs, out: Output, cwd: string, env: NodeJS.ProcessEnv): Promise<number> {
  const from = flagString(args, "worktree") ?? cwd;
  const findings: Array<{ ok: boolean; text: string; fix?: string }> = [];
  const p = paths(env);

  const dockerUp = await docker.available();
  findings.push(
    dockerUp
      ? { ok: true, text: "Docker is running" }
      : { ok: false, text: "Docker is not running", fix: "start Docker and try again" },
  );

  // The access layer is what makes a sandbox reachable, so it is checked before
  // anything about a project: a perfect config on a machine with no router
  // produces a container nothing can address.
  if (dockerUp) {
    const access = await accessStatus({ env });
    findings.push(
      access.baseImagePresent
        ? { ok: true, text: "the base image is built" }
        : { ok: false, text: "no base image", fix: "sandboxr init" },
    );
    findings.push(
      access.routerRunning
        ? { ok: true, text: `router is up, serving ${access.scheme} on ${access.domain}` }
        : { ok: false, text: "the shared router is not running", fix: "sandboxr init" },
    );
    findings.push(
      access.dashboardRunning
        ? { ok: true, text: `dashboard is up at ${access.scheme}://${access.domain}` }
        : { ok: false, text: "the dashboard is not running", fix: "sandboxr init" },
    );
    if (access.scheme === "http") {
      findings.push({
        ok: true,
        text: "serving plain http (a locally-trusted certificate would upgrade it)",
      });
    } else if (!access.certificateTrusted) {
      findings.push({
        ok: false,
        text: "the certificate's root is not in this machine's trust store",
        fix: "mkcert -install",
      });
    }
    if (!env.SANDBOXR_PASSWORD) {
      findings.push({
        ok: false,
        text: "SANDBOXR_PASSWORD is not set, so the dashboard admits nobody",
        fix: "export SANDBOXR_PASSWORD=… && sandboxr init",
      });
    }
  }

  const location = await locateConfig(from, { env });
  if (!location) {
    findings.push({
      ok: false,
      text: `no sandboxr.yaml in ${from} or any parent directory`,
      fix: "add one at the root of the project you want to sandbox",
    });
  } else {
    findings.push({
      ok: true,
      text:
        location.origin === "project"
          ? `config at ${location.file}, the project-level one — this worktree has none of its own`
          : `config at ${location.file}`,
    });
    try {
      const config = await loadConfig(from, { env });
      findings.push({ ok: true, text: `${config.project} resolves, driver ${config.database.driver}` });
      // Not a refusal: a project can point its runtime at the sandbox's state
      // directory through a config file this cannot read, so being unable to see
      // the flag is a strong signal rather than a certainty.
      for (const advice of persistenceAdvice(config)) {
        findings.push({ ok: false, text: `${advice.field}: ${advice.reason}`, fix: advice.fix });
      }
      const check = await checkSecrets(config, { env });
      findings.push(
        check.absent.length === 0
          ? { ok: true, text: "every credential the config asks for is present" }
          : {
              ok: false,
              text: `missing credentials: ${check.absent.join(", ")}`,
              // Named by name, and `set` first: a project with no `.env` files
              // on disk has nothing to import from, which is exactly the case a
              // missing credential is most likely to be.
              fix: `sandboxr secrets set ${check.absent[0] ?? "NAME"}, or sandboxr secrets import`,
            },
      );
    } catch (error) {
      findings.push({
        ok: false,
        text: (error as Error).message,
        fix: error instanceof ConfigError ? "fix the field named above" : undefined,
      });
    }
  }

  findings.push({ ok: true, text: `home ${p.home}` });

  const sandboxes: Sandbox[] = await list({ env }).catch(() => []);
  findings.push({ ok: true, text: `${sandboxes.length} sandbox(es) on this machine` });

  for (const finding of findings) {
    if (finding.ok) out.ok(finding.text);
    else {
      out.error(finding.text);
      if (finding.fix) out.dim(`      ${finding.fix}`);
    }
  }
  if (out.json) out.data(findings);

  const problems = findings.filter((finding) => !finding.ok).length;
  if (problems > 0) out.error(`${problems} problem(s) above`);
  else out.ok("All good.");
  return problems > 0 ? 1 : 0;
}
