// Tests for the secrets import filter and its report:
// - parseEnvFile: quotes, trailing comments, `export `, blanks, comments, empty values, CRLF, an `=` inside a value
// - matchesAny: prefix, suffix and exact glob patterns; a literal dot is not a wildcard
// - filterSecrets: the keep allow-list governs; an unlisted name is dropped even though nothing denies it
// - filterSecrets: the never list rejects location variables; a later file wins; rename outranks never
// - filterSecrets: a rename target is kept under its new name, and the source name does not survive
// - importSecrets: names only in the report, the file is 0600, missing sources reported rather than fatal
// - checkSecrets: presence only, rename targets counted, an absent file reported as absent
// - importSecrets: a merge, so a hand-typed name survives it; --replace still rebuilds the file
// - isReservedEnvName / envNameRefusal: the names a sandbox derives, the project's never patterns,
//   a malformed name, a value with a newline in it, and what still applies with no config
// - hintFor: the tail of a long value, nothing at all for a short one, at the boundary
// - describeProjectSecrets: names, hints and lengths but never a value; what is declared and absent;
//   what the project's env map will overwrite; configKnown; not editable for a public project
//   that has not opted in
// - revealProjectSecret: the one function that answers with a value
// - editProjectSecrets: add/update/remove, 0600, a refusal beside the names it did apply,
//   set beating text and unset beating both, an awkward value round-tripping unevaluated
// - envDigest: order-independent, sensitive to a value and to the plan's env map, no split collisions

import { readFile, stat, mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveConfig } from "./config/load.js";
import type { ResolvedConfig } from "./config/types.js";
import {
  checkSecrets,
  describeProjectSecrets,
  editProjectSecrets,
  envDigest,
  envNameRefusal,
  filterSecrets,
  hintFor,
  importSecrets,
  isReservedEnvName,
  matchesAny,
  parseEnvFile,
  revealProjectSecret,
} from "./secrets.js";

describe("parseEnvFile", () => {
  it("reads a plain assignment", () => {
    expect(parseEnvFile("A=1\n").get("A")).toBe("1");
  });

  it.each([
    ["double quotes are stripped", 'A="one two"', "one two"],
    ["single quotes are stripped", "A='one two'", "one two"],
    ["an export prefix is ignored", "export A=1", "1"],
    ["surrounding whitespace goes", "  A =  1  ", "1"],
    ["a trailing comment on an unquoted value goes", "A=1 # why", "1"],
    ["a hash inside quotes stays", 'A="1 # why"', "1 # why"],
    ["an equals sign inside the value stays", "A=a=b", "a=b"],
    ["a url survives", "A=https://example.test/x?y=1", "https://example.test/x?y=1"],
    ["a CRLF line ending goes", "A=1\r", "1"],
  ])("%s", (_name, line, want) => {
    expect(parseEnvFile(`${line}\n`).get("A")).toBe(want);
  });

  it.each([
    ["a comment line", "# A=1"],
    ["a blank line", "   "],
    ["a line that is not an assignment", "just some words"],
    ["a name that is not an identifier", "9A=1"],
    // A name present but blank is what a template looks like; importing it
    // would mask a real value from a later file.
    ["an empty value", "A="],
    ["an empty quoted value", 'A=""'],
  ])("skips %s", (_name, line) => {
    expect(parseEnvFile(`${line}\n`).has("A")).toBe(false);
  });

  it("keeps the last assignment within one file", () => {
    expect(parseEnvFile("A=1\nA=2\n").get("A")).toBe("2");
  });
});

describe("matchesAny", () => {
  it.each([
    ["a prefix pattern", "DB_HOST", ["DB_*"], true],
    ["a prefix pattern that does not match", "DBHOST", ["DB_*"], false],
    ["a suffix pattern", "ADMIN_URL", ["*_URL"], true],
    ["an exact name", "PORT", ["PORT"], true],
    ["an exact name that does not match", "PORTAL", ["PORT"], false],
    ["one of several", "S3_KEY", ["DB_*", "S3_*"], true],
    ["no patterns", "ANY", [], false],
    ["a bare star", "ANY", ["*"], true],
  ])("%s", (_name, value, patterns, want) => {
    expect(matchesAny(value, patterns)).toBe(want);
  });

  // A pattern is a glob, not a regex: a dot must match a dot.
  it("treats a dot literally", () => {
    expect(matchesAny("AxB", ["A.B"])).toBe(false);
    expect(matchesAny("A.B", ["A.B"])).toBe(true);
  });
});

