// Tests for ~/.sandboxer/config.yaml, the machine's own settings:
// - loadMachineConfig: a missing file and an empty file are the defaults, not an error
// - loadMachineConfig: a misspelled key, a bad ttl and unreadable YAML are errors naming the file and the field
// - resolveTtl: the precedence chain — --ttl, the project entry, the file, SANDBOXER_TTL_HOURS, the built-in
// - resolveTtl: an unreadable SANDBOXER_TTL_HOURS falls through instead of failing a start
// - resolveGithub: the project entry beats the file, which beats the default, which is off
// - projectEntry: a projects: key is either of a project's two names, directory first
// - projectEntry: a key that is another project's directory never reaches this one through its declared name
// - decideGithub: says which rung of the ladder answered, so a message can name the key
// - reviewProjectEntries: keys matching no project, keys matching two, and the names that would work
// - loadMachineConfig: an unknown github mode is an error naming the field
// - writeMachineConfigExample: writes once, never overwrites, and what it writes parses back
// - share: the rows load, `~` expands, and `into:` must be absolute
// - sharedFiles: a missing source is skipped, because Docker answers a missing
//   bind by creating a directory at that path on the host
// - sharedFiles: a zero-byte source is skipped, which is the macOS credential
//   that read as `Not logged in` inside every sandbox on the machine

import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { paths } from "../paths.js";
import {
  DEFAULT_GITHUB,
  DEFAULT_TTL,
  decideGithub,
  loadMachineConfig,
  projectEntry,
  resolveGithub,
  resolveTtl,
  reviewProjectEntries,
  sharedFiles,
  writeMachineConfigExample,
} from "./machine.js";

let env: NodeJS.ProcessEnv;

