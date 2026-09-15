// Tests for the lifecycle against a fake docker daemon:
// - list: builds sandboxes from labels, filters by project, sorts, and ignores a container that is not ours
// - list: a stopped container is never asked for its markers
// - down: removes the container and every volume it owned; --keep leaves the volumes
// - down: never names a session's work volume — deleting a runtime is not deleting a session
// - down: removes the plan, environment, heartbeat and logs the sandbox was named after
// - down: a slug with no container is reported rather than treated as an error
// - up: writes the environment file, carries the labels, and starts the container
// - up: refuses a public sandbox that would carry real credentials, and names both ways out
// - up: keys config.yaml on the workspace directory as well as the declared project:
// - up: says once that this project's sandboxes carry no GitHub token, and names both reasons push fails
// - up: a failed provision leaves the sandbox up and reports the failure
// - reload: a backend build failure leaves the running process alone; a success restarts it
// - reload: `all` covers the build-everything set, `built` covers what the sandbox has built, a name covers one app
// - reload: a served front-end is restarted rather than built
// - gc: reaps a sandbox whose worktree is gone, and does nothing under dryRun
// - gc: removes a superseded project image and leaves the newest one alone
// - gc: a daemon that will not report its disk usage still reaps containers and volumes
// - prune: reports without removing until it is told to apply
// - prune: removes a superseded project image and leaves the newest one alone
// - prune: the build cache is out of scope unless it is asked for

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveConfig } from "../config/load.js";
import type { ResolvedConfig } from "../config/types.js";
import type { ContainerRow, DiskUsage, Docker, ExecResult } from "../docker.js";
import { LABELS, labelsFor } from "./labels.js";
import { down, gc, list, prune, reload, status, up } from "./index.js";

interface FakeOptions {
  rows?: ContainerRow[];
  exec?: (cmd: string[]) => Partial<ExecResult>;
  volumes?: string[];
  running?: boolean;
  exists?: boolean;
  startedAt?: Date | undefined;
  usage?: DiskUsage;
  /** `docker system df` refusing to answer, which is not the same as an empty machine. */
  usageFails?: boolean;
}

/** A docker whose every call is recorded and whose answers are declarative. */
function fakeDocker(options: FakeOptions = {}) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const record = (method: string, ...args: unknown[]) => calls.push({ method, args });
  const rows = options.rows ?? [];

  const docker: Docker = {
    raw: async (args) => {
      record("raw", args);
      return { code: 0, stdout: "", stderr: "" };
    },
    ok: async (args) => {
      record("ok", args);
      // A `docker run` leaves a container behind, so the fake grows one from
      // the arguments — which is also how the labels a start wrote get read
      // back by the same call chain the real thing uses.
      if (args[0] === "run") {
        const name = args[args.indexOf("--name") + 1] ?? "";
        const labels: Record<string, string> = {};
        args.forEach((arg, index) => {
          if (arg !== "--label") return;
          const pair = args[index + 1] ?? "";
          const eq = pair.indexOf("=");
          if (eq > 0) labels[pair.slice(0, eq)] = pair.slice(eq + 1);
        });
        rows.push({ name, id: name, state: "running", labels });
      }
      return { code: 0, stdout: "", stderr: "" };
    },
    available: async () => true,
    ps: async (filters) => {
      record("ps", filters);
      return rows.filter((row) =>
        filters.every((filter) => {
          const [, key, value] = /^label=([^=]+)(?:=(.*))?$/.exec(filter) ?? [];
          if (!key) return true;
          return value === undefined ? key in row.labels : row.labels[key] === value;
        }),
      );
    },
    inspect: async (name) => {
      record("inspect", name);
      return { Mounts: [] };
    },
    containerExists: async (name) => {
      record("containerExists", name);
      return options.exists ?? rows.some((row) => row.name === name);
    },
    containerRunning: async (name) => {
      record("containerRunning", name);
      return options.running ?? rows.some((row) => row.name === name && row.state === "running");
    },
    labels: async (name) => {
      record("labels", name);
      return rows.find((row) => row.name === name)?.labels ?? {};
    },
    exec: async (name, cmd, execOptions) => {
      record("exec", name, cmd, execOptions);
      const reply = options.exec?.(cmd) ?? {};
      return { code: reply.code ?? 0, stdout: reply.stdout ?? "", stderr: reply.stderr ?? "" };
    },
    execInteractive: async (name, cmd) => {
      record("execInteractive", name, cmd);
      return 0;
    },
    stop: async (name) => {
      record("stop", name);
      const row = rows.find((r) => r.name === name);
      if (row) row.state = "exited";
    },
    start: async (name) => {
      record("start", name);
      const row = rows.find((r) => r.name === name);
      if (row) row.state = "running";
    },
    startedAt: async (name) => {
      record("startedAt", name);
      return options.startedAt;
    },
    logs: async () => ({ code: 0, stdout: "", stderr: "" }),
    logsFollow: async () => {
      record("logsFollow");
      return 0;
    },
    rm: async (name, rmOptions) => {
      record("rm", name, rmOptions);
    },
    volumes: async () => options.volumes ?? [],
    volumeRm: async (name) => {
      record("volumeRm", name);
      return true;
    },
    ensureNetwork: async (name) => {
      record("ensureNetwork", name);
    },
    imageExists: async () => true,
    diskUsage: async () => {
      record("diskUsage");
      if (options.usageFails) throw new Error("docker system df -v exited 1");
      return options.usage ?? { images: [], volumes: [], buildCache: [] };
    },
    imageRm: async (reference) => {
      record("imageRm", reference);
      return true;
    },
    builderPrune: async (pruneOptions) => {
      record("builderPrune", pruneOptions);
      return 1_000_000;
    },
    cp: async (from, container, to) => {
      record("cp", from, container, to);
    },
  };

  const argsOf = (method: string) => calls.filter((call) => call.method === method).map((call) => call.args);
  return { docker, calls, argsOf };
}