describe("filterSecrets", () => {
  const rules = {
    keep: ["API_TOKEN", "VENDOR_API_URL"],
    rename: { CLIENT_TOKEN: "PUBLIC_TOKEN", WIDGET_SDK_URL: "SANDBOXR_WIDGET_SDK_URL" },
    never: ["DB_*", "STORE_*", "*_URL", "PORT"],
  };

  const filter = (...files: Array<Record<string, string>>) =>
    filterSecrets(
      files.map((file) => new Map(Object.entries(file))),
      rules,
    );

  it("imports a name on the keep list", () => {
    expect(filter({ API_TOKEN: "t" }).get("API_TOKEN")).toBe("t");
  });

  // The allow-list governs on its own: a credential nobody denied is still not
  // imported unless the project asked for it.
  it("drops a name nothing denies but nothing asked for", () => {
    expect(filter({ SOME_OTHER_KEY: "x" }).has("SOME_OTHER_KEY")).toBe(false);
  });

  it.each(["DB_HOST", "STORE_KEY", "PORT", "SERVICE_URL"])("never imports %s", (name) => {
    expect(filter({ [name]: "x" }).has(name)).toBe(false);
  });

  // The never list is a pattern over the shape of a name, so it cannot tell a
  // vendor's base URL from an inter-service one. The keep list decides that,
  // which is why a name can be both listed and denied.
  it("lets the never list win over the keep list for a matching name", () => {
    expect(filter({ VENDOR_API_URL: "x" }).has("VENDOR_API_URL")).toBe(false);
  });

  it("keeps a renamed value under its new name", () => {
    const out = filter({ CLIENT_TOKEN: "c" });
    expect(out.get("PUBLIC_TOKEN")).toBe("c");
    expect(out.has("CLIENT_TOKEN")).toBe(false);
  });

  // An explicit rename is its own permission: the author named both ends of it,
  // so a pattern must not silently drop the result.
  it("lets an explicit rename outrank the never list", () => {
    expect(filter({ WIDGET_SDK_URL: "u" }).get("SANDBOXR_WIDGET_SDK_URL")).toBe("u");
  });

  it("lets a later file win", () => {
    expect(filter({ API_TOKEN: "first" }, { API_TOKEN: "second" }).get("API_TOKEN")).toBe("second");
  });

  it("imports a name that is already spelled as a rename target", () => {
    expect(filter({ PUBLIC_TOKEN: "p" }).get("PUBLIC_TOKEN")).toBe("p");
  });

  it("returns nothing for no files", () => {
    expect(filter().size).toBe(0);
  });
});

/** A config whose secrets rules and read list point at a temp directory. */
function configFor(root: string, read: string[]): ResolvedConfig {
  const config = resolveConfig(
    {
      project: "acme",
      sandboxr: ">=0.1.0",
      access: { apps: "private" },
      secrets: {
        read,
        keep: ["API_TOKEN", "VENDOR_KEY"],
        rename: { CLIENT_TOKEN: "PUBLIC_TOKEN" },
        never: ["DB_*"],
      },
    },
    join(root, "sandboxr.yaml"),
  );
  return config;
}

