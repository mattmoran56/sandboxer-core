// Tests for the secrets import filter and its report:
// - parseEnvFile: quotes, trailing comments, `export `, blanks, comments, empty values, CRLF, an `=` inside a value
// - matchesAny: prefix, suffix and exact glob patterns; a literal dot is not a wildcard
// - filterSecrets: the keep allow-list governs; an unlisted name is dropped even though nothing denies it
// - filterSecrets: the never list rejects location variables; a later file wins; rename outranks never
// - filterSecrets: a rename target is kept under its new name, and the source name does not survive
// - importSecrets: names only in the report, the file is 0600, missing sources reported rather than fatal
// - checkSecrets: presence only, rename targets counted, an absent file reported as absent

import { readFile, stat, mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveConfig } from "./config/load.js";
import type { ResolvedConfig } from "./config/types.js";
import { checkSecrets, filterSecrets, importSecrets, matchesAny, parseEnvFile } from "./secrets.js";

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
    expect(written).toContain("API_TOKEN=real-token");
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
    expect(await readFile(report.file, "utf8")).toContain("API_TOKEN=second");
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
