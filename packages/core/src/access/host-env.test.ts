// Tests for the host facts file the compose deployment reads:
// - only the facts that are present are written, and a blank one is absent rather than empty
// - the keys are written in a fixed order, so two runs on one machine produce the same file
// - a value with spaces survives, because a commit identity is exactly that
// - a quote and a backslash are escaped the way Compose's dotenv reader unescapes them
// - a newline is refused rather than escaped
// - the file lands at $SANDBOXR_HOME/host.env, mode 0600, because it holds a GitHub token

import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { HOST_ENV_KEYS, HostEnvError, formatHostEnv, hostEnvironment, writeHostEnv } from "./host-env.js";

const facts = {
  ghToken: "gho_example",
  gitIdentity: { name: "Ada Lovelace", email: "ada@example.com" },
  claudeCredentials: "/Users/ada/.claude/.credentials.json",
  claudeToken: "sk-ant-example",
};

describe("hostEnvironment", () => {
  it("names every key the file can hold", () => {
    expect(Object.keys(hostEnvironment(facts)).sort()).toEqual([...HOST_ENV_KEYS].sort());
  });

  it("omits a fact this machine does not have", () => {
    const held = hostEnvironment({ gitIdentity: { name: "Ada", email: "ada@example.com" } });
    expect(held.GH_TOKEN).toBeUndefined();
    expect(held.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(held.GIT_AUTHOR_NAME).toBe("Ada");
  });

  it("treats a blank value as absent rather than as an empty credential", () => {
    // The same rule forwardedEnvironment applies, and for the same reason: an
    // empty string is a value, and a server that sees one stops falling back to
    // its own default.
    expect(hostEnvironment({ ghToken: "   " }).GH_TOKEN).toBeUndefined();
  });
});

describe("formatHostEnv", () => {
  it("writes the keys in a fixed order", () => {
    const written = formatHostEnv(hostEnvironment(facts))
      .split("\n")
      .filter((line) => line !== "" && !line.startsWith("#"))
      .map((line) => line.slice(0, line.indexOf("=")));
    expect(written).toEqual([...HOST_ENV_KEYS]);
  });

  it("keeps the spaces in a commit identity", () => {
    expect(formatHostEnv({ GIT_AUTHOR_NAME: "Ada Lovelace" })).toContain('GIT_AUTHOR_NAME="Ada Lovelace"');
  });

  it("escapes a quote and a backslash", () => {
    expect(formatHostEnv({ GH_TOKEN: 'a"b\\c' })).toContain('GH_TOKEN="a\\"b\\\\c"');
  });

  it("refuses a newline rather than writing a file nobody wrote", () => {
    expect(() => formatHostEnv({ GH_TOKEN: "a\nB=evil" })).toThrow(HostEnvError);
  });

  it("says who wrote it, because an edit to it would be lost", () => {
    expect(formatHostEnv({})).toContain("sandboxr init");
  });
});

describe("writeHostEnv", () => {
  it("writes $SANDBOXR_HOME/host.env, readable by nobody else", async () => {
    const home = await mkdtemp(join(tmpdir(), "sandboxr-host-env-"));
    const file = await writeHostEnv({ facts, env: { SANDBOXR_HOME: home } });

    expect(file).toBe(join(home, "host.env"));
    expect(await readFile(file, "utf8")).toContain('GH_TOKEN="gho_example"');
    // It holds a GitHub token, so it is `secrets/`-grade rather than `state/`-grade.
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });
});
