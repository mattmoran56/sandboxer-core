// Exercises env.sh with real bash, jq and envsubst. Values can contain shell
// syntax and newlines, and later names can depend on earlier exports. A second
// fixture counts actual plan reads as the map grows to guard the startup cost.
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const exec = promisify(execFile);
const scripts = fileURLToPath(new URL("../../../container/scripts/", import.meta.url));

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "sandboxer-plan-env-"));
  const plan = join(dir, "plan.json");
  const env = {
    PATH: process.env.PATH ?? "",
    SANDBOXER_SCRIPTS: scripts,
    SANDBOXER_PLAN: plan,
    SANDBOXER_SECRETS: join(dir, "absent"),
  };
  async function run(values: Record<string, string>, command: string, extra: Record<string,string> = {}) {
    await writeFile(plan, JSON.stringify({ project: "example", env: values }));
    const { stdout } = await exec("bash", ["-euc", 'source "$SANDBOXER_SCRIPTS/lib.sh"\n' + command],
      { cwd: dir, env: { ...env, ...extra } });
    return stdout;
  }
  return { dir, run, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

it("expands sorted names as data, preserving boundaries and rereading inputs in a fresh shell", async ({ onTestFinished }) => {
  const f = await fixture();
  onTestFinished(f.cleanup);
  const literal = '  \"words\"\t\n😀\n$(touch executed) `touch executed` ; \\';
  // Deliberately insert B before A. JSON insertion order must not affect expansion.
  const values = { B: "${A}/${SANDBOXER_PROJECT}", A: literal, C: "", D: "one\0two", E: "three\n\n" };
  const command = 'test ! -e executed; printf "%s\\0" "$A" "$B" "${C?missing}" "$D" "$E"';
  expect((await f.run(values, command)).split("\0")).toEqual([literal, literal + "/example", "", "onetwo", "three", ""]);
  expect(await f.run({ B: "$A", A: "revised" }, 'printf %s "$B"')).toBe("revised");
});

it("reads the plan the same number of times for one mapping and for forty", async ({ onTestFinished }) => {
  const f = await fixture();
  onTestFinished(f.cleanup);
  const { stdout: realJq } = await exec("bash", ["-c", "command -v jq"]);
  const wrapper = join(f.dir, "bin", "jq");
  const log = join(f.dir, "reads");
  await mkdir(dirname(wrapper));
  await writeFile(wrapper, '#!/bin/bash\nif [[ "${!#}" == "$SANDBOXER_PLAN" ]]; then echo read >> "$READS"; fi\nexec "$REAL_JQ" "$@"\n');
  await chmod(wrapper, 0o755);
  const extra = { PATH: dirname(wrapper) + ":" + process.env.PATH, READS: log, REAL_JQ: realJq.trim() };
  async function reads(count: number) {
    await writeFile(log, "");
    const values = Object.fromEntries(Array.from({ length: count }, (_, n) => ["FIELD_" + n, "value"]));
    await f.run(values, ":", extra);
    return (await readFile(log, "utf8")).trim().split("\n").length;
  }
  expect(await reads(40)).toBe(await reads(1));
});
