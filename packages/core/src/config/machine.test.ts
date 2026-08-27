// Tests for ~/.sandboxr/config.yaml, the machine's own settings:
// - loadMachineConfig: a missing file and an empty file are the defaults, not an error
// - loadMachineConfig: a misspelled key, a bad ttl and unreadable YAML are errors naming the file and the field
// - resolveTtl: the precedence chain — --ttl, the project entry, the file, SANDBOXR_TTL_HOURS, the built-in
// - resolveTtl: an unreadable SANDBOXR_TTL_HOURS falls through instead of failing a start
// - resolveGithub: the project entry beats the file, which beats the default, which is off
// - loadMachineConfig: an unknown github mode is an error naming the field
// - writeMachineConfigExample: writes once, never overwrites, and what it writes parses back

import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { paths } from "../paths.js";
import {
  DEFAULT_GITHUB,
  DEFAULT_TTL,
  loadMachineConfig,
  resolveGithub,
  resolveTtl,
  writeMachineConfigExample,
} from "./machine.js";

let env: NodeJS.ProcessEnv;

beforeEach(async () => {
  env = { SANDBOXR_HOME: await mkdtemp(join(tmpdir(), "sandboxr-config-")) };
});

const write = (text: string): Promise<void> => writeFile(paths(env).configFile, text, "utf8");

describe("loadMachineConfig", () => {
  // A machine nobody has configured is asking for the defaults, not for an
  // error on every command.
  it("reads a missing file as no settings at all", async () => {
    expect(await loadMachineConfig(env)).toEqual({});
  });

  it("reads an empty file the same way", async () => {
    await write("");
    expect(await loadMachineConfig(env)).toEqual({});
  });

  it("reads a top-level ttl and per-project entries", async () => {
    await write("ttl: 12h\nprojects:\n  acme: { ttl: 3d }\n  demo: { ttl: never }\n");
    expect(await loadMachineConfig(env)).toEqual({
      ttl: "12h",
      projects: { acme: { ttl: "3d" }, demo: { ttl: "never" } },
    });
  });

  // The whole reason this file is strict and its failures are loud: falling
  // back to a default lifetime after somebody has just edited the file is how a
  // week of work gets stopped twelve hours in.
  it("names a misspelled key rather than ignoring it", async () => {
    await write("tll: 3d\n");
    await expect(loadMachineConfig(env)).rejects.toThrow(/tll/);
  });

  it("names the file in the error", async () => {
    await write("tll: 3d\n");
    await expect(loadMachineConfig(env)).rejects.toThrow(paths(env).configFile);
  });

  it("refuses a ttl it cannot read, and says what a ttl looks like", async () => {
    await write("ttl: soonish\n");
    await expect(loadMachineConfig(env)).rejects.toThrow(/30m, 12h, 3d/);
  });

  it("refuses a per-project ttl it cannot read", async () => {
    await write("projects:\n  acme: { ttl: 0h }\n");
    await expect(loadMachineConfig(env)).rejects.toThrow(/projects\.acme\.ttl/);
  });

  it("refuses YAML it cannot parse", async () => {
    await write("ttl: [unclosed\n");
    await expect(loadMachineConfig(env)).rejects.toThrow(paths(env).configFile);
  });
});