describe("importSecrets", () => {
  it("writes the file, reports names only, and never a value", async () => {
    const root = await mkdtemp(join(tmpdir(), "sbx-secrets-"));
    const home = join(root, "home");
    await mkdir(join(root, "svc"), { recursive: true });
    await writeFile(join(root, "svc", ".env"), "API_TOKEN=real-token\nDB_HOST=localhost\nCLIENT_TOKEN=pub\n");

    const report = await importSecrets(configFor(root, ["svc/.env"]), { env: { SANDBOXR_HOME: home } });

    expect(report.names).toEqual(["API_TOKEN", "PUBLIC_TOKEN"]);
    expect(report.count).toBe(2);
    expect(report.sources).toEqual([join(root, "svc", ".env")]);
    expect(report.missing).toEqual([]);
    expect(JSON.stringify(report)).not.toContain("real-token");

    const written = await readFile(report.file, "utf8");
    expect(written).toContain('API_TOKEN="real-token"');
    expect(written).not.toContain("DB_HOST");
  });

  it("writes the file readable only by its owner", async () => {
    const root = await mkdtemp(join(tmpdir(), "sbx-secrets-"));
    await writeFile(join(root, ".env"), "API_TOKEN=t\n");
    const report = await importSecrets(configFor(root, [".env"]), {
      env: { SANDBOXR_HOME: join(root, "home") },
    });
    expect((await stat(report.file)).mode & 0o777).toBe(0o600);
  });

  it("reports a file the config names but the developer does not have", async () => {
    const root = await mkdtemp(join(tmpdir(), "sbx-secrets-"));
    const report = await importSecrets(configFor(root, ["nowhere/.env"]), {
      env: { SANDBOXR_HOME: join(root, "home") },
    });
    expect(report.missing).toEqual([join(root, "nowhere", ".env")]);
    expect(report.count).toBe(0);
  });

  it("lets a later file override an earlier one", async () => {
    const root = await mkdtemp(join(tmpdir(), "sbx-secrets-"));
    await writeFile(join(root, "a.env"), "API_TOKEN=first\n");
    await writeFile(join(root, "b.env"), "API_TOKEN=second\n");
    const report = await importSecrets(configFor(root, ["a.env", "b.env"]), {
      env: { SANDBOXR_HOME: join(root, "home") },
    });
    expect(await readFile(report.file, "utf8")).toContain('API_TOKEN="second"');
  });
});

describe("checkSecrets", () => {
  it("reports a missing file rather than throwing", async () => {
    const root = await mkdtemp(join(tmpdir(), "sbx-check-"));
    const check = await checkSecrets(configFor(root, []), { env: { SANDBOXR_HOME: join(root, "home") } });
    expect(check.exists).toBe(false);
    expect(check.absent).toEqual(["API_TOKEN", "PUBLIC_TOKEN", "VENDOR_KEY"]);
    expect(check.present).toEqual([]);
  });

  it("separates present from absent, by name only", async () => {
    const root = await mkdtemp(join(tmpdir(), "sbx-check-"));
    const home = join(root, "home");
    await writeFile(join(root, ".env"), "API_TOKEN=t\nCLIENT_TOKEN=p\n");
    const config = configFor(root, [".env"]);
    await importSecrets(config, { env: { SANDBOXR_HOME: home } });

    const check = await checkSecrets(config, { env: { SANDBOXR_HOME: home } });
    expect(check.exists).toBe(true);
    expect(check.present).toEqual(["API_TOKEN", "PUBLIC_TOKEN"]);
    expect(check.absent).toEqual(["VENDOR_KEY"]);
  });
});

describe("importSecrets, now that the file is also edited by hand", () => {
  // The regression this exists for: `set` a key from the dashboard, then run an
  // import for an unrelated service, and the key would be gone. The old import
  // rewrote the whole file from whatever the .env files happened to hold.
  it("keeps a name it did not import", async () => {
    const root = await mkdtemp(join(tmpdir(), "sbx-merge-"));
    const home = join(root, "home");
    const config = configFor(root, [".env"]);
    await editProjectSecrets("acme", config, { set: { VENDOR_KEY: "typed-by-hand" } }, { env: { SANDBOXR_HOME: home } });

    await writeFile(join(root, ".env"), "API_TOKEN=imported\n");
    const report = await importSecrets(config, { env: { SANDBOXR_HOME: home } });

    const written = await readFile(report.file, "utf8");
    expect(written).toContain('VENDOR_KEY="typed-by-hand"');
    expect(written).toContain('API_TOKEN="imported"');
    // The report is about what this import contributed, not about what the file
    // ended up holding.
    expect(report.names).toEqual(["API_TOKEN"]);
  });

  it("still rebuilds the whole file when asked to replace it", async () => {
    const root = await mkdtemp(join(tmpdir(), "sbx-replace-"));
    const home = join(root, "home");
    const config = configFor(root, [".env"]);
    await editProjectSecrets("acme", config, { set: { VENDOR_KEY: "typed-by-hand" } }, { env: { SANDBOXR_HOME: home } });

    await writeFile(join(root, ".env"), "API_TOKEN=imported\n");
    const report = await importSecrets(config, { env: { SANDBOXR_HOME: home }, replace: true });

    expect(await readFile(report.file, "utf8")).not.toContain("VENDOR_KEY");
  });
});

