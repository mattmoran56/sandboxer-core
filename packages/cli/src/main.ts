/**
 * `sandboxr` — dispatch and argument handling only; the work lives in
 * @sandboxr/core.
 *
 * Every command returns an exit code rather than calling `process.exit`, so the
 * whole surface can be driven from a test without ending the test run.
 */

import {
  ConfigError,
  TOOL_VERSION,
  accessStatus,
  checkSecrets,
  containerName,
  deriveSlug,
  docker,
  down,
  driverContext,
  findConfig,
  gc,
  getDriver,
  gitFacts,
  importSecrets,
  initAccess,
  list,
  loadConfig,
  paths,
  persistenceAdvice,
  reload,
  status,
  teardownAccess,
  up,
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
     --with a,b                Also start these optional runtimes
     --seed local|file|fixtures  Force a seed source
     --detach                  Do not wait for it to come up
  down [slug] [--keep]         Remove it, and its database and uploads
  ls [--project NAME]          Every sandbox: state, branch, worktree
  status [slug]                One sandbox in detail
  logs [slug] [--tail N] [-f]  The container's own log stream
  shell [slug]                 A shell inside the sandbox
  reload [slug] --go [name]    Rebuild a backend and restart it
                --web <label|all|built>   Rebuild a front-end
                --migrate      Re-run this sandbox's migrations
  gc [--dry-run]               Reap sandboxes whose worktree is gone

DATABASE
  db seed [--seed SOURCE]      Produce or refresh the seed artifact
  db migrate [slug]            Run the project's migrations against the copy
  db snapshot [slug]           Print the schema
  db shell [slug]              An interactive database shell

SECRETS
  secrets import               Build the project's secrets file from its .env files
  secrets check                Say which credentials are missing, by name

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
}

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
      case "status":
        return await cmdStatus(args, out, cwd, env);
      case "logs":
        return await cmdLogs(args, out, cwd);
      case "shell":
        return await cmdShell(args, out, cwd);
      case "reload":
        return await cmdReload(args, out, cwd, env);
      case "gc":
        return await cmdGc(args, out, env);
      case "db":
        return await cmdDb(args, out, cwd, env);
      case "secrets":
        return await cmdSecrets(args, out, cwd, env);
      case "init":
        return await cmdInit(args, out, env);
      case "teardown":
        return await cmdTeardown(args, out, env);
      case "config":
        return await cmdConfig(args, out, cwd);
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
async function target(
  args: ParsedArgs,
  cwd: string,
  positionalIndex = 0,
): Promise<{ config: ResolvedConfig; slug: string; worktree: string }> {
  const worktree = flagString(args, "worktree") ?? cwd;
  const config = await loadConfig(worktree, { enforceAccess: false });
  const facts = await gitFacts(worktree);
  const slug = deriveSlug({
    explicit: args.positional[positionalIndex] ?? flagString(args, "slug"),
    worktreeDir: facts.directory,
    branch: facts.branch === "?" ? undefined : facts.branch,
  });
  return { config, slug, worktree: facts.worktree };
}

