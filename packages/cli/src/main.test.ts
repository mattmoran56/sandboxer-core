// Tests for command dispatch and the exit codes the shell sees:
// - usage on no command, on help, and on something that is not a command
// - the exit code each outcome produces, because that is what a script reads
// - --json puts the result on stdout and leaves stderr for the person
// - a bad --seed is refused by name before anything is started
// - a bad --ttl is refused by name, for the same reason
// - a config error exits 2, distinct from a command that merely failed
// - `config` in a managed worktree names the project-level file it fell back to, and the worktree root
// - project and worktree dispatch: subcommands, missing arguments, no project
// - project available: a machine with no gh says so in one sentence and still exits 0
// - the commands that name a sandbox say how they are used when given no slug
// - prune advertises `--yes` rather than `--dry-run`, because its default is the opposite of gc's
//
// The commands that talk to Docker are not driven here: `docker` is a module
// singleton rather than an injected dependency, so nothing below reaches it.

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { main, USAGE } from "./main.js";
import type { Writer } from "./output.js";

function recorder(): Writer & { stdout: string; stderr: string } {
  const sink = {
    stdout: "",
    stderr: "",
    isTTY: false,
    out: (text: string) => {
      sink.stdout += text;
    },
    err: (text: string) => {
      sink.stderr += text;
    },
  };
  return sink;
}

/** Runs the CLI against a directory, with nothing written to the real streams. */
async function run(argv: string[], cwd: string, env?: NodeJS.ProcessEnv) {
  const writer = recorder();
  const code = await main(argv, { writer, cwd, env: env ?? { SANDBOXR_HOME: join(cwd, "home") } });
  return { code, stdout: writer.stdout, stderr: writer.stderr };
}

const CONFIG = `project: acme
sandboxr: ">=0.1.0"
access:
  apps: private
frontends:
  apps:
    - { label: app, package: ".", build: npx vite build, out: dist }
`;

let project: string;
let empty: string;

beforeAll(async () => {
  project = await mkdtemp(join(tmpdir(), "sbx-cli-"));
  await writeFile(join(project, "sandboxr.yaml"), CONFIG);
  // A directory with no config anywhere above it would be impossible under a
  // repo that has one, so the empty case gets its own temporary root.
  empty = await mkdtemp(join(tmpdir(), "sbx-none-"));
});

describe("usage", () => {
  it("prints usage and fails when given no command at all", async () => {
    const result = await run([], empty);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("one container per git worktree");
  });

  it.each([["help"], ["--help"], ["-h"]])("%s prints usage and succeeds", async (flag) => {
    const result = await run([flag], empty);
    expect(result.code).toBe(0);
    expect(result.stderr).toContain(USAGE.split("\n")[0] ?? "");
  });

  it("names an unknown command rather than only printing usage", async () => {
    const result = await run(["frobnicate"], empty);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("unknown command: frobnicate");
  });

  // Usage is something a person reads, so it must not land in a pipe that is
  // meant to carry JSON.
  it("keeps usage off stdout", async () => {
    expect((await run(["help"], empty)).stdout).toBe("");
  });
});

describe("version", () => {
  it("puts the version on stdout as JSON", async () => {
    const result = await run(["version"], empty);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ version: expect.any(String) });
  });
});

describe("config", () => {
  it("exits 2 when there is no config to read", async () => {
    const result = await run(["config"], empty);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("no sandboxr.yaml");
  });

  it("describes what the config resolved to", async () => {
    const result = await run(["config"], project);
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("acme");
    expect(result.stderr).toContain("app (static)");
  });

  it("puts the whole resolved config on stdout with --json", async () => {
    const result = await run(["config", "--json"], project);
    const parsed = JSON.parse(result.stdout) as { project: string; frontends: unknown[] };
    expect(parsed.project).toBe("acme");
    expect(parsed.frontends).toHaveLength(1);
  });

  // A config that does not parse is a different kind of failure from a command
  // that ran and did not work, and a script should be able to tell them apart.
  it("exits 2 for a config that does not satisfy the schema", async () => {
    const broken = await mkdtemp(join(tmpdir(), "sbx-bad-"));
    await writeFile(join(broken, "sandboxr.yaml"), "project: Acme\nsandboxr: \">=0.1.0\"\n");
    const result = await run(["config"], broken);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("project");
  });

  // The one case a person cannot work out for themselves: the config governing
  // this worktree is not in it, and nothing in the worktree says so.
  it("says when a managed worktree is running on its project-level config", async () => {
    const home = await mkdtemp(join(tmpdir(), "sbx-managed-"));
    const projectDir = join(home, "workspace", "acme");
    const worktree = join(projectDir, "wt", "main");
    await mkdir(join(projectDir, "repo.git"), { recursive: true });
    await mkdir(worktree, { recursive: true });
    await writeFile(join(projectDir, "sandboxr.yaml"), CONFIG);

    const result = await run(["config"], worktree, { SANDBOXR_HOME: home });
    expect(result.code).toBe(0);
    expect(result.stderr).toContain(join(projectDir, "sandboxr.yaml"));
    expect(result.stderr).toContain("the workspace project directory");
    // The root is the worktree, never the project directory it read the file from.
    expect(result.stderr).toContain(`root        ${worktree}`);
  });
});