function row(labels: Record<string, string>, name: string, state = "running"): ContainerRow {
  return { name, id: name, state, labels };
}

function configOf(extra: Record<string, unknown> = {}, file = "/repo/sandboxr.yaml"): ResolvedConfig {
  return resolveConfig(
    {
      project: "acme",
      sandboxr: ">=0.1.0",
      access: { apps: "private" },
      database: { driver: "mysql", seed_from: { fixtures: "seeds/f.sql" }, migrate: { command: "migrate" } },
      backends: [{ name: "api", port: 8001, label: "api", build: "build -o {out} ./{name}" }],
      frontends: {
        defaults: { build: "build", out: "dist" },
        apps: [
          { label: "app", package: "web" },
          { label: "www", package: "marketing", in_build_all: false },
          { label: "cms", package: "cms", serve: "serve", port: 3000 },
        ],
      },
      ...extra,
    },
    file,
  );
}

const labelsOf = (slug: string, project = "acme") =>
  labelsFor({
    project,
    slug,
    branch: "feat/thing",
    commit: "abc",
    dirty: false,
    worktree: `/repos/${slug}`,
    driver: "mysql",
    access: "private",
  });

describe("list", () => {
  it("builds a sandbox from each container's labels", async () => {
    const { docker } = fakeDocker({
      rows: [row(labelsOf("tkt-1"), "sandboxr-acme-tkt-1")],
      exec: () => ({ stdout: '{"state":"ok","file":"","error":""}' }),
    });
    const sandboxes = await list({ docker });
    expect(sandboxes).toHaveLength(1);
    expect(sandboxes[0]).toMatchObject({ slug: "tkt-1", project: "acme", state: "running", driver: "mysql" });
  });

  it("filters by project", async () => {
    const { docker, argsOf } = fakeDocker({
      rows: [row(labelsOf("a"), "sandboxr-acme-a"), row(labelsOf("b", "other"), "sandboxr-other-b")],
      exec: () => ({ stdout: '{"state":"ok","file":"","error":""}' }),
    });
    const sandboxes = await list({ docker, project: "acme" });
    expect(sandboxes.map((sandbox) => sandbox.slug)).toEqual(["a"]);
    expect(argsOf("ps")[0]?.[0]).toEqual(["label=sandboxr.slug", "label=sandboxr.project=acme"]);
  });

  it("sorts by project and slug, so the list is stable between runs", async () => {
    const { docker } = fakeDocker({
      rows: [row(labelsOf("b"), "sandboxr-acme-b"), row(labelsOf("a"), "sandboxr-acme-a")],
      exec: () => ({ stdout: '{"state":"ok","file":"","error":""}' }),
    });
    expect((await list({ docker })).map((sandbox) => sandbox.slug)).toEqual(["a", "b"]);
  });

  it("ignores a container of ours that has lost its slug label", async () => {
    const { docker } = fakeDocker({ rows: [row({ "sandboxr.project": "acme" }, "sandboxr-acme-x")] });
    expect(await list({ docker })).toEqual([]);
  });

  // Asking a stopped container for its markers costs an exec that always fails.
  it("does not ask a stopped container about its migrations", async () => {
    const { docker, argsOf } = fakeDocker({ rows: [row(labelsOf("a"), "sandboxr-acme-a", "exited")] });
    const sandboxes = await list({ docker });
    expect(sandboxes[0]?.state).toBe("stopped");
    expect(argsOf("exec")).toHaveLength(0);
  });

  it("reports a running sandbox whose migrations failed as degraded", async () => {
    const { docker } = fakeDocker({
      rows: [row(labelsOf("a"), "sandboxr-acme-a")],
      exec: () => ({ stdout: '{"state":"failed","file":"001.sql","error":""}' }),
    });
    expect((await list({ docker }))[0]?.state).toBe("degraded");
  });
});

