import { describe, expect, it } from "vitest";

// Tests for the machine's one certificate:
// - baseCertificateNames: the domain, one wildcard under it, and nothing deeper
// - baseCertificateNames: that the one wildcard really does cover a flattened sandbox hostname
// - mkcertAvailable / caTrusted: how the fall back to plain http is decided

import { hostFor } from "../naming.js";
import { baseCertificateNames, caTrusted, mkcertAvailable } from "./tls.js";
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

describe("baseCertificateNames", () => {
  it("covers the domain and one level under it, and nothing deeper", () => {
    const names = baseCertificateNames("sbx.localhost");
    expect(names).toContain("sbx.localhost");
    expect(names).toContain("*.sbx.localhost");
    // Deliberately absent: mkcert rejects a multi-level wildcard outright, and
    // asking for one produces no certificate at all rather than a partial one.
    expect(names.some((name) => name.startsWith("*.*"))).toBe(false);
  });

  it("includes localhost itself, so the router answers before a domain is set up", () => {
    expect(baseCertificateNames("d")).toContain("localhost");
    expect(baseCertificateNames("d")).toContain("127.0.0.1");
  });
});

// The whole reason for flattening a sandbox hostname to one label: a TLS
// wildcard covers exactly one, so this assertion is what replaced a certificate
// per sandbox. If it ever fails, the per-sandbox machinery has to come back.
describe("the wildcard and a sandbox hostname", () => {
  it("covers every hostname a sandbox answers on", () => {
    const domain = "sbx.localhost";
    const host = hostFor({ slug: "tkt-1", label: "admin-api", project: "acme", domain });
    expect(baseCertificateNames(domain)).toContain(`*.${domain}`);
    // What `*.<domain>` means: exactly one label above the domain.
    expect(host.slice(0, -(domain.length + 1))).not.toContain(".");
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
