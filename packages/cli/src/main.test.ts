// Tests for command dispatch and the exit codes the shell sees:
// - usage on no command, on help, and on something that is not a command
// - the exit code each outcome produces, because that is what a script reads
// - --json puts the result on stdout and leaves stderr for the person
// - a bad --seed is refused by name before anything is started
// - a bad --ttl is refused by name, for the same reason
// - a config error exits 2, distinct from a command that merely failed
// - `config` in a managed worktree names the project-level file it fell back to, and the worktree root
// - `config` reports what ~/.sandboxr/config.yaml resolved to for this project, keyed on either of its names
// - `doctor` names a projects: entry in config.yaml that matches no project, and lists the names that would
// - project and worktree dispatch: subcommands, missing arguments, no project
// - `worktree name`, `worktree delete` and `worktree pull` dispatch like the rest, and every one of
//   them is offered in the usage line
// - project available: a machine with no gh says so in one sentence and still exits 0
// - the commands that name a sandbox say how they are used when given no slug
// - prune advertises `--yes` rather than `--dry-run`, because its default is the opposite of gc's
// - secrets: every subcommand, driven against a real SANDBOXR_HOME, and in particular
//   that none of them ever prints a value — the property the whole group exists for
// - secrets set reads the value from stdin rather than argv, and strips one newline
// - secrets unset says so rather than claiming a removal, and writes no file
// - secrets edit applies the editor's save, names what it refused, and leaves no draft
//
// The commands that talk to Docker are not driven here: `docker` is a module
// singleton rather than an injected dependency, so nothing below reaches it.
// `doctor` is the one exception, and only for its reading of `config.yaml`
// against the workspace — every other finding it makes depends on whether this
// machine happens to have Docker running, so nothing below asserts on one.

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { main, USAGE, type Stdin } from "./main.js";
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
async function run(argv: string[], cwd: string, env?: NodeJS.ProcessEnv, stdin?: Stdin) {
  const writer = recorder();
  const code = await main(argv, {
    writer,
    cwd,
    env: env ?? { SANDBOXR_HOME: join(cwd, "home") },
    // Closed by default, so a command that reads stdin can never sit waiting for
    // one that the test run has no way to answer.
    stdin: stdin ?? Readable.from([]),
  });
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

/*
 * The report behind these: a workspace holding `acme-monorepo`, whose config
 * declares `project: acme`, and a `config.yaml` keyed on the directory — the
 * only name the dashboard and the URLs had ever shown the operator. It matched
 * nothing, both projects silently fell through to `github: none`, and the first
 * symptom was an agent unable to push.
 */
async function managedWorkspace(entry: string): Promise<{ home: string; worktree: string }> {
  const home = await mkdtemp(join(tmpdir(), "sbx-keyed-"));
  const projectDir = join(home, "workspace", "acme-monorepo");
  const worktree = join(projectDir, "wt", "main");
  await mkdir(join(projectDir, "repo.git"), { recursive: true });
  await mkdir(worktree, { recursive: true });
  await writeFile(join(worktree, "sandboxr.yaml"), CONFIG);
  await writeFile(join(home, "config.yaml"), entry);
  return { home, worktree };
}

describe("config, the machine's settings for this project", () => {
  it("takes an entry keyed on the workspace directory, not only the declared project:", async () => {
    const { home, worktree } = await managedWorkspace("projects:\n  acme-monorepo: { ttl: 3d, github: token }\n");

    const result = await run(["config"], worktree, { SANDBOXR_HOME: home });
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("ttl         3d");
    expect(result.stderr).toContain("github      token (projects.acme-monorepo)");
    // Both names, because either is a valid key and only one of them is visible
    // anywhere but the repository.
    expect(result.stderr).toContain("acme-monorepo (the workspace directory) or acme");
  });

  // The absence made visible somewhere other than a failed push hours later.
  it("says the token is off and names the key that would turn it on", async () => {
    const { home, worktree } = await managedWorkspace("github: none\n");

    const result = await run(["config"], worktree, { SANDBOXR_HOME: home });
    expect(result.stderr).toContain("github      none");
    expect(result.stderr).toContain("projects.acme-monorepo.github: token");
    // Two independent reasons a push fails; naming one of them misleads.
    expect(result.stderr).toContain("git commit works");
    expect(result.stderr).toContain("may use gh and git push");
  });
});

describe("doctor", () => {
  // Where a `projects:` entry naming nothing surfaces, and why here: refusing
  // the file at load time would stop every other project on the machine over one
  // stale line, and `loadMachineConfig` cannot see the workspace to check.
  it("names an entry that matches no project, and the names that would", async () => {
    const { home, worktree } = await managedWorkspace("projects:\n  demo: { github: token }\n");

    const result = await run(["doctor"], worktree, { SANDBOXR_HOME: home });
    expect(result.stderr).toContain('config.yaml has settings for "demo"');
    expect(result.stderr).toContain("acme-monorepo");
  }, 60_000);

  it("says so when every entry matches", async () => {
    const { home, worktree } = await managedWorkspace("projects:\n  acme: { ttl: 3d }\n");

    const result = await run(["doctor"], worktree, { SANDBOXR_HOME: home });
    expect(result.stderr).toContain("every projects: entry in config.yaml names a project here");
  }, 60_000);
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

  it.each([["ls"], ["add"], ["rm"], ["delete"], ["name"], ["pull"]])(
    "%s says the project is not in the workspace",
    async (sub) => {
      const result = await run(["worktree", sub, "nowhere", "feat/thing"], empty);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("no project called nowhere");
    },
  );

  it("offers delete, name and pull alongside the other three", async () => {
    const result = await run(["worktree", "sideways"], empty);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("ls|add|rm|delete|name|pull");
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

// The whole secrets group, driven against a real SANDBOXR_HOME with nothing
// mocked: these write and read the file the command itself uses. The property
// asserted over and over is the negative one — the value does not appear in the
// output — because that is the reason the group is shaped the way it is.
describe("secrets", () => {
  const SECRETS_CONFIG = `project: acme
sandboxr: ">=0.1.0"
access:
  apps: private
secrets:
  read: [.env]
  keep: [ORQ_API_KEY, STRIPE_SECRET_KEY, SENTRY_DSN]
  never: ["DB_*"]
`;

  // Writes the file it was given aside, then replaces it: one script covers a
  // name added, a name dropped, and a name the project refuses.
  const EDITOR_SCRIPT = `import { readFileSync, writeFileSync } from "node:fs";
const file = process.argv[2];
writeFileSync(process.env.SEEN, readFileSync(file));
writeFileSync(file, "SENTRY_DSN=https://abc@example.test/42\\nDB_HOST=prod.internal\\n");
`;

  let root: string;
  let home: string;
  let env: NodeJS.ProcessEnv;

  const secretsFile = () => join(home, "secrets", "acme.env");

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "sbx-secrets-"));
    home = join(root, "home");
    await writeFile(join(root, "sandboxr.yaml"), SECRETS_CONFIG);
    env = { SANDBOXR_HOME: home };
  });

  /** An editor of our own, so `edit` can be driven without a terminal. */
  async function editorEnv(script = EDITOR_SCRIPT): Promise<NodeJS.ProcessEnv> {
    const file = join(root, "editor.mjs");
    await writeFile(file, script);
    // Two words, which also covers `EDITOR="code -w"`: the command is split on
    // whitespace rather than handed to a shell. PATH comes along because the
    // editor is run with the environment the command was given, which is the
    // only reason a test can name an editor at all.
    return { ...env, PATH: process.env.PATH ?? "", EDITOR: `node ${file}`, SEEN: join(root, "seen.env") };
  }

  it("lists what the project declares and has not got, and succeeds", async () => {
    const result = await run(["secrets", "list"], root, env);
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("no secrets file yet");
    expect(result.stderr).toContain(`ORQ_API_KEY is declared in sandboxr.yaml`);
  });

  it("says how the group is used when given no subcommand it knows", async () => {
    const result = await run(["secrets", "frobnicate"], root, env);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("usage: sandboxr secrets list|set|unset|edit|import|check");
  });

  describe("set", () => {
    const VALUE = "sk-live-abcdefghij0123456789";

    it("reads the value from stdin, strips one newline, and prints none of it", async () => {
      const set = await run(["secrets", "set", "ORQ_API_KEY"], root, env, Readable.from([`${VALUE}\n`]));
      expect(set.code).toBe(0);
      expect(set.stderr).not.toContain(VALUE);
      expect(set.stderr).toContain("set ORQ_API_KEY");

      // The length is the assertion that exactly one newline came off: a value
      // one character longer would mean the newline was kept.
      const listed = await run(["secrets", "list", "--json"], root, env);
      expect(JSON.parse(listed.stdout).vars).toEqual([{ name: "ORQ_API_KEY", hint: "6789", chars: VALUE.length }]);
      expect(listed.stderr).not.toContain(VALUE);
      expect(listed.stdout).not.toContain(VALUE);
    });

    // The reason `set` takes no value argument at all: an argument is in the
    // shell history and in every `ps` on the machine while the command runs. So
    // a stray word must not be treated as the value even by accident.
    it("ignores a value given as an argument", async () => {
      const result = await run(["secrets", "set", "ORQ_API_KEY", VALUE], root, env);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("no value given");
      expect(existsSync(secretsFile())).toBe(false);
    });

    it("refuses a reserved name without reading anything", async () => {
      const stdin = Readable.from(["never-read\n"]);
      const result = await run(["secrets", "set", "SANDBOXR_DB_HOST"], root, env, stdin);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("works out for itself");
      expect(stdin.readableEnded).toBe(false);
    });

    it("refuses a name the project's never patterns cover, by pattern", async () => {
      const result = await run(["secrets", "set", "DB_PASSWORD"], root, env, Readable.from(["pw\n"]));
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('never pattern "DB_*"');
    });

    // Only the newline a pipe added comes off, so a second line is a refusal
    // rather than a value silently cut in half.
    it("refuses a value with a newline inside it", async () => {
      const result = await run(["secrets", "set", "ORQ_API_KEY"], root, env, Readable.from(["one\ntwo\n"]));
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("newline");
      expect(existsSync(secretsFile())).toBe(false);
    });

    it("names the argument it wants when given no name", async () => {
      const result = await run(["secrets", "set"], root, env);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("usage: sandboxr secrets set NAME");
    });

    // Core reports this rather than refusing it, and it is the shape of bug that
    // costs an afternoon: the variable has a value, and it is the wrong one.
    it("warns when the project's env map already claims the name", async () => {
      await writeFile(join(root, "sandboxr.yaml"), `${SECRETS_CONFIG}env:\n  SENTRY_DSN: https://in-the-map/0\n`);
      const result = await run(["secrets", "set", "SENTRY_DSN"], root, env, Readable.from(["https://typed/1\n"]));
      expect(result.code).toBe(0);
      expect(result.stderr).toContain("SENTRY_DSN is also in this project's env: map");
    });
  });

  describe("unset", () => {
    it("removes a name that is set", async () => {
      await run(["secrets", "set", "ORQ_API_KEY"], root, env, Readable.from(["value-here\n"]));
      const result = await run(["secrets", "unset", "ORQ_API_KEY"], root, env);
      expect(result.code).toBe(0);
      expect(result.stderr).toContain("removed ORQ_API_KEY");
      expect(JSON.parse((await run(["secrets", "list", "--json"], root, env)).stdout).vars).toEqual([]);
    });

    // Saying "removed" would be a lie, and writing the file would turn "no
    // secrets file yet" into "a file with nothing in it", which reads differently
    // everywhere else.
    it("says there was nothing to remove, and writes no file", async () => {
      const result = await run(["secrets", "unset", "ORQ_API_KEY"], root, env);
      expect(result.code).toBe(0);
      expect(result.stderr).toContain("nothing to remove");
      expect(result.stderr).not.toContain("removed ORQ_API_KEY");
      expect(existsSync(secretsFile())).toBe(false);
    });
  });

  describe("edit", () => {
    it("applies the save, names what it refused, and leaves no draft behind", async () => {
      await run(["secrets", "set", "ORQ_API_KEY"], root, env, Readable.from(["dropped-by-the-editor\n"]));
      const result = await run(["secrets", "edit"], root, await editorEnv());

      expect(result.stderr).toContain("set SENTRY_DSN");
      expect(result.stderr).toContain("removed ORQ_API_KEY");
      expect(result.stderr).toContain('DB_HOST matches this project\'s never pattern "DB_*"');
      // A refusal is the whole reason for the exit code: the save was partly
      // applied, and a script must not read that as a clean edit.
      expect(result.code).toBe(1);
      // Only the file, never the copy the editor was given.
      expect(await readdir(join(home, "secrets"))).toEqual(["acme.env"]);
    });

    it("offers the declared names to an editor opening on nothing", async () => {
      await run(["secrets", "edit"], root, await editorEnv());
      const seen = await readFile(join(root, "seen.env"), "utf8");
      expect(seen).toContain("ORQ_API_KEY=");
      expect(seen).toContain("STRIPE_SECRET_KEY=");
      expect(seen).toContain("sandboxr.yaml says this project needs");
    });

    it("says nothing changed when the editor saved nothing", async () => {
      const result = await run(["secrets", "edit"], root, await editorEnv("process.exit(0);\n"));
      expect(result.code).toBe(0);
      expect(result.stderr).toContain("no changes to");
    });

    // An editor that exits non-zero is how `git commit` is abandoned, so it has
    // to mean the same here: the file is not touched.
    it("changes nothing when the editor fails", async () => {
      const result = await run(["secrets", "edit"], root, await editorEnv("process.exit(3);\n"));
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("exited 3, so nothing was changed");
      expect(existsSync(secretsFile())).toBe(false);
    });

    it("names the editor rather than reporting a failed spawn", async () => {
      const result = await run(["secrets", "edit"], root, { ...env, EDITOR: "no-such-editor-here" });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("could not start no-such-editor-here");
    });
  });

  describe("import", () => {
    beforeEach(async () => {
      await writeFile(join(root, ".env"), "STRIPE_SECRET_KEY=from-the-env-file\nDB_HOST=localhost\n");
    });

    it("merges into what is already there", async () => {
      await run(["secrets", "set", "ORQ_API_KEY"], root, env, Readable.from(["set-by-hand\n"]));
      const result = await run(["secrets", "import"], root, env);
      expect(result.code).toBe(0);
      expect(result.stderr).toContain("merged 1 credential(s)");
      expect(JSON.parse((await run(["secrets", "list", "--json"], root, env)).stdout).vars).toHaveLength(2);
    });

    // The old whole-file behaviour, and the reason it now has to be asked for:
    // it discards everything that came from anywhere but these files.
    it("--replace discards what was set by hand", async () => {
      await run(["secrets", "set", "ORQ_API_KEY"], root, env, Readable.from(["set-by-hand\n"]));
      const result = await run(["secrets", "import", "--replace"], root, env);
      expect(result.code).toBe(0);
      expect(result.stderr).toContain("wrote 1 credential(s)");
      const view = JSON.parse((await run(["secrets", "list", "--json"], root, env)).stdout);
      expect(view.vars.map((entry: { name: string }) => entry.name)).toEqual(["STRIPE_SECRET_KEY"]);
    });

    it("says in the usage what --replace discards", () => {
      expect(USAGE).toContain("--replace");
      expect(USAGE).toContain("anything set by hand or by an earlier import");
    });
  });
});