async function cmdUp(args: ParsedArgs, out: Output, cwd: string, env: NodeJS.ProcessEnv): Promise<number> {
  const worktree = flagString(args, "worktree") ?? cwd;
  // Enforced here rather than in `target`: this is the one command that decides
  // to *start* something, so it is where a §5.3 refusal belongs.
  const config = await loadConfig(worktree);

  const seed = flagString(args, "seed");
  // Checked rather than cast: an unrecognised source would otherwise be handed
  // to the driver, match no branch, and look like the config was at fault.
  if (seed !== undefined && !SEED_SOURCES.includes(seed as SeedSource)) {
    out.error(`--seed ${seed} is not a source — one of ${SEED_SOURCES.join(", ")}`);
    return 1;
  }

  const result = await up({
    config,
    worktree,
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
  const { config, slug } = await target(args, cwd);
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
  out.table(
    ["PROJECT", "SLUG", "STATE", "BRANCH", "WORKTREE"],
    sandboxes.map((sandbox) => [
      sandbox.project,
      sandbox.slug,
      sandbox.state,
      // The star is the only place `dirty` shows, and it is worth the character:
      // a sandbox built from uncommitted work is not reproducible from its
      // commit alone.
      sandbox.dirty ? `${sandbox.branch}*` : sandbox.branch,
      sandbox.worktree,
    ]),
  );
  out.line();
  out.dim("* uncommitted changes when the sandbox started");
  return 0;
}

async function cmdStatus(args: ParsedArgs, out: Output, cwd: string, env: NodeJS.ProcessEnv): Promise<number> {
  const { config, slug } = await target(args, cwd);
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

async function cmdLogs(args: ParsedArgs, out: Output, cwd: string): Promise<number> {
  const { config, slug } = await target(args, cwd);
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

async function cmdShell(args: ParsedArgs, out: Output, cwd: string): Promise<number> {
  const { config, slug } = await target(args, cwd);
  void out;
  // Anything after a bare `--` is the command to run instead of a login shell,
  // which is what makes `sandboxr shell -- go test ./...` work from a script.
  const command = args.rest.length > 0 ? args.rest : ["bash"];
  return docker.execInteractive(containerName(config.project, slug), command, { workdir: "/workspace" });
}

async function cmdReload(args: ParsedArgs, out: Output, cwd: string, env: NodeJS.ProcessEnv): Promise<number> {
  const { config, slug } = await target(args, cwd);

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

async function cmdDb(args: ParsedArgs, out: Output, cwd: string, env: NodeJS.ProcessEnv): Promise<number> {
  const sub = args.positional[0] ?? "";
  const { config, slug, worktree } = await target(args, cwd, 1);
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

async function cmdSecrets(args: ParsedArgs, out: Output, cwd: string, env: NodeJS.ProcessEnv): Promise<number> {
  const sub = args.positional[0] ?? "";
  const config = await loadConfig(flagString(args, "worktree") ?? cwd, { enforceAccess: false });

  if (sub === "import") {
    const report = await importSecrets(config, { env });
    if (out.json) out.data(report);
    for (const file of report.sources) out.ok(`read ${file}`);
    for (const file of report.missing) out.warn(`not found: ${file}`);
    out.ok(`wrote ${report.count} credential(s) to ${report.file}`);
    // Names only, never values: this output is meant to be safe to show anyone.
    out.line("  imported (names only):");
    for (const name of report.names) out.line(`      ${name}`);
    return 0;
  }

  if (sub === "check") {
    const check = await checkSecrets(config, { env });
    if (out.json) out.data(check);
    if (!check.exists) {
      out.warn(`no secrets file yet — run: sandboxr secrets import`);
      return 1;
    }
    for (const name of check.present) out.ok(name);
    for (const name of check.absent) out.warn(`${name} is missing`);
    return check.absent.length === 0 ? 0 : 1;
  }

  out.error("usage: sandboxr secrets import|check");
  return 1;
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

async function cmdConfig(args: ParsedArgs, out: Output, cwd: string): Promise<number> {
  const from = flagString(args, "worktree") ?? cwd;
  const file = await findConfig(from);
  if (!file) {
    out.error(`no sandboxr.yaml here or in any parent of ${from}`);
    return 2;
  }
  const config = await loadConfig(file, { enforceAccess: false });
  if (out.json) {
    out.data(config);
    return 0;
  }
  out.bold(config.project);
  out.line(`  file        ${config.file}`);
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

  const file = await findConfig(from);
  if (!file) {
    findings.push({
      ok: false,
      text: `no sandboxr.yaml in ${from} or any parent directory`,
      fix: "add one at the root of the project you want to sandbox",
    });
  } else {
    findings.push({ ok: true, text: `config at ${file}` });
    try {
      const config = await loadConfig(file);
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
              fix: "sandboxr secrets import",
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