beforeEach(async () => {
  env = { SANDBOXER_HOME: await mkdtemp(join(tmpdir(), "sandboxer-config-")) };
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
    expect(resolveTtl({ explicit: "2h", project: "acme", config, env: { SANDBOXER_TTL_HOURS: "4" } })).toBe("2h");
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
  it("takes SANDBOXER_TTL_HOURS only when the file says nothing", () => {
    expect(resolveTtl({ project: "acme", config: {}, env: { SANDBOXER_TTL_HOURS: "4" } })).toBe("4h");
    expect(resolveTtl({ project: "acme", config, env: { SANDBOXER_TTL_HOURS: "4" } })).toBe("3d");
  });

  it("falls back to the built-in twelve hours", () => {
    expect(resolveTtl({ env: {} })).toBe(DEFAULT_TTL);
    expect(DEFAULT_TTL).toBe("12h");
  });

  // Unlike the file, nobody has just typed this: it comes from a unit file
  // written months ago, and refusing to start a sandbox over it would be a
  // surprising place to discover the typo.
  it("falls through an unreadable SANDBOXER_TTL_HOURS rather than failing", () => {
    expect(resolveTtl({ config: {}, env: { SANDBOXER_TTL_HOURS: "soon" } })).toBe(DEFAULT_TTL);
    expect(resolveTtl({ config: {}, env: { SANDBOXER_TTL_HOURS: "" } })).toBe(DEFAULT_TTL);
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

/*
 * The report this whole group comes from: a workspace holding `demo-managed`
 * and `acme-monorepo` (which declares `project: acme`), and a config.yaml
 * saying `demo: { github: token }`. Every key matched nothing, both projects
 * fell through to `github: none`, and nothing said so until an agent could not
 * push hours later.
 */
describe("projectEntry, the two names a project answers to", () => {
  const config = {
    projects: { "acme-monorepo": { ttl: "3d" }, acme: { ttl: "1h" }, demo: { ttl: "never" } },
  };

  it("matches the workspace directory name", () => {
    expect(projectEntry(config, { directory: "acme-monorepo", project: "acme" })?.key).toBe("acme-monorepo");
  });

  it("matches the declared project: when nothing is keyed on the directory", () => {
    const found = projectEntry({ projects: { acme: { ttl: "1h" } } }, { directory: "acme-monorepo", project: "acme" });
    expect(found).toEqual({ key: "acme", entry: { ttl: "1h" }, via: "project" });
  });

  it("prefers the directory when both are keyed", () => {
    // The name the operator can see without opening a file wins.
    expect(projectEntry(config, { directory: "acme-monorepo", project: "acme" })?.entry.ttl).toBe("3d");
  });

  it("does not hand one project's key to another that merely declares that name", () => {
    // `demo` is a real project's directory here, so `demo-monorepo`'s declared
    // `project: demo` must not collect it — a key naming a directory belongs to
    // the project whose directory it is, and being wrong about `github:` hands
    // one repository's opt-in to another.
    const found = projectEntry(config, {
      directory: "demo-monorepo",
      project: "demo",
      directories: ["acme-monorepo", "demo"],
    });
    expect(found).toBeUndefined();
  });

  it("still matches the declared name when no project owns it as a directory", () => {
    expect(
      projectEntry(config, { directory: "acme-monorepo2", project: "acme", directories: ["acme-monorepo2", "demo"] })
        ?.key,
    ).toBe("acme");
  });

  it("reaches resolveTtl and resolveGithub alike", () => {
    const both = { directory: "acme-monorepo", project: "acme" };
    expect(resolveTtl({ ...both, config: { projects: { "acme-monorepo": { ttl: "3d" } } }, env: {} })).toBe("3d");
    expect(resolveGithub({ ...both, config: { projects: { "acme-monorepo": { github: "token" } } } })).toBe("token");
  });
});

describe("decideGithub", () => {
  it("names the key that answered, so a message can quote it back", () => {
    expect(
      decideGithub({ directory: "acme-monorepo", config: { projects: { "acme-monorepo": { github: "token" } } } }),
    ).toEqual({ mode: "token", key: "acme-monorepo", source: "project" });
  });

  it("distinguishes the file's own answer from the built-in one", () => {
    // "off because you said so" and "off because nothing mentions this project"
    // are different instructions to give somebody.
    expect(decideGithub({ config: { github: "none" } }).source).toBe("machine");
    expect(decideGithub({ config: {} }).source).toBe("default");
  });
});

describe("reviewProjectEntries", () => {
  const projects = [
    { directory: "demo-managed" },
    { directory: "acme-monorepo", project: "acme" },
  ];

  it("reports a key that matches no project, and lists the names that would", () => {
    const review = reviewProjectEntries({ projects: { demo: { github: "token" } } }, projects);
    expect(review.unmatched).toEqual(["demo"]);
    expect(review.known).toEqual(["acme", "acme-monorepo", "demo-managed"]);
  });

  it("accepts either name as a match", () => {
    const config = { projects: { "demo-managed": { ttl: "1h" }, acme: { ttl: "3d" } } };
    expect(reviewProjectEntries(config, projects).unmatched).toEqual([]);
  });

  it("does not call a project ambiguous with itself", () => {
    const same = [{ directory: "acme", project: "acme" }];
    expect(reviewProjectEntries({ projects: { acme: {} } }, same).ambiguous).toEqual([]);
  });

  it("reports a key that is one project's directory and another's declared name", () => {
    const clashing = [{ directory: "demo" }, { directory: "demo-monorepo", project: "demo" }];
    expect(reviewProjectEntries({ projects: { demo: {} } }, clashing).ambiguous).toEqual(["demo"]);
  });

  it("has nothing to say about a file with no projects: block", () => {
    expect(reviewProjectEntries({ ttl: "3d" }, projects)).toEqual({
      unmatched: [],
      ambiguous: [],
      known: ["acme", "acme-monorepo", "demo-managed"],
    });
  });
});

describe("loadMachineConfig, the github field", () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "sandboxer-machine-gh-"));
  });

  it("reads it at both levels", async () => {
    await writeFile(paths({ SANDBOXER_HOME: home }).configFile, "github: token\nprojects:\n  acme: { github: none }\n");
    const config = await loadMachineConfig({ SANDBOXER_HOME: home });
    expect(config.github).toBe("token");
    expect(config.projects?.acme?.github).toBe("none");
  });

  it("refuses a value it does not recognise, rather than reading it as off", async () => {
    // `github: true` is the obvious thing to write and would silently mean
    // nothing at all — which for a credential setting is the wrong way to fail.
    await writeFile(paths({ SANDBOXER_HOME: home }).configFile, "github: yes\n");
    await expect(loadMachineConfig({ SANDBOXER_HOME: home })).rejects.toThrow(/github/);
  });
});