describe("isReservedEnvName", () => {
  it.each(["SANDBOXR_SLUG", "SANDBOXR_DOMAIN", "SANDBOXR_PLAN", "SANDBOXR_ENV_READY"])("reserves %s", (name) => {
    expect(isReservedEnvName(name)).toBe(true);
  });

  it.each(["SANDBOXR_DB_HOST", "SANDBOXR_S3_ENDPOINT", "SANDBOXR_D1_DIR", "SANDBOXR_URL_APP", "SANDBOXR_PORT_API"])(
    "reserves the whole %s family",
    (name) => {
      expect(isReservedEnvName(name)).toBe(true);
    },
  );

  // A project's own SANDBOXR_-prefixed names are a real pattern, not an
  // accident: the example monorepo config renames a browser-side Auth0 domain to
  // SANDBOXR_AUTH0_SPA_DOMAIN precisely so it cannot be confused with the
  // server-side one. Reserving the whole prefix would have made that config
  // unimportable.
  it.each(["SANDBOXR_AUTH0_SPA_DOMAIN", "API_TOKEN", "DATABASE", "SANDBOXR_"])("leaves %s alone", (name) => {
    expect(isReservedEnvName(name)).toBe(false);
  });
});

describe("envNameRefusal", () => {
  const config = () => configFor("/nowhere", []);

  it("accepts an ordinary credential", () => {
    expect(envNameRefusal("ORQ_API_KEY", "sk-live-abcdef", config())).toBeUndefined();
  });

  it.each([
    ["a leading digit", "1_TOKEN"],
    ["a dash", "MY-TOKEN"],
    ["a dot", "MY.TOKEN"],
    ["nothing at all", ""],
  ])("refuses %s", (_why, name) => {
    expect(envNameRefusal(name, "x", config())).toMatch(/usable variable name/);
  });

  it("refuses a name the sandbox derives for itself", () => {
    expect(envNameRefusal("SANDBOXR_DB_PASSWORD", "x", config())).toMatch(/works out for itself/);
  });

  it("refuses a name matching the project's own never pattern, and names the pattern", () => {
    expect(envNameRefusal("DB_HOST", "10.0.0.1", config())).toContain('"DB_*"');
  });

  // Without a config the shape and reserved rules still hold. Only the project's
  // own patterns are unenforceable, and those exist to catch an import, where
  // nobody typed the name on purpose.
  it("still applies the rules that do not need a config", () => {
    expect(envNameRefusal("DB_HOST", "10.0.0.1", null)).toBeUndefined();
    expect(envNameRefusal("SANDBOXR_SLUG", "x", null)).toMatch(/works out for itself/);
    expect(envNameRefusal("OK_NAME", "x")).toBeUndefined();
  });

  it.each([
    ["a newline", "one\ntwo"],
    ["a carriage return", "one\rtwo"],
  ])("refuses a value containing %s", (_why, value) => {
    expect(envNameRefusal("PEM", value, config())).toMatch(/newline/);
  });
});

describe("hintFor", () => {
  it("shows the tail of a value long enough to spare it", () => {
    expect(hintFor("sk-live-0123456789ab")).toBe("89ab");
  });

  // The boundary is not arbitrary: four characters of a short value is most of
  // it, and the hint exists to tell two keys apart rather than to reconstruct
  // one.
  it.each([
    ["exactly at the boundary", "123456789012", "9012"],
    ["one short of it", "12345678901", undefined],
    ["empty", "", undefined],
  ])("%s", (_why, value, want) => {
    expect(hintFor(value)).toBe(want);
  });
});

