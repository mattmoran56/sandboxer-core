// Tests that the container reads a secrets file exactly the way the host writes
// one. The two halves are `writeSecretsFile`/`quoteSecret` here and the "project's
// secrets" block at the top of `container/scripts/env.sh`, and they are the one
// pair in the repository where a disagreement is *silent*: a credential that
// arrives with its quotes still round it fails as an authentication error, which
// looks nothing like a parsing problem.
//
// So this drives the real script, the way `config/plan.test.ts` drives the real
// plan writer against the container's own worked examples:
// - every value the host wrote comes back byte for byte: one containing ` # `,
//   one containing `$(...)` and a backtick, one with significant leading and
//   trailing spaces, and one that is itself a quote character
// - a hand-edited unquoted line still works, because this is a file people edit
// - a comment, a blank line, a line with no `=` and a line whose name is not a
//   variable name are all skipped, and none of them stops the script
// - a final line with no trailing newline is still read
// - a name already set in the environment is left alone: contracts §5.2 puts the
//   host's `--env-file` and `-e` above the project's file, and this is the whole
//   of what enforces it
// - the plan's `env` map can name a secret through `envsubst`, which is what
//   `secrets.rename` is for, and a name the sandbox derives is still its own
// - no secrets file at all is the ordinary case, not a failure
//
// Real bash, real jq, real envsubst, under the `set -euo pipefail` that
// `container/scripts/with-env` uses: the behaviour under test *is* the shell's, so
// a reimplementation in TypeScript would only assert that this file and the fake
// agree with each other.

import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { writeSecretsFile } from "./secrets.js";

const exec = promisify(execFile);

/** The container's own scripts, in the repository rather than in a built image. */
const SCRIPTS = new URL("../../../container/scripts/", import.meta.url).pathname;

/** A sentinel, so "exported empty" and "never exported" are different answers. */
const UNSET = "<unset>";

/**
 * Sources `lib.sh` — which sources `env.sh` — and prints what each named
 * variable ended up as, NUL-separated because a value may contain anything but a
 * newline.
 */
const DUMP = `
set -euo pipefail
source "$SANDBOXER_SCRIPTS/lib.sh"
for sandboxer_test_name in "$@"; do
  printf '%s=%s\\0' "$sandboxer_test_name" "\${!sandboxer_test_name-${UNSET}}"
done
`;

/**
 * Values chosen for what each one would break, not for variety.
 *
 * ` # ` produced the bug the quoting exists for: the host's own reader strips a
 * trailing comment from an unquoted value, so this came back truncated at the
 * hash. `$(id)` and a backtick would run if anything ever `source`d the file.
 * The spaces are significant, so nothing may trim inside the quotes. `"abc` is
 * the value that is itself a quote: written `""abc"`, and one layer off leaves
 * it as it was.
 */
const WRITTEN: Record<string, string> = {
  API_TOKEN: "sk-live-0123456789ab",
  HASH_IN_VALUE: "a=b # c",
  SHELL_IN_VALUE: "$(id) `id` ${HOME}",
  EDGE_SPACES: "  padded  ",
  LEADING_QUOTE: '"abc',
  DIGIT_ONLY: "0",
};

async function present(command: string): Promise<boolean> {
  try {
    await exec("sh", ["-c", `command -v ${command}`]);
    return true;
  } catch {
    return false;
  }
}

