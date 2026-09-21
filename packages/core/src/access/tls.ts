/**
 * The certificate the router serves. One, for the whole machine.
 *
 * **A TLS wildcard matches exactly one label**, and `*.*.example.com` is not a
 * valid certificate name — mkcert refuses it outright
 * (`"*.*.example" is not a valid hostname`), producing no certificate at all and
 * a router that quietly falls back to plain http.
 *
 * That is a fact about TLS and not about DNS, and the two were confused here for
 * a long time. A *DNS* wildcard does match more than one label — RFC 4592's
 * closest-encloser rule, which Cloudflare and Route 53 both document — so the
 * old `<slug>.<label>.<project>.<domain>` resolved perfectly well and only the
 * certificate could not be written. The answer then was a certificate per
 * sandbox, with its hostnames listed, issued on `up` and discarded on `down`.
 *
 * Contracts §3.2 now flattens a sandbox hostname into a single label
 * (`<slug>--<label>--<project>.<domain>`), so the `*.<domain>` already on the
 * base certificate covers every sandbox that will ever exist. The whole
 * per-sandbox mechanism is gone: no `sandboxCertificateNames`, no issue on
 * `up`, no discard on `down`, and nothing for two sandboxes starting at once to
 * race over.
 *
 * mkcert is the only issuer supported, because it is the only one that can make
 * a browser trust a local name without a public DNS record. It is optional:
 * without it the router serves plain http, which is a smaller thing to get
 * working and an honest first milestone.
 */

import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

import { nodeRunner, type Runner } from "../docker.js";
import { paths } from "../paths.js";

export interface Certificate {
  /** The name this certificate is filed under, which is also its file stem. */
  name: string;
  certFile: string;
  keyFile: string;
  /** Whether a browser on this machine will accept it without a warning. */
  trusted: boolean;
}

export interface TlsOptions {
  run?: Runner | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  platform?: NodeJS.Platform | undefined;
}

/**
 * The names the one certificate carries.
 *
 * The domain itself, for whatever a product puts on the bare domain, and one
 * wildcard under it — which since hostnames were flattened to a single label is
 * every sandbox hostname on the machine as well. Nothing sandboxr serves is deeper than this, and nothing may
 * become deeper without bringing back a certificate per sandbox.
 */
export function baseCertificateNames(domain: string): string[] {
  return [domain, `*.${domain}`, "localhost", "127.0.0.1", "::1"];
}

/** Whether mkcert is installed and runnable. */
export async function mkcertAvailable(run: Runner = nodeRunner): Promise<boolean> {
  return (await run("mkcert", ["-CAROOT"])).code === 0;
}

async function caRootOf(run: Runner): Promise<string | undefined> {
  const result = await run("mkcert", ["-CAROOT"]);
  if (result.code !== 0) return undefined;
  const root = result.stdout.trim();
  return root === "" ? undefined : root;
}

/**
 * Whether this machine's trust store already accepts mkcert's root.
 *
 * Asked rather than assumed, because installing that root is the one step in the
 * whole setup that needs an administrator password. Knowing the answer is what
 * lets `init` fall back to plain http and print the single command that upgrades
 * it, instead of serving a certificate every browser refuses.
 */
export async function caTrusted(options: TlsOptions = {}): Promise<boolean> {
  const run = options.run ?? nodeRunner;
  const platform = options.platform ?? process.platform;
  const root = await caRootOf(run);
  if (!root) return false;

  const rootCert = join(root, "rootCA.pem");
  if (!existsSync(rootCert)) return false;

  if (platform === "darwin") {
    return (await run("security", ["verify-cert", "-c", rootCert])).code === 0;
  }
  // Elsewhere the honest answer is "the root exists and mkcert manages it".
  // There is no portable query, and claiming otherwise would make the fallback
  // fire on a machine that is already set up.
  return true;
}

/**
 * Issues a certificate, or reuses the one already filed under this name.
 *
 * Reused when it is there and already covers what was asked for: re-issuing on
 * every start would invalidate the copy a running browser has pinned, for no
 * gain. The manifest beside the certificate is what makes "already covers" a
 * question that can be answered without parsing X.509.
 */
export async function issueCertificate(
  name: string,
  hosts: readonly string[],
  options: TlsOptions = {},
): Promise<Certificate | undefined> {
  const run = options.run ?? nodeRunner;
  const env = options.env ?? process.env;
  if (hosts.length === 0) return undefined;
  if (!(await mkcertAvailable(run))) return undefined;

  const dir = paths(env).tls;
  await mkdir(dir, { recursive: true });
  const certFile = join(dir, `${name}.pem`);
  const keyFile = join(dir, `${name}-key.pem`);
  const manifest = join(dir, `${name}.hosts`);
  const wanted = `${[...hosts].sort().join("\n")}\n`;

  const current = existsSync(manifest) ? await readTextOrEmpty(manifest) : "";
  if (!existsSync(certFile) || !existsSync(keyFile) || current !== wanted) {
    const result = await run("mkcert", ["-cert-file", certFile, "-key-file", keyFile, ...hosts]);
    // mkcert exits zero when it rejects a name, so its output is the only
    // signal. Without this check a rejected name produces no certificate and
    // the router silently drops to plain http.
    if (result.code !== 0 || !existsSync(certFile)) return undefined;
    await writeFile(manifest, wanted);
  }

  return { name, certFile, keyFile, trusted: await caTrusted(options) };
}

async function readTextOrEmpty(path: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

/** Removes a certificate and its manifest. */
export async function discardCertificate(name: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const dir = paths(env).tls;
  for (const file of [`${name}.pem`, `${name}-key.pem`, `${name}.hosts`]) {
    await rm(join(dir, file), { force: true });
  }
}

/**
 * Writes the router's entry for one certificate.
 *
 * One file per certificate rather than one file listing them all, so a sandbox
 * starting or stopping rewrites only its own — two of them racing cannot lose
 * each other's entry.
 */
export async function writeCertificateEntry(
  dynamicDir: string,
  cert: Certificate,
  mountedAt: string,
  options: { isDefault?: boolean } = {},
): Promise<string> {
  await mkdir(dynamicDir, { recursive: true });
  const path = join(dynamicDir, `cert-${cert.name}.yml`);
  const certPath = `${mountedAt}/${basename(cert.certFile)}`;
  const keyPath = `${mountedAt}/${basename(cert.keyFile)}`;

  await writeFile(
    path,
    [
      "# Generated by sandboxr. Edits are lost on the next run.",
      "tls:",
      ...(options.isDefault
        ? ["  stores:", "    default:", "      defaultCertificate:", `        certFile: ${certPath}`, `        keyFile: ${keyPath}`]
        : []),
      "  certificates:",
      `    - certFile: ${certPath}`,
      `      keyFile: ${keyPath}`,
      "",
    ].join("\n"),
  );
  return path;
}

/** Removes a certificate's router entry. */
export async function discardCertificateEntry(dynamicDir: string, name: string): Promise<void> {
  await rm(join(dynamicDir, `cert-${name}.yml`), { force: true });
}