describe("describeProjectSecrets", () => {
  const home = async () => join(await mkdtemp(join(tmpdir(), "sbx-view-")), "home");

  it("reports an absent file as absent rather than throwing", async () => {
    const view = await describeProjectSecrets("acme", null, { env: { SANDBOXR_HOME: await home() } });
    expect(view.exists).toBe(false);
    expect(view.vars).toEqual([]);
  });

  it("carries names, a hint and a length — and no value anywhere", async () => {
    const env = { SANDBOXR_HOME: await home() };
    const config = configFor("/nowhere", []);
    await editProjectSecrets("acme", config, { set: { API_TOKEN: "sk-live-0123456789ab", SHORT: "abc" } }, { env });

    const view = await describeProjectSecrets("acme", config, { env });
    expect(view.vars).toEqual([
      { name: "API_TOKEN", hint: "89ab", chars: 20 },
      { name: "SHORT", chars: 3 },
    ]);
    expect(JSON.stringify(view)).not.toContain("sk-live-0123456789ab");
  });

  // The panel's most valuable output. A front-end built without its API key does
  // not fail — it falls back to whatever its code defaults to, which for a real
  // project we looked at is a production URL.
  it("names what the project declares and the file does not have", async () => {
    const env = { SANDBOXR_HOME: await home() };
    const config = configFor("/nowhere", []);
    await editProjectSecrets("acme", config, { set: { API_TOKEN: "t" } }, { env });

    const view = await describeProjectSecrets("acme", config, { env });
    expect(view.absent).toEqual(["PUBLIC_TOKEN", "VENDOR_KEY"]);
    expect(view.configKnown).toBe(true);
  });

  // The `env:` map is exported last inside the container, so a credential typed
  // under a name the map already claims is simply overwritten. Nothing fails and
  // the variable has a value — the wrong one. A real project's map runs to forty
  // names, so this is not a corner case.
  it("names a variable the project's env map will overwrite", async () => {
    const env = { SANDBOXR_HOME: await home() };
    const config = resolveConfig(
      {
        project: "acme",
        sandboxr: ">=0.1.0",
        access: { apps: "private" },
        env: { DB_HOST: "${SANDBOXR_DB_HOST}" },
      },
      "/nowhere/sandboxr.yaml",
    );
    await editProjectSecrets("acme", config, { set: { DB_HOST: "10.0.0.1", API_TOKEN: "t" } }, { env });

    const view = await describeProjectSecrets("acme", config, { env });
    expect(view.shadowed).toEqual(["DB_HOST"]);
  });

  it("shadows nothing when it had no config to compare against", async () => {
    const env = { SANDBOXR_HOME: await home() };
    await editProjectSecrets("acme", null, { set: { DB_HOST: "10.0.0.1" } }, { env });
    expect((await describeProjectSecrets("acme", null, { env })).shadowed).toEqual([]);
  });

  it("says so when it had no config, rather than presenting a guess", async () => {
    const view = await describeProjectSecrets("acme", null, { env: { SANDBOXR_HOME: await home() } });
    expect(view.configKnown).toBe(false);
    expect(view.absent).toEqual([]);
    // Permissive: refusing to let somebody edit because a config could not be
    // read would turn an unreadable config into a locked dashboard, and `up`
    // still enforces the real rule.
    expect(view.editable).toBe(true);
  });

  it("is not editable for a public project that has not opted in", async () => {
    const config = resolveConfig(
      { project: "acme", sandboxr: ">=0.1.0", access: { apps: "public" } },
      "/nowhere/sandboxr.yaml",
    );
    const view = await describeProjectSecrets("acme", config, { env: { SANDBOXR_HOME: await home() } });
    expect(view.editable).toBe(false);
  });
});

describe("revealProjectSecret", () => {
  it("is the one function that answers with a value", async () => {
    const env = { SANDBOXR_HOME: join(await mkdtemp(join(tmpdir(), "sbx-reveal-")), "home") };
    await editProjectSecrets("acme", null, { set: { API_TOKEN: "real-token" } }, { env });

    expect(await revealProjectSecret("acme", "API_TOKEN", env ? { env } : {})).toBe("real-token");
    expect(await revealProjectSecret("acme", "NOT_SET", { env })).toBeUndefined();
  });
});