describe("the container's reader and the host's writer", () => {
  let dir = "";
  let tools = false;

  beforeAll(async () => {
    tools = (await present("bash")) && (await present("jq")) && (await present("envsubst"));
    dir = await mkdtemp(join(tmpdir(), "sandboxer-secrets-"));

    // `driver: none` and no services, so everything below the secrets block still
    // runs — that is what a real sourcing does — without needing a database or a
    // sandbox's worth of hostnames.
    await writeFile(
      join(dir, "plan.json"),
      JSON.stringify({
        project: "acme",
        database: { driver: "none", name: "acme" },
        storage: { driver: "none" },
        services: [],
        // The first is `secrets.rename`'s reason to exist: a plan value may name a
        // secret, which only works because the secrets are read first. The second
        // shows the order does not run the other way — a derived name is the
        // sandbox's own.
        env: { APP_TOKEN: "${API_TOKEN}", APP_DRIVER: "${SANDBOXER_DB_DRIVER}" },
      }),
    );
  });

  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  async function sourced(
    secretsFile: string,
    names: string[],
    extra: Record<string, string> = {},
  ): Promise<Record<string, string>> {
    const { stdout } = await exec("bash", ["-c", DUMP, "dump", ...names], {
      env: {
        PATH: process.env.PATH ?? "",
        SANDBOXER_SCRIPTS: SCRIPTS,
        SANDBOXER_PLAN: join(dir, "plan.json"),
        SANDBOXER_SECRETS: secretsFile,
        SANDBOXER_SLUG: "feat-checkout",
        ...extra,
      },
    });
    const out: Record<string, string> = {};
    for (const chunk of stdout.split("\0")) {
      if (chunk === "") continue;
      const at = chunk.indexOf("=");
      out[chunk.slice(0, at)] = chunk.slice(at + 1);
    }
    return out;
  }

  // Asserted rather than skipped over: a green run that quietly skipped is
  // indistinguishable from a green run that passed, and the base image
  // guarantees all three ("jq is not optional", container/README.md).
  it("has the bash, jq and envsubst that env.sh needs", () => {
    expect(tools, "bash, jq and envsubst are all needed to exercise env.sh").toBe(true);
  });

  it("reads back every value the host wrote, byte for byte", async () => {
    const file = join(dir, "written.env");
    await writeSecretsFile(file, new Map(Object.entries(WRITTEN)), "# acme's credentials");

    const read = await sourced(file, Object.keys(WRITTEN));
    for (const [name, value] of Object.entries(WRITTEN)) {
      expect(read[name], name).toBe(value);
    }
  });

  it("lets the plan's env map name a secret, and still derives its own names", async () => {
    const file = join(dir, "written.env");
    await writeSecretsFile(file, new Map(Object.entries(WRITTEN)), "# acme's credentials");

    const read = await sourced(file, ["APP_TOKEN", "APP_DRIVER"]);
    expect(read.APP_TOKEN).toBe(WRITTEN.API_TOKEN);
    expect(read.APP_DRIVER).toBe("none");
  });

  it("survives a hand-edited file, skipping only the lines it cannot use", async () => {
    const file = join(dir, "hand.env");
    // Written by hand rather than by `writeSecretsFile`, because these are the
    // shapes the host would never produce and a person will. Joined without a
    // trailing newline on purpose: the last line is where that happens.
    await writeFile(
      file,
      [
        "# a comment",
        "",
        "   ",
        "NOT_A_PAIR",
        "2BAD=refused",
        "BAD NAME=refused",
        "UNQUOTED=plain value",
        "SINGLE='in single quotes'",
        "NO_NEWLINE=last one",
      ].join("\n"),
    );

    const read = await sourced(file, ["NOT_A_PAIR", "2BAD", "UNQUOTED", "SINGLE", "NO_NEWLINE"]);
    expect(read.NOT_A_PAIR).toBe(UNSET);
    // A name that is not a variable name is skipped rather than exported: under
    // `set -e` an `export '2BAD=x'` would stop the entrypoint, every build and
    // every database verb, and none of them would name the file.
    expect(read["2BAD"]).toBe(UNSET);
    expect(read.UNQUOTED).toBe("plain value");
    expect(read.SINGLE).toBe("in single quotes");
    // The one a `while read` loop loses without `|| [[ -n "$line" ]]`.
    expect(read.NO_NEWLINE).toBe("last one");
  });

  it("leaves a name the host already set alone", async () => {
    const file = join(dir, "shadow.env");
    // Nothing on the host stops a project putting these in its own file: the
    // reserved-name list covers what the *sandbox* derives, not a git identity.
    // What stops them is the reader skipping a name that is already set.
    await writeSecretsFile(
      file,
      new Map([
        ["GIT_AUTHOR_EMAIL", "someone-else@example.invalid"],
        ["GH_TOKEN", "ghp_from_the_file"],
        ["API_TOKEN", "sk-live-0123456789ab"],
      ]),
    );

    const read = await sourced(file, ["GIT_AUTHOR_EMAIL", "GH_TOKEN", "API_TOKEN"], {
      GIT_AUTHOR_EMAIL: "someone@example.com",
      GH_TOKEN: "ghp_from_the_host",
    });
    expect(read.GIT_AUTHOR_EMAIL).toBe("someone@example.com");
    expect(read.GH_TOKEN).toBe("ghp_from_the_host");
    // And a name the host did not set still arrives, so this is a skip rather
    // than a refusal to read the file at all.
    expect(read.API_TOKEN).toBe("sk-live-0123456789ab");
  });

  it("does nothing at all when there is no secrets file", async () => {
    const read = await sourced(join(dir, "absent.env"), ["API_TOKEN", "APP_DRIVER"]);
    expect(read.API_TOKEN).toBe(UNSET);
    // The rest of env.sh still ran: a project with no credentials is the
    // ordinary case, not a broken one.
    expect(read.APP_DRIVER).toBe("none");
  });
});