describe("down", () => {
  /** A home of its own per test, so a teardown cannot reach the machine's real one. */
  async function tempHome(): Promise<string> {
    return mkdtemp(join(tmpdir(), "sbx-down-"));
  }

  it("removes the container and every volume it owned", async () => {
    const { docker, argsOf } = fakeDocker({ exists: true });
    const report = await down("acme", "tkt-1", { docker, env: { SANDBOXR_HOME: await tempHome() } });
    expect(argsOf("rm")[0]?.[0]).toBe("sandboxr-acme-tkt-1");
    expect(argsOf("volumeRm").map((args) => args[0])).toEqual([
      "sandboxr-data-acme-tkt-1",
      "sandboxr-blob-acme-tkt-1",
      "sandboxr-bin-acme-tkt-1",
      "sandboxr-www-acme-tkt-1",
    ]);
    expect(report.removed).toContain("sandboxr-acme-tkt-1");
    expect(report.removed).toContain("sandboxr-data-acme-tkt-1");
  });

  // The generated files are named after the sandbox and nothing else can derive
  // that name once the worktree has gone, so a teardown that leaves them behind
  // leaves them forever.
  it("removes the plan, the environment, the heartbeat and the logs it was named after", async () => {
    const home = await tempHome();
    await mkdir(join(home, "build", "acme"), { recursive: true });
    await mkdir(join(home, "logs", "acme", "tkt-1"), { recursive: true });
    await mkdir(join(home, "state", "attach", "acme"), { recursive: true });
    await writeFile(join(home, "build", "acme", "tkt-1.plan.json"), "{}\n");
    await writeFile(join(home, "build", "acme", "tkt-1.env"), "A=1\n");
    await writeFile(join(home, "state", "attach", "acme", "tkt-1"), "now\n");

    const { docker } = fakeDocker({ exists: true });
    await down("acme", "tkt-1", { docker, env: { SANDBOXR_HOME: home } });

    expect(existsSync(join(home, "build", "acme", "tkt-1.plan.json"))).toBe(false);
    expect(existsSync(join(home, "build", "acme", "tkt-1.env"))).toBe(false);
    expect(existsSync(join(home, "state", "attach", "acme", "tkt-1"))).toBe(false);
    expect(existsSync(join(home, "logs", "acme", "tkt-1"))).toBe(false);
  });

  // Contracts §12.8: deleting a runtime removes that runtime's own data, and the
  // work volume is the session's rather than the runtime's — every other runtime
  // of the session is running from the code in it. It cannot be named here by
  // construction, because `down` asks for four purposes and a work volume is not
  // one of them, and this pins that so a fifth purpose cannot quietly be added.
  it("never names a work volume, even one belonging to the runtime's own session", async () => {
    const { docker, argsOf } = fakeDocker({
      exists: true,
      volumes: ["sandboxr-work-eng-3941", "sandboxr-data-acme-eng-3941-web"],
    });
    await down("acme", "eng-3941-web", { docker, env: { SANDBOXR_HOME: await tempHome() } });
    expect(argsOf("volumeRm").map((args) => args[0])).not.toContain("sandboxr-work-eng-3941");
  });

  // `--keep` means the container went and its data stayed, and the generated
  // files are on the same line as the volumes.
  it("keeps the volumes, and everything else it owned, when asked", async () => {
    const home = await tempHome();
    await mkdir(join(home, "logs", "acme", "tkt-1"), { recursive: true });

    const { docker, argsOf } = fakeDocker({ exists: true });
    await down("acme", "tkt-1", { docker, keep: true, env: { SANDBOXR_HOME: home } });

    expect(argsOf("volumeRm")).toHaveLength(0);
    expect(existsSync(join(home, "logs", "acme", "tkt-1"))).toBe(true);
  });

  it("says so rather than failing when there is no such sandbox", async () => {
    const { docker, argsOf } = fakeDocker({ exists: false });
    const lines: string[] = [];
    const report = await down("acme", "ghost", {
      docker,
      env: { SANDBOXR_HOME: await tempHome() },
      log: (line) => lines.push(line),
    });
    expect(lines.join(" ")).toMatch(/No sandbox called ghost/);
    expect(argsOf("rm")).toHaveLength(0);
    expect(report.removed).toEqual([]);
  });
});

