// Tests for the lifecycle against a fake docker daemon:
// - list: builds sandboxes from labels, filters by project, sorts, and ignores a container that is not ours
// - list: a stopped container is never asked for its markers
// - down: removes the container and every volume it owned; --keep leaves the volumes
// - down: a slug with no container is reported rather than treated as an error
// - up: writes the environment file, carries the labels, and starts the container
// - up: refuses a public sandbox that would carry real credentials, and names both ways out
// - up: a failed provision leaves the sandbox up and reports the failure
// - reload: a backend build failure leaves the running process alone; a success restarts it
// - reload: `all` covers the build-everything set, `built` covers what the sandbox has built, a name covers one app
// - reload: a served front-end is restarted rather than built
// - gc: reaps a sandbox whose worktree is gone, and does nothing under dryRun

import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveConfig } from "../config/load.js";
import type { ResolvedConfig } from "../config/types.js";
import type { ContainerRow, Docker, ExecResult } from "../docker.js";
import { LABELS, labelsFor } from "./labels.js";
import { down, gc, list, reload, status, up } from "./index.js";

interface FakeOptions {
  rows?: ContainerRow[];
  exec?: (cmd: string[]) => Partial<ExecResult>;
  volumes?: string[];
  running?: boolean;
  exists?: boolean;
  startedAt?: Date | undefined;
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

function configOf(extra: Record<string, unknown> = {}): ResolvedConfig {
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
    "/repo/sandboxr.yaml",
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
  it("removes the container and every volume it owned", async () => {
    const { docker, argsOf } = fakeDocker({ exists: true });
    await down("acme", "tkt-1", { docker });
    expect(argsOf("rm")[0]?.[0]).toBe("sandboxr-acme-tkt-1");
    expect(argsOf("volumeRm").map((args) => args[0])).toEqual([
      "sandboxr-data-acme-tkt-1",
      "sandboxr-blob-acme-tkt-1",
      "sandboxr-bin-acme-tkt-1",
      "sandboxr-www-acme-tkt-1",
    ]);
  });

  it("keeps the volumes when asked", async () => {
    const { docker, argsOf } = fakeDocker({ exists: true });
    await down("acme", "tkt-1", { docker, keep: true });
    expect(argsOf("volumeRm")).toHaveLength(0);
  });

  it("says so rather than failing when there is no such sandbox", async () => {
    const { docker, argsOf } = fakeDocker({ exists: false });
    const lines: string[] = [];
    await down("acme", "ghost", { docker, log: (line) => lines.push(line) });
    expect(lines.join(" ")).toMatch(/No sandbox called ghost/);
    expect(argsOf("rm")).toHaveLength(0);
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
    expect(result.urls.app).toBe("http://tkt-1.app.acme.sbx.localhost");
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

    expect(result.urls.app).toBe("https://tkt-1.app.acme.sbx.localhost");
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
      "traefik.http.routers.sandboxr-acme-tkt-1.rule=HostRegexp(`^tkt-1\\.[a-z0-9-]+\\.acme\\.sbx\\.localhost$`)",
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

  it("lets a private sandbox carry them", async () => {
    const { dir, home } = await worktree();
    await mkdir(join(home, "secrets"), { recursive: true });
    await writeFile(join(home, "secrets", "acme.env"), "API_TOKEN=real\n");
    const { docker, argsOf } = fakeDocker({ running: true, exec: () => ({ stdout: '{"state":"ok","file":"","error":""}' }) });

    await up({ config: configOf(), worktree: dir, docker, env: { SANDBOXR_HOME: home } });
    const runArguments = (argsOf("ok")[0]?.[0] ?? []) as string[];
    expect(runArguments).toContain(join(home, "secrets", "acme.env"));
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
    const result = await status("acme", "tkt-1", { docker, config: configOf(), env: { SANDBOXR_DOMAIN: "sbx.localhost" } });
    expect(result.migrations).toBe("ok");
    expect(result.built).toEqual(["app"]);
    expect(result.services[0]).toMatchObject({ name: "api", up: true, url: "http://tkt-1.api.acme.sbx.localhost" });
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
  });
});