describe("share:", () => {
  it("loads the rows as written", async () => {
    await write("share:\n  - host: /Users/ada/.npmrc\n    into: /root/.npmrc\n");
    const config = await loadMachineConfig(env);
    expect(config.share).toEqual([{ host: "/Users/ada/.npmrc", into: "/root/.npmrc" }]);
  });

  // A relative `into:` is a path Docker reads as a *volume name*, which would
  // create an anonymous volume rather than mounting the file — a failure with no
  // symptom until whatever was supposed to read it says the file is missing.
  it("refuses an `into:` that is not absolute", async () => {
    await write("share:\n  - host: /Users/ada/.npmrc\n    into: root/.npmrc\n");
    await expect(loadMachineConfig(env)).rejects.toThrow(/absolute/);
  });

  it("expands `~` against HOME", async () => {
    const home = await mkdtemp(join(tmpdir(), "sandboxer-share-"));
    await writeFile(join(home, ".npmrc"), "//registry:_authToken=x\n", "utf8");

    const files = sharedFiles({ share: [{ host: "~/.npmrc", into: "/root/.npmrc" }] }, { HOME: home });
    expect(files).toEqual([{ host: join(home, ".npmrc"), into: "/root/.npmrc" }]);
  });

  // Docker does not refuse a bind whose source is missing: it silently creates a
  // *directory* at that path on the host and mounts that. So the operator loses
  // the file they were pointing at, and whatever was meant to read it fails with
  // a message naming neither Docker nor the mount.
  it("skips a row whose source is not there", () => {
    const files = sharedFiles({ share: [{ host: "/nowhere/at/all", into: "/root/.npmrc" }] }, {});
    expect(files).toEqual([]);
  });

  // The incident this rule came from. On macOS a coding agent's
  // `.credentials.json` is often an empty placeholder, because the account login
  // is in the login keychain. Mounted over the container's working copy it
  // replaced a credential with nothing, and the agent reported `Not logged in`
  // in every sandbox on the machine — with a valid credential on the host the
  // whole time.
  it("skips a row whose source is zero bytes", async () => {
    const home = await mkdtemp(join(tmpdir(), "sandboxer-share-"));
    await writeFile(join(home, "empty"), "", "utf8");

    expect(sharedFiles({ share: [{ host: join(home, "empty"), into: "/root/x" }] }, {})).toEqual([]);
  });

  // A directory is not a file, and mounting one hands the sandbox everything
  // else inside it — which for a tool's config directory usually includes
  // settings the host itself executes.
  it("skips a row pointing at a directory", async () => {
    const home = await mkdtemp(join(tmpdir(), "sandboxer-share-"));
    expect(sharedFiles({ share: [{ host: home, into: "/root/x" }] }, {})).toEqual([]);
  });

  // The upgrade note §4.3 makes: before this key existed one credential — the
  // agent's — was mounted unconditionally, so a machine upgraded without a row
  // written for it loses that login in every sandbox at once.
  it("shares nothing on a machine with no rows", () => {
    expect(sharedFiles({}, {})).toEqual([]);
  });
});