describe("up", () => {
  async function worktree(): Promise<{ dir: string; home: string }> {
    const dir = await mkdtemp(join(tmpdir(), "sbx-up-"));
    await mkdir(join(dir, "tkt-1"), { recursive: true });
    return { dir: join(dir, "tkt-1"), home: join(dir, "home") };
  }

  it("writes the environment, labels the container and starts it", async () => {
    const { dir, home } = await worktree();
    const { docker, argsOf } = fakeDocker({ running: true, exists: false, exec: () => ({ stdout: '{"state":"ok","file":"","error":""}' }) });
    const result = await up({
      config: configOf(),
      worktree: dir,
      docker,
      env: { SANDBOXR_HOME: home, SANDBOXR_DOMAIN: "sbx.localhost" },
    });

    const runArguments = (argsOf("ok")[0]?.[0] ?? []) as string[];
    expect(runArguments[0]).toBe("run");
    expect(runArguments).toContain(`${LABELS.slug}=tkt-1`);
    // The config's own directory, not the directory the command ran in:
    // `/workspace` is the project, and a project is where its config is. A
    // project kept in a subdirectory of a larger repository would otherwise be
    // mounted one level too high and every path in its plan would miss.
    expect(runArguments).toContain("/repo:/workspace");
    expect(runArguments).toContain(`${LABELS.worktree}=/repo`);

    const envFile = join(home, "build", "acme", "tkt-1.env");
    expect(await readFile(envFile, "utf8")).toContain("SANDBOXR_SLUG=tkt-1");
    // http, not https: the URL follows what the router is actually serving, and
    // this home has never been through `init`, so nothing terminates TLS.
    expect(result.urls.app).toBe("http://tkt-1--app--acme.sbx.localhost");
    expect(result.seed.source).toBe("fixtures");
  });

  // Printing an https URL for a router that terminates no TLS sends the reader
  // to a connection refused, so the scheme is read from the router's own state.
  it("uses https once the router has a certificate to serve", async () => {
    const { dir, home } = await worktree();
    await mkdir(join(home, "state", "dynamic"), { recursive: true });
    // The router's entry for the base certificate is what everything else reads
    // to decide the scheme, so this is the file that has to exist.
    await writeFile(join(home, "state", "dynamic", "cert-sbx.localhost.yml"), "tls: {}\n");
    const { docker, argsOf } = fakeDocker({ running: true, exists: false, exec: () => ({ stdout: '{"state":"ok","file":"","error":""}' }) });

    const result = await up({
      config: configOf(),
      worktree: dir,
      docker,
      env: { SANDBOXR_HOME: home, SANDBOXR_DOMAIN: "sbx.localhost" },
    });

    expect(result.urls.app).toBe("https://tkt-1--app--acme.sbx.localhost");
    const runArguments = (argsOf("ok")[0]?.[0] ?? []) as string[];
    expect(runArguments).toContain("traefik.http.routers.sandboxr-acme-tkt-1.entrypoints=websecure");
    expect(runArguments).toContain("traefik.http.routers.sandboxr-acme-tkt-1.tls=true");
  });

  // The router has to be told about a sandbox at the moment it starts, or the
  // container comes up serving on port 80 with nothing able to address it.
  it("labels the container for the shared router", async () => {
    const { dir, home } = await worktree();
    const { docker, argsOf } = fakeDocker({ running: true, exists: false, exec: () => ({ stdout: '{"state":"ok","file":"","error":""}' }) });
    await up({
      config: configOf(),
      worktree: dir,
      docker,
      env: { SANDBOXR_HOME: home, SANDBOXR_DOMAIN: "sbx.localhost" },
    });

    const runArguments = (argsOf("ok")[0]?.[0] ?? []) as string[];
    expect(runArguments).toContain("traefik.enable=true");
    expect(runArguments).toContain(
      "traefik.http.routers.sandboxr-acme-tkt-1.rule=HostRegexp(`^tkt-1--[a-z0-9]+(?:-[a-z0-9]+)*--acme\\.sbx\\.localhost$`)",
    );
    // Port 80 is the sandbox's own router, which is what splits by label.
    expect(runArguments).toContain("traefik.http.services.sandboxr-acme-tkt-1.loadbalancer.server.port=80");
  });

  // Anyone who can drive a public app can otherwise make it send real email and
  // spend real credit. Both ways out have to be in the message.
  it("refuses a public sandbox that would carry real credentials", async () => {
    const { dir, home } = await worktree();
    await mkdir(join(home, "secrets"), { recursive: true });
    await writeFile(join(home, "secrets", "acme.env"), "API_TOKEN=real\n");
    const { docker } = fakeDocker({ running: true });

    await expect(
      up({
        config: configOf({ access: { apps: "public" } }),
        worktree: dir,
        docker,
        env: { SANDBOXR_HOME: home },
      }),
    ).rejects.toThrow(/access\.credentials to real.*access\.apps to private/s);
  });

  // Whether the file *holds* anything, not whether it is there. Keying this on
  // existence made an empty file — which a save that changed nothing used to
  // create — enough to stop a public project starting, and the message named
  // "the real credentials" in a file that had none.
  it("is not stopped by a secrets file that holds nothing", async () => {
    const { dir, home } = await worktree();
    await mkdir(join(home, "secrets"), { recursive: true });
    await writeFile(join(home, "secrets", "acme.env"), "# a header and no values\n");
    const { docker } = fakeDocker({ running: true, exec: () => ({ stdout: '{"state":"ok","file":"","error":""}' }) });

    await expect(
      up({ config: configOf({ access: { apps: "public" } }), worktree: dir, docker, env: { SANDBOXR_HOME: home } }),
    ).resolves.toBeDefined();
  });

  /*
   * The report behind these two: a workspace holding `acme-monorepo`, whose
   * `sandboxr.yaml` says `project: acme`, and a config.yaml keyed on the only
   * name the operator had ever been shown — the directory. It matched nothing,
   * every project fell through to the machine-wide default, and the first
   * symptom was an agent unable to push, hours after the sandbox started.
   */
  async function managed(): Promise<{ home: string; worktree: string; config: ResolvedConfig }> {
    const root = await mkdtemp(join(tmpdir(), "sbx-managed-"));
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    const project = join(workspace, "acme-monorepo");
    await mkdir(join(project, "repo.git"), { recursive: true });
    const worktreeDir = join(project, "wt", "tkt-1");
    await mkdir(worktreeDir, { recursive: true });
    await mkdir(home, { recursive: true });
    return { home, worktree: worktreeDir, config: configOf({}, join(worktreeDir, "sandboxr.yaml")) };
  }

  it("keys config.yaml on the workspace directory, not only the declared project:", async () => {
    const { home, worktree: dir, config } = await managed();
    await writeFile(join(home, "config.yaml"), "projects:\n  acme-monorepo: { ttl: 3d }\n");
    const { docker, argsOf } = fakeDocker({ running: true, exec: () => ({ stdout: '{"state":"ok","file":"","error":""}' }) });

    await up({
      config,
      worktree: dir,
      docker,
      env: { SANDBOXR_HOME: home, SANDBOXR_WORKSPACE: join(dir, "..", "..", "..") },
    });

    const runArguments = (argsOf("ok")[0]?.[0] ?? []) as string[];
    // 3d in seconds. The old lookup tried `acme` alone and this label read 12h.
    expect(runArguments).toContain(`${LABELS.ttl}=${3 * 24 * 60 * 60}`);
  });

  // Two independent reasons `git push` fails inside a sandbox, and a message
  // naming one of them misleads: no token, and `git push`/`gh` being outside
  // DEFAULT_ALLOWED_TOOLS. Both are said here because `git commit` works either
  // way, so nothing else surfaces until an agent is hours in.
  it("says the sandbox carries no GitHub token, and names the key that would change it", async () => {
    const { home, worktree: dir, config } = await managed();
    const lines: string[] = [];
    const { docker } = fakeDocker({ running: true, exec: () => ({ stdout: '{"state":"ok","file":"","error":""}' }) });

    await up({
      config,
      worktree: dir,
      docker,
      log: (line) => lines.push(line),
      env: { SANDBOXR_HOME: home, SANDBOXR_WORKSPACE: join(dir, "..", "..", "..") },
    });

    const said = lines.join("\n");
    expect(said).toMatch(/has no GitHub token/);
    // The directory name, because it is the one somebody can see without
    // opening a file — writing the other one is the mistake this pre-empts.
    expect(said).toContain("projects.acme-monorepo.github: token");
    expect(said).toMatch(/git commit works in this sandbox/);
    expect(said).toMatch(/default allowlist/);
  });

  it("says nothing about the token when the project is opted in", async () => {
    const { home, worktree: dir, config } = await managed();
    await writeFile(join(home, "config.yaml"), "projects:\n  acme-monorepo: { github: token }\n");
    const lines: string[] = [];
    const { docker } = fakeDocker({ running: true, exec: () => ({ stdout: '{"state":"ok","file":"","error":""}' }) });

    await up({
      config,
      worktree: dir,
      docker,
      log: (line) => lines.push(line),
      // GH_TOKEN so the opted-in path answers from the environment instead of
      // shelling out to `gh`, which a test machine may not have logged in.
      env: { SANDBOXR_HOME: home, SANDBOXR_WORKSPACE: join(dir, "..", "..", ".."), GH_TOKEN: "t" },
    });

    expect(lines.join("\n")).not.toMatch(/has no GitHub token/);
  });

  it("lets a private sandbox carry them", async () => {
    const { dir, home } = await worktree();
    await mkdir(join(home, "secrets"), { recursive: true });
    await writeFile(join(home, "secrets", "acme.env"), "API_TOKEN=real\n");
    const { docker, argsOf } = fakeDocker({ running: true, exec: () => ({ stdout: '{"state":"ok","file":"","error":""}' }) });

    await up({ config: configOf(), worktree: dir, docker, env: { SANDBOXR_HOME: home } });
    const runArguments = (argsOf("ok")[0]?.[0] ?? []) as string[];
    expect(runArguments).toContain(`${join(home, "secrets", "acme.env")}:/sandboxr/secrets.env:ro`);
  });

  // The digest is what lets the dashboard say a sandbox started before a
  // credential was rotated, so it has to be a fact about the container rather
  // than something recomputed from a file that may have changed since.
  it("stamps the environment it started with on the container", async () => {
    const { dir, home } = await worktree();
    await mkdir(join(home, "secrets"), { recursive: true });
    await writeFile(join(home, "secrets", "acme.env"), "API_TOKEN=real\n");
    const { docker, argsOf } = fakeDocker({ running: true, exec: () => ({ stdout: '{"state":"ok","file":"","error":""}' }) });

    await up({ config: configOf(), worktree: dir, docker, env: { SANDBOXR_HOME: home } });
    const runArguments = (argsOf("ok")[0]?.[0] ?? []) as string[];
    const stamped = runArguments.find((argument) => argument.startsWith("sandboxr.env="));
    expect(stamped).toMatch(/^sandboxr\.env=[0-9a-f]{16}$/);
  });

  it("opts in when the config says the credentials may be real", async () => {
    const { dir, home } = await worktree();
    await mkdir(join(home, "secrets"), { recursive: true });
    await writeFile(join(home, "secrets", "acme.env"), "API_TOKEN=real\n");
    const { docker } = fakeDocker({ running: true, exec: () => ({ stdout: '{"state":"ok","file":"","error":""}' }) });
    await expect(
      up({
        config: configOf({ access: { apps: "public", credentials: "real" } }),
        worktree: dir,
        docker,
        env: { SANDBOXR_HOME: home },
      }),
    ).resolves.toBeTruthy();
  });

  // A failed migration must not stop the sandbox: inspecting one is a reason
  // the sandbox exists.
  it("leaves the sandbox up and degraded when the migration fails", async () => {
    const { dir, home } = await worktree();
    const lines: string[] = [];
    const { docker, argsOf } = fakeDocker({
      running: true,
      exec: (cmd) => {
        const joined = cmd.join(" ");
        // The project's own migration command is the thing that fails here.
        if (joined.includes("sh -lc migrate")) return { code: 1, stdout: "error: 001-add-a-column.sql failed" };
        if (joined.includes("migrate.json")) return { stdout: '{"state":"failed","file":"","error":""}' };
        return { stdout: "" };
      },
    });

    const result = await up({
      config: configOf(),
      worktree: dir,
      docker,
      env: { SANDBOXR_HOME: home },
      log: (line) => lines.push(line),
    });

    expect(result.sandbox.state).toBe("degraded");
    expect(result.migrationFailure).toBeTruthy();
    expect(lines.join("\n")).toMatch(/migrations FAILED/i);
    // The failure is written where the sandbox's own state is read from, so
    // `list` and the dashboard agree with what `up` just said.
    const marked = argsOf("exec").some((args) => {
      const joined = (args[1] as string[]).join(" ");
      return joined.includes("migrate.json") && joined.includes('"state":"failed"');
    });
    expect(marked).toBe(true);
  });

  it("replaces an existing container for the same slug", async () => {
    const { dir, home } = await worktree();
    const { docker, argsOf } = fakeDocker({ running: true, exists: true, exec: () => ({ stdout: '{"state":"ok","file":"","error":""}' }) });
    await up({ config: configOf(), worktree: dir, docker, env: { SANDBOXR_HOME: home } });
    expect(argsOf("rm")[0]?.[0]).toBe("sandboxr-acme-tkt-1");
  });

  it("refuses to replace one when told not to", async () => {
    const { dir, home } = await worktree();
    const { docker } = fakeDocker({ running: true, exists: true });
    await expect(
      up({ config: configOf(), worktree: dir, docker, env: { SANDBOXR_HOME: home }, replace: false }),
    ).rejects.toThrow(/already exists/);
  });
});