describe("editProjectSecrets", () => {
  const fresh = async () => ({ env: { SANDBOXR_HOME: join(await mkdtemp(join(tmpdir(), "sbx-edit-")), "home") } });

  it("adds, updates and removes, and says which it did", async () => {
    const options = await fresh();
    await editProjectSecrets("acme", null, { set: { A: "1", B: "2" } }, options);

    const report = await editProjectSecrets("acme", null, { set: { B: "two", C: "3" }, unset: ["A"] }, options);
    expect(report.added).toEqual(["C"]);
    expect(report.updated).toEqual(["B"]);
    expect(report.removed).toEqual(["A"]);
    expect(report.vars.map((entry) => entry.name)).toEqual(["B", "C"]);
  });

  it("does not claim to have removed a name that was not there", async () => {
    const options = await fresh();
    expect((await editProjectSecrets("acme", null, { unset: ["NEVER_SET"] }, options)).removed).toEqual([]);
  });

  it("writes the file readable only by its owner", async () => {
    const options = await fresh();
    const report = await editProjectSecrets("acme", null, { set: { A: "1" } }, options);
    expect((await stat(report.file)).mode & 0o777).toBe(0o600);
  });

  // A pasted .env is the case that decides this. One bad line in a file of
  // twenty good names must not lose the other nineteen, or the only way to find
  // the offending line is to bisect your own paste.
  it("applies the good names beside a refused one", async () => {
    const options = await fresh();
    const report = await editProjectSecrets(
      "acme",
      configFor("/nowhere", []),
      { text: "API_TOKEN=good\nDB_HOST=10.0.0.1\nSANDBOXR_DB_PASSWORD=x\nVENDOR_KEY=also-good\n" },
      options,
    );

    expect(report.vars.map((entry) => entry.name)).toEqual(["API_TOKEN", "VENDOR_KEY"]);
    expect(report.refused.map((entry) => entry.name)).toEqual(["DB_HOST", "SANDBOXR_DB_PASSWORD"]);
    expect(report.refused[0]?.reason).toContain('"DB_*"');
  });

  // A pasted file is the coarse statement and a typed field is the specific one.
  it("lets a typed name win over a pasted one, and a removal win over both", async () => {
    const options = await fresh();
    const report = await editProjectSecrets(
      "acme",
      null,
      { text: "A=from-text\nB=from-text\n", set: { A: "from-set" }, unset: ["B"] },
      options,
    );
    expect(await readFile(report.file, "utf8")).toContain('A="from-set"');
    expect(report.vars.map((entry) => entry.name)).toEqual(["A"]);
  });

  it("never carries a value in its report", async () => {
    const options = await fresh();
    const report = await editProjectSecrets("acme", null, { set: { API_TOKEN: "real-token" } }, options);
    expect(JSON.stringify(report)).not.toContain("real-token");
  });

  // Written raw, these did not survive being read back: parseEnvFile strips a
  // trailing ` #` from an unquoted value, so a password containing one came back
  // truncated at the hash with nothing reporting it. Hence quoteSecret.
  it.each([
    ["an equals sign, a hash and a dollar", "a=b # c $(id) ${HOME}"],
    ["surrounding spaces", "  padded  "],
    ["quotes of its own", 'he said "hi"'],
    ["nothing but a quote", '"'],
    ["a leading quote and no closing one", '"abc'],
    ["a single-quoted look-alike", "'abc'"],
    ["a trailing backslash", "abc\\"],
  ])("round-trips a value with %s in it", async (_why, awkward) => {
    const options = await fresh();
    // Not a shell: `$(id)` has to come back as the six characters it is. The
    // container reads this file without evaluating it for the same reason.
    await editProjectSecrets("acme", null, { set: { AWKWARD: awkward } }, options);
    expect(await revealProjectSecret("acme", "AWKWARD", options)).toBe(awkward);
  });
});

describe("envDigest", () => {
  it("does not depend on the order names were added in", () => {
    const one = new Map([
      ["A", "1"],
      ["B", "2"],
    ]);
    const other = new Map([
      ["B", "2"],
      ["A", "1"],
    ]);
    expect(envDigest(one)).toBe(envDigest(other));
  });

  it("changes when a value changes", () => {
    expect(envDigest(new Map([["A", "1"]]))).not.toBe(envDigest(new Map([["A", "2"]])));
  });

  // Both halves of the environment, because a renamed VITE_* in sandboxr.yaml
  // and a rotated key are the same problem to whoever has to press the button.
  it("changes when the plan's env map changes", () => {
    const secrets = new Map([["A", "1"]]);
    expect(envDigest(secrets, { VITE_API: "${SANDBOXR_URL_API}" })).not.toBe(
      envDigest(secrets, { VITE_API: "${SANDBOXR_URL_WWW}" }),
    );
  });

  // Two maps that differ only in where a name ends and a value begins must not
  // collide, which a naive concatenation would allow.
  it("does not collide on a name and value that could be split two ways", () => {
    expect(envDigest(new Map([["AB", "C"]]))).not.toBe(envDigest(new Map([["A", "BC"]])));
  });

  it("is short enough for a label and stable in shape", () => {
    expect(envDigest(new Map([["A", "1"]]))).toMatch(/^[0-9a-f]{16}$/);
  });
});
