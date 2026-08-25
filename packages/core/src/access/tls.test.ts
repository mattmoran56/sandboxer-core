import { describe, expect, it } from "vitest";

import { caTrusted, certificateNames, mkcertAvailable } from "./tls.js";
import type { ExecResult, Runner } from "../docker.js";

const ok = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });
const fail = (): ExecResult => ({ code: 1, stdout: "", stderr: "not found" });

/** A runner that answers from a table and records what it was asked. */
function fakeRunner(table: Record<string, ExecResult>): Runner & { calls: string[][] } {
  const calls: string[][] = [];
  const run = (async (bin: string, args: string[]) => {
    calls.push([bin, ...args]);
    return table[`${bin} ${args[0] ?? ""}`] ?? fail();
  }) as Runner & { calls: string[][] };
  run.calls = calls;
  return run;
}

describe("certificateNames", () => {
  it("carries a wildcard for every depth a sandbox hostname reaches", () => {
    const names = certificateNames("sbx.localhost");
    // <slug>.<label>.<project>.<domain> is three labels above the domain, and a
    // wildcard matches exactly one — so all three depths have to be present or
    // the certificate validates for the dashboard and fails for every sandbox.
    expect(names).toContain("sbx.localhost");
    expect(names).toContain("*.sbx.localhost");
    expect(names).toContain("*.*.sbx.localhost");
    expect(names).toContain("*.*.*.sbx.localhost");
  });

  it("includes localhost itself, so the router answers before a domain is set up", () => {
    expect(certificateNames("d")).toContain("localhost");
    expect(certificateNames("d")).toContain("127.0.0.1");
  });
});

describe("mkcertAvailable", () => {
  it("is true when mkcert answers and false when it does not", async () => {
    expect(await mkcertAvailable(fakeRunner({ "mkcert -CAROOT": ok("/root\n") }))).toBe(true);
    expect(await mkcertAvailable(fakeRunner({}))).toBe(false);
  });
});

describe("caTrusted", () => {
  it("is false without mkcert, whatever the platform", async () => {
    expect(await caTrusted({ run: fakeRunner({}), platform: "darwin" })).toBe(false);
    expect(await caTrusted({ run: fakeRunner({}), platform: "linux" })).toBe(false);
  });

  it("is false when the root store exists but holds no root certificate", async () => {
    const run = fakeRunner({ "mkcert -CAROOT": ok("/definitely/not/here\n") });
    expect(await caTrusted({ run, platform: "linux" })).toBe(false);
  });
});