describe("reload", () => {
  const running = () =>
    fakeDocker({
      rows: [row(labelsOf("tkt-1"), "sandboxr-acme-tkt-1")],
      running: true,
      exec: (cmd) =>
        cmd.join(" ").includes("migrate.json") ? { stdout: '{"state":"ok","file":"","error":""}' } : { stdout: "" },
    });

  it("builds one backend and restarts it", async () => {
    const { docker, argsOf } = running();
    const result = await reload("acme", "tkt-1", { kind: "backend", target: "api", docker, config: configOf() });
    expect(result.built).toEqual(["api"]);
    const commands = argsOf("exec").map((args) => (args[1] as string[]).join(" "));
    expect(commands.some((command) => command.includes("build -o /var/lib/sandboxr/bin/api ./api"))).toBe(true);
    expect(commands.some((command) => command.includes("sandboxr-restart api"))).toBe(true);
  });

  // A broken branch must not also take the sandbox's services down.
  it("leaves the running process alone when a build fails", async () => {
    const { docker, argsOf } = fakeDocker({
      rows: [row(labelsOf("tkt-1"), "sandboxr-acme-tkt-1")],
      running: true,
      exec: (cmd) => (cmd.join(" ").includes("build -o") ? { code: 1, stderr: "syntax error" } : { stdout: "" }),
    });
    const result = await reload("acme", "tkt-1", { kind: "backend", target: "api", docker, config: configOf() });
    expect(result.failed).toEqual(["api"]);
    const commands = argsOf("exec").map((args) => (args[1] as string[]).join(" "));
    expect(commands.some((command) => command.includes("sandboxr-restart"))).toBe(false);
  });

  it("builds the build-everything set for `all`, which excludes the opted-out app", async () => {
    const { docker } = running();
    const result = await reload("acme", "tkt-1", { kind: "frontend", target: "all", docker, config: configOf() });
    expect(result.built).toEqual(["app", "cms"]);
  });

  it("builds one named front-end", async () => {
    const { docker } = running();
    const result = await reload("acme", "tkt-1", { kind: "frontend", target: "www", docker, config: configOf() });
    expect(result.built).toEqual(["www"]);
  });

  // `built` refreshes what this sandbox actually serves, and never starts a
  // first build of an expensive app by accident.
  it("refreshes what the sandbox has already built", async () => {
    const { docker } = fakeDocker({
      rows: [row(labelsOf("tkt-1"), "sandboxr-acme-tkt-1")],
      running: true,
      exec: (cmd) => (cmd.join(" ").includes(".built.json") ? { stdout: '{"www":1}' } : { stdout: "" }),
    });
    const result = await reload("acme", "tkt-1", { kind: "frontend", target: "built", docker, config: configOf() });
    expect(result.built).toEqual(["www"]);
  });

  it("falls back to the build-everything set when nothing is built yet", async () => {
    const { docker } = running();
    const result = await reload("acme", "tkt-1", { kind: "frontend", target: "built", docker, config: configOf() });
    expect(result.built).toEqual(["app", "cms"]);
  });

  it("restarts a served front-end rather than building it", async () => {
    const { docker, argsOf } = running();
    await reload("acme", "tkt-1", { kind: "frontend", target: "cms", docker, config: configOf() });
    const commands = argsOf("exec").map((args) => (args[1] as string[]).join(" "));
    expect(commands.some((command) => command.includes("sandboxr-restart cms"))).toBe(true);
  });

  it("refuses a target that names nothing", async () => {
    const { docker } = running();
    await expect(
      reload("acme", "tkt-1", { kind: "frontend", target: "ghost", docker, config: configOf() }),
    ).rejects.toThrow(/nothing to build/);
  });

  it("refuses to reload a sandbox that is not running", async () => {
    const { docker } = fakeDocker({ rows: [], running: false });
    await expect(reload("acme", "tkt-1", { kind: "backend", docker, config: configOf() })).rejects.toThrow(
      /not running/,
    );
  });
});