describe("resolveTtl", () => {
  const config = { ttl: "12h", projects: { acme: { ttl: "3d" } } };

  it("takes what the command was told before anything else", () => {
    expect(resolveTtl({ explicit: "2h", project: "acme", config, env: { SANDBOXR_TTL_HOURS: "4" } })).toBe("2h");
  });

  it("takes the project's entry before the file's top-level ttl", () => {
    expect(resolveTtl({ project: "acme", config, env: {} })).toBe("3d");
  });

  it("takes the file's top-level ttl for a project with no entry", () => {
    expect(resolveTtl({ project: "demo", config, env: {} })).toBe("12h");
  });

  // The variable sits below the file on purpose. It is set once by whoever
  // installed the service and then forgotten; the file is what somebody edits,
  // and an edit that loses to a forgotten variable is the worst kind of not
  // working.
  it("takes SANDBOXR_TTL_HOURS only when the file says nothing", () => {
    expect(resolveTtl({ project: "acme", config: {}, env: { SANDBOXR_TTL_HOURS: "4" } })).toBe("4h");
    expect(resolveTtl({ project: "acme", config, env: { SANDBOXR_TTL_HOURS: "4" } })).toBe("3d");
  });

  it("falls back to the built-in twelve hours", () => {
    expect(resolveTtl({ env: {} })).toBe(DEFAULT_TTL);
    expect(DEFAULT_TTL).toBe("12h");
  });

  // Unlike the file, nobody has just typed this: it comes from a unit file
  // written months ago, and refusing to start a sandbox over it would be a
  // surprising place to discover the typo.
  it("falls through an unreadable SANDBOXR_TTL_HOURS rather than failing", () => {
    expect(resolveTtl({ config: {}, env: { SANDBOXR_TTL_HOURS: "soon" } })).toBe(DEFAULT_TTL);
    expect(resolveTtl({ config: {}, env: { SANDBOXR_TTL_HOURS: "" } })).toBe(DEFAULT_TTL);
  });

  it("treats an empty --ttl as not given", () => {
    expect(resolveTtl({ explicit: "  ", config, project: "acme", env: {} })).toBe("3d");
  });
});

describe("writeMachineConfigExample", () => {
  it("writes a file that loads back as the documented default", async () => {
    const file = await writeMachineConfigExample(env);
    expect(file).toBe(paths(env).configFile);
    expect(await loadMachineConfig(env)).toEqual({ ttl: DEFAULT_TTL, github: DEFAULT_GITHUB });
  });

  it("says how to change the setting, in the file itself", async () => {
    await writeMachineConfigExample(env);
    expect(await readFile(paths(env).configFile, "utf8")).toContain("sit unused");
  });

  // Never touched again, because the second `init` is the one run on a machine
  // where somebody has already written down the lifetime they wanted.
  it("does not overwrite a file that is already there", async () => {
    await write("ttl: 3d\n");
    expect(await writeMachineConfigExample(env)).toBeUndefined();
    expect(await loadMachineConfig(env)).toEqual({ ttl: "3d" });
  });
});

describe("resolveGithub", () => {
  it("is off when nothing says otherwise", () => {
    expect(resolveGithub()).toBe("none");
    expect(DEFAULT_GITHUB).toBe("none");
  });

  it("takes the file's top-level setting", () => {
    expect(resolveGithub({ config: { github: "token" } })).toBe("token");
  });

  it("lets a project entry beat the file, in both directions", () => {
    expect(resolveGithub({ project: "acme", config: { projects: { acme: { github: "token" } } } })).toBe("token");
    // The direction that matters: a machine that hands its token to everything
    // must still be able to withhold it from one project.
    expect(
      resolveGithub({ project: "acme", config: { github: "token", projects: { acme: { github: "none" } } } }),
    ).toBe("none");
  });

  it("ignores an entry for a different project", () => {
    expect(resolveGithub({ project: "other", config: { projects: { acme: { github: "token" } } } })).toBe("none");
  });
});

describe("loadMachineConfig, the github field", () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "sandboxr-machine-gh-"));
  });

  it("reads it at both levels", async () => {
    await writeFile(paths({ SANDBOXR_HOME: home }).configFile, "github: token\nprojects:\n  acme: { github: none }\n");
    const config = await loadMachineConfig({ SANDBOXR_HOME: home });
    expect(config.github).toBe("token");
    expect(config.projects?.acme?.github).toBe("none");
  });

  it("refuses a value it does not recognise, rather than reading it as off", async () => {
    // `github: true` is the obvious thing to write and would silently mean
    // nothing at all — which for a credential setting is the wrong way to fail.
    await writeFile(paths({ SANDBOXR_HOME: home }).configFile, "github: yes\n");
    await expect(loadMachineConfig({ SANDBOXR_HOME: home })).rejects.toThrow(/github/);
  });
});
