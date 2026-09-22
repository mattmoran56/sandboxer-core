// Tests that a sandbox keeps the diagnosis of a command that failed. The unit is
// `run_quiet` in `container/scripts/lib.sh`, which is what `mysql-init.sh` calls
// in place of the `>/dev/null 2>&1` it used to end with:
// - a command that succeeds prints nothing, so a clean boot stays readable —
//   that is the whole reason the redirect was there and it has to survive
// - a command that fails prints what it wrote, stderr and stdout both, and says
//   which command and what it exited with
// - the failing command's own exit status is what `run_quiet` returns, so a
//   caller under `set -e` still stops where it did before
// - a failure that printed nothing at all is still reported, rather than passing
//   silently because there was nothing to echo
//
// Driven as real bash under `set -euo pipefail`, the way
// `secrets-container.test.ts` drives the real `env.sh`: the behaviour under test
// *is* the shell's, and a reimplementation in TypeScript would only assert that
// this file and a fake agree with each other.
//
// Why it is worth a test file of its own: the redirect this replaces cost three
// days. A host's Docker disk filled, mysqld wrote "no space left on device" to
// stderr, the redirect sent it to /dev/null, and all that reached anyone was a
// oneshot exiting non-zero — so a full disk presented as a broken database image.
// A silent `run_quiet` would put that back without anything looking different.

import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const exec = promisify(execFile);

/** The container's own scripts, in the repository rather than in a built image. */
const SCRIPTS = new URL("../../../container/scripts/", import.meta.url).pathname;

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

async function present(command: string): Promise<boolean> {
  try {
    await exec("sh", ["-c", `command -v ${command}`]);
    return true;
  } catch {
    return false;
  }
}

describe("run_quiet", () => {
  let dir = "";
  let tools = false;

  beforeAll(async () => {
    tools = (await present("bash")) && (await present("jq"));
    dir = await mkdtemp(join(tmpdir(), "sandboxer-run-quiet-"));

    // `driver: none` and no services, so sourcing `lib.sh` — which sources
    // `env.sh` — runs the whole way through without needing a database or a
    // sandbox's worth of hostnames.
    await writeFile(
      join(dir, "plan.json"),
      JSON.stringify({
        project: "acme",
        database: { driver: "none", name: "acme" },
        storage: { driver: "none" },
        services: [],
        env: {},
      }),
    );
  });

  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  /**
   * Runs one snippet with `lib.sh` sourced, under the options every script in
   * `container/scripts` sets. `set -e` matters: it is what a caller of
   * `run_quiet` is running under, and the reason the helper may not end on a
   * false test.
   */
  async function bash(snippet: string): Promise<Run> {
    const script = `
set -euo pipefail
LOG_TAG="test"
source "$SANDBOXER_SCRIPTS/lib.sh"
${snippet}
`;
    try {
      const { stdout, stderr } = await exec("bash", ["-c", script], {
        env: {
          PATH: process.env.PATH ?? "",
          SANDBOXER_SCRIPTS: SCRIPTS,
          SANDBOXER_PLAN: join(dir, "plan.json"),
          SANDBOXER_SLUG: "tkt-1",
        },
      });
      return { code: 0, stdout, stderr };
    } catch (error) {
      const failure = error as { code?: number; stdout?: string; stderr?: string };
      return { code: failure.code ?? 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
    }
  }

  // Asserted rather than skipped over: a green run that quietly skipped is
  // indistinguishable from a green run that passed.
  it("has the bash and jq that lib.sh needs", () => {
    expect(tools, "bash and jq are both needed to source lib.sh").toBe(true);
  });

  it("says nothing when the command works", async () => {
    const run = await bash(`run_quiet bash -c 'echo chatter; echo more chatter >&2'`);
    expect(run.code).toBe(0);
    expect(run.stdout).toBe("");
    expect(run.stderr).toBe("");
  });

  it("keeps what a failing command wrote, on both streams", async () => {
    const run = await bash(
      `run_quiet bash -c 'echo "InnoDB: Error: unable to create temporary file"; echo "no space left on device" >&2; exit 1' || true`,
    );
    expect(run.stderr).toContain("no space left on device");
    expect(run.stderr).toContain("InnoDB: Error: unable to create temporary file");
    // The command's name and status, so a log line is readable on its own rather
    // than only in the context of the script that produced it.
    expect(run.stderr).toContain("bash failed (exit 1)");
  });

  it("returns the failing command's own status", async () => {
    const run = await bash(`run_quiet bash -c 'exit 42' || printf 'status=%s\\n' "$?"`);
    expect(run.stdout).toContain("status=42");
  });

  // A `[[ -n "$out" ]] && printf` ending false is itself a failure under `set -e`,
  // which would abort the caller before the status could be returned — and the
  // report of the failure would go missing exactly when there was least to go on.
  it("still reports a failure that printed nothing", async () => {
    const run = await bash(`run_quiet bash -c 'exit 3' || printf 'status=%s\\n' "$?"`);
    expect(run.stdout).toContain("status=3");
    expect(run.stderr).toContain("bash failed (exit 3)");
  });

  // The behaviour `mysql-init.sh` depends on: it runs under `set -e` with no
  // `||` of its own, so the oneshot has to stop on a failed initialisation.
  it("stops a caller running under set -e", async () => {
    const run = await bash(`run_quiet bash -c 'echo boom >&2; exit 1'\necho "reached the end"`);
    expect(run.code).toBe(1);
    expect(run.stdout).not.toContain("reached the end");
    expect(run.stderr).toContain("boom");
  });
});