describe("status", () => {
  it("reports the services, the migration state and the built apps", async () => {
    const { docker } = fakeDocker({
      rows: [row(labelsOf("tkt-1"), "sandboxr-acme-tkt-1")],
      running: true,
      exec: (cmd) => {
        const joined = cmd.join(" ");
        if (joined.includes("migrate.json")) return { stdout: '{"state":"ok","file":"","error":""}' };
        if (joined.includes(".built.json")) return { stdout: '{"app":1}' };
        if (joined.includes("curl")) return { code: 0 };
        return { stdout: "" };
      },
    });
    // `SANDBOXR_HOME` and not just the domain, and it is load-bearing: the URL a
    // status reports is https or http depending on whether the router found a
    // certificate, which `routerScheme` decides by looking for one under the
    // home. Without a home of its own this read the developer's real
    // `~/.sandboxr` — so the test passed on a machine with no mkcert and failed
    // on one with it, which is a test asserting a fact about the laptop it ran
    // on rather than about the code.
    const home = await mkdtemp(join(tmpdir(), "sbx-status-"));
    const result = await status("acme", "tkt-1", {
      docker,
      config: configOf(),
      env: { SANDBOXR_DOMAIN: "sbx.localhost", SANDBOXR_HOME: home },
    });
    expect(result.migrations).toBe("ok");
    expect(result.built).toEqual(["app"]);
    expect(result.services[0]).toMatchObject({ name: "api", up: true, url: "http://tkt-1--api--acme.sbx.localhost" });
    expect(result.worktreeMissing).toBe(true);
  });

  it("refuses a sandbox that does not exist", async () => {
    const { docker } = fakeDocker();
    await expect(status("acme", "ghost", { docker })).rejects.toThrow(/no sandbox called ghost/);
  });
});