describe("up", () => {
  it("refuses a --seed that is not a source, naming the ones that are", async () => {
    const result = await run(["up", "--seed", "wherever"], project);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("--seed wherever is not a source");
    expect(result.stderr).toContain("local, file, fixtures");
  });

  // core refuses it too, but only after the worktree is cut and the seed taken.
  // The refusal has to happen here so a typo costs nothing.
  it.each([["soon"], ["0h"], ["8 hours"]])("refuses --ttl %s as a duration", async (ttl) => {
    const result = await run(["up", "--ttl", ttl], project);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`--ttl ${ttl} is not a duration`);
  });
});

// `pin` and `unpin` are what these were called before the concept became
// keep-alive. They stay as undocumented aliases because they are in people's
// shell history, so the check is that they still route somewhere rather than
// falling through to "not a command".
describe("the old pin aliases", () => {
  it.each([["pin"], ["unpin"]])("%s still reaches the keep-alive command", async (command) => {
    const result = await run([command], empty);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("<slug> [--project NAME]");
    expect(result.stderr).not.toContain("is not a command");
  });

  it("does not advertise them in the usage", () => {
    expect(USAGE).toContain("keep <slug>");
    expect(USAGE).not.toContain("pin <slug>");
  });
});

describe("prune", () => {
  // The flag exists because the default is a report. `gc` reads the other way
  // round, and the usage has to say which is which or the reader will assume
  // the pair behave alike and delete an image they wanted.
  it("advertises that removing takes --yes, unlike gc's --dry-run", () => {
    expect(USAGE).toContain("prune [--yes]");
    expect(USAGE).toContain("gc [--dry-run]");
  });

  it("is a command rather than a typo", async () => {
    const result = await run(["prune", "--help"], empty);
    expect(result.stderr).not.toContain("unknown command");
  });
});

describe("projects", () => {
  it("says how it is used when given no subcommand", async () => {
    const result = await run(["project"], empty);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("usage: sandboxr project ls|available|clone|fetch|prs");
  });

  // An empty workspace is the state of a machine that has never cloned
  // anything, not a failure of any kind.
  it("reports an empty workspace as empty, and succeeds", async () => {
    const result = await run(["project", "ls"], empty);
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("sandboxr project clone");
  });

  it("puts an empty workspace on stdout as an empty list", async () => {
    const result = await run(["project", "ls", "--json"], empty);
    expect(JSON.parse(result.stdout)).toEqual([]);
  });

  // A machine without gh is an ordinary machine, not a broken one: the list is
  // empty, one sentence says why, and `project clone <url>` still works.
  //
  // Simulated by emptying PATH rather than by mocking core, because there is no
  // runner seam through `main` — core spawns gh with the process's own
  // environment — and this is the real code path a machine without gh takes.
  describe("available, on a machine with no gh", () => {
    beforeEach(() => {
      vi.stubEnv("PATH", join(empty, "no-bin"));
    });
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it("says why the list is empty, and succeeds", async () => {
      const result = await run(["project", "available"], empty);
      expect(result.code).toBe(0);
      expect(result.stderr).toContain("gh is not installed here, or is not logged in");
    });

    it("puts an empty list on stdout, so --json is still parseable", async () => {
      const result = await run(["project", "available", "--json"], empty);
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual([]);
    });
  });

  it("names the missing url rather than cloning nothing", async () => {
    const result = await run(["project", "clone"], empty);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("usage: sandboxr project clone <url>");
  });

  it.each([["fetch"], ["prs"]])("%s wants a project name", async (sub) => {
    const result = await run(["project", sub], empty);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`usage: sandboxr project ${sub} <name>`);
  });

  it.each([["fetch"], ["prs"]])("%s says the project is not in the workspace", async (sub) => {
    const result = await run(["project", sub, "nowhere"], empty);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("no project called nowhere");
  });
});

describe("worktrees", () => {
  it("says how it is used when given no subcommand", async () => {
    const result = await run(["worktree"], empty);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("usage: sandboxr worktree ls|add|rm");
  });

  it("wants a project to list the worktrees of", async () => {
    const result = await run(["worktree", "ls"], empty);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("usage: sandboxr worktree ls <project>");
  });

  it("asks for the branch as well as the project", async () => {
    const result = await run(["worktree", "add"], empty);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("<project> <branch>");
  });

  it.each([["ls"], ["add"], ["rm"]])("%s says the project is not in the workspace", async (sub) => {
    const result = await run(["worktree", sub, "nowhere", "feat/thing"], empty);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("no project called nowhere");
  });
});

// These four resolve the project from `docker ps` before they do anything, so
// only the argument they refuse before that can be driven here.
describe("naming a sandbox", () => {
  it.each([["stop"], ["start"], ["keep"], ["unkeep"]])("%s with no slug says how it is used", async (command) => {
    const result = await run([command], empty);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`usage: sandboxr ${command} <slug> [--project NAME]`);
  });
});

describe("subcommands", () => {
  it.each([
    ["db", "usage: sandboxr db"],
    ["secrets", "usage: sandboxr secrets"],
  ])("%s with no subcommand says how it is used", async (command, expected) => {
    const result = await run([command], project);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(expected);
  });

  it("secrets check reports a project with no secrets file yet", async () => {
    const result = await run(["secrets", "check"], project);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("sandboxr secrets import");
  });

  it("reload says what it could have been asked to rebuild", async () => {
    const result = await run(["reload"], project);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("--go");
    expect(result.stderr).toContain("--web");
    expect(result.stderr).toContain("--migrate");
  });
});