describe("gc", () => {
  it("reaps a sandbox whose worktree is gone", async () => {
    const { docker, argsOf } = fakeDocker({
      rows: [row(labelsOf("tkt-1"), "sandboxr-acme-tkt-1")],
      exec: () => ({ stdout: '{"state":"ok","file":"","error":""}' }),
      volumes: ["sandboxr-data-acme-tkt-1"],
      exists: true,
    });
    const plan = await gc({ docker });
    expect(plan.reap).toHaveLength(1);
    expect(argsOf("rm")[0]?.[0]).toBe("sandboxr-acme-tkt-1");
  });

  it("removes nothing under dryRun", async () => {
    const { docker, argsOf } = fakeDocker({
      rows: [row(labelsOf("tkt-1"), "sandboxr-acme-tkt-1")],
      exec: () => ({ stdout: '{"state":"ok","file":"","error":""}' }),
      volumes: ["sandboxr-data-acme-tkt-1"],
    });
    const plan = await gc({ docker, dryRun: true });
    expect(plan.reap).toHaveLength(1);
    expect(argsOf("rm")).toHaveLength(0);
    expect(argsOf("volumeRm")).toHaveLength(0);
    expect(argsOf("imageRm")).toHaveLength(0);
  });

  const images = [
    {
      repository: "sandboxr/acme",
      tag: "old",
      id: "1",
      created: new Date("2026-08-01T00:00:00.000Z"),
      size: 6e9,
      uniqueSize: 5.34e9,
      containers: 0,
    },
    {
      repository: "sandboxr/acme",
      tag: "new",
      id: "2",
      created: new Date("2026-08-27T00:00:00.000Z"),
      size: 6e9,
      uniqueSize: 5.34e9,
      containers: 1,
    },
  ];

  // The accumulation that filled a machine: a content-addressed tag means every
  // base rebuild strands the previous image, and nothing that ran routinely gave
  // it back. `gc` is the routine one, so it is where this belongs.
  it("removes a project image a newer build replaced, and keeps the newest", async () => {
    const { docker, argsOf } = fakeDocker({ usage: { images, volumes: [], buildCache: [] } });
    const plan = await gc({ docker });
    expect(plan.images.map((image) => image.reference)).toEqual(["sandboxr/acme:old"]);
    expect(argsOf("imageRm")).toEqual([["sandboxr/acme:old"]]);
  });

  // `docker system df` is a walk of the storage driver and can fail where
  // `docker ps` succeeds. Turning that into "gc did not run" would lose the
  // container and volume reaping, which has nothing to do with images.
  it("still reaps containers and volumes when the disk report is unavailable", async () => {
    const { docker, argsOf } = fakeDocker({
      rows: [row(labelsOf("tkt-1"), "sandboxr-acme-tkt-1")],
      exec: () => ({ stdout: '{"state":"ok","file":"","error":""}' }),
      volumes: ["sandboxr-data-acme-tkt-1"],
      exists: true,
      usageFails: true,
    });
    const plan = await gc({ docker });
    expect(plan.reap).toHaveLength(1);
    expect(argsOf("rm")[0]?.[0]).toBe("sandboxr-acme-tkt-1");
    // Not "there are no superseded images" — no listing, so nothing is concluded.
    expect(plan.images).toEqual([]);
    expect(argsOf("imageRm")).toHaveLength(0);
  });
});

describe("prune", () => {
  const usage = {
    images: [
      {
        repository: "sandboxr/acme",
        tag: "old",
        id: "1",
        created: new Date("2026-08-01T00:00:00.000Z"),
        size: 6e9,
        uniqueSize: 5.34e9,
        containers: 0,
      },
      {
        repository: "sandboxr/acme",
        tag: "new",
        id: "2",
        created: new Date("2026-08-27T00:00:00.000Z"),
        size: 6e9,
        uniqueSize: 5.34e9,
        containers: 1,
      },
    ],
    volumes: [{ name: "sandboxr-data-acme-gone", size: 4.12e8, links: 0 }],
    buildCache: [{ id: "a", size: 1e9, inUse: false, shared: false }],
  };

  // The opposite default from gc and expire, and deliberately: what this
  // removes is an image, and an image nobody meant to lose is a toolchain
  // rebuild the next `up` pays for.
  it("reports without removing anything", async () => {
    const { docker, argsOf } = fakeDocker({ usage });
    const result = await prune({ docker });
    expect(result.applied).toBe(false);
    expect(result.images.map((image) => image.reference)).toEqual(["sandboxr/acme:old"]);
    expect(result.volumes.map((volume) => volume.name)).toEqual(["sandboxr-data-acme-gone"]);
    expect(argsOf("imageRm")).toHaveLength(0);
    expect(argsOf("volumeRm")).toHaveLength(0);
  });

  it("removes the superseded image and the orphaned volume when applied", async () => {
    const { docker, argsOf } = fakeDocker({ usage });
    const result = await prune({ docker, apply: true });
    expect(argsOf("imageRm")).toEqual([["sandboxr/acme:old"]]);
    expect(argsOf("volumeRm")).toEqual([["sandboxr-data-acme-gone"]]);
    expect(result.removed.images).toEqual(["sandboxr/acme:old"]);
    expect(result.removed.buildCacheBytes).toBe(0);
  });

  it("touches the build cache only when it is asked for", async () => {
    const { docker, argsOf } = fakeDocker({ usage });
    await prune({ docker, apply: true });
    expect(argsOf("builderPrune")).toHaveLength(0);

    const asked = fakeDocker({ usage });
    const result = await prune({ docker: asked.docker, apply: true, buildCache: true });
    expect(asked.argsOf("builderPrune")).toHaveLength(1);
    expect(result.removed.buildCacheBytes).toBe(1_000_000);
  });
});
