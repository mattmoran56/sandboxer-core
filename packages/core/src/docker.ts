/**
 * A thin typed wrapper over the docker CLI.
 *
 * Two rules, both load-bearing:
 *
 * - **Arguments are arrays, never shell strings.** Slugs, branch names and
 *   project names reach these calls from a browser by way of the dashboard, so
 *   there is deliberately no code path where a name can become shell syntax.
 * - **Every call is injectable.** `createDocker` takes the process runner, so
 *   the lifecycle can be tested against a recorded transcript instead of a
 *   running daemon. Nothing in this package spawns a process except through
 *   here.
 */

import { execFile } from "node:child_process";
import { spawn } from "node:child_process";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export class DockerError extends Error {
  override readonly name = "DockerError";
  readonly result: ExecResult;
  readonly args: string[];

  constructor(args: string[], result: ExecResult) {
    const detail = (result.stderr || result.stdout).trim().split("\n").slice(0, 6).join("\n");
    super(`docker ${args.join(" ")} exited ${result.code}${detail ? `:\n${detail}` : ""}`);
    this.result = result;
    this.args = args;
  }
}

/** Runs one process and collects its output. The only seam onto the OS. */
export type Runner = (
  bin: string,
  args: string[],
  options?: { input?: string | undefined; timeoutMs?: number | undefined },
) => Promise<ExecResult>;

const MAX_BUFFER = 256 * 1024 * 1024;

export const nodeRunner: Runner = (bin, args, options = {}) =>
  new Promise((resolveResult) => {
    const child = execFile(
      bin,
      args,
      { maxBuffer: MAX_BUFFER, timeout: options.timeoutMs ?? 0, encoding: "utf8" },
      (error, stdout, stderr) => {
        // A non-zero exit is data here, not an exception: several callers ask a
        // question whose answer is "no" — `docker inspect` on a container that
        // does not exist — and a throw would make every one of them a try/catch.
        const code =
          error && typeof (error as NodeJS.ErrnoException & { code?: number }).code === "number"
            ? ((error as unknown as { code: number }).code ?? 1)
            : error
              ? 1
              : 0;
        resolveResult({ code, stdout, stderr });
      },
    );
    if (options.input !== undefined) {
      child.stdin?.end(options.input);
    }
  });

export interface ContainerRow {
  name: string;
  id: string;
  state: string;
  labels: Record<string, string>;
}

export interface Docker {
  /** Runs docker with these arguments and returns the result, whatever it is. */
  raw(args: string[], options?: { input?: string | undefined; timeoutMs?: number | undefined }): Promise<ExecResult>;
  /** As `raw`, but a non-zero exit throws a DockerError. */
  ok(args: string[], options?: { input?: string | undefined; timeoutMs?: number | undefined }): Promise<ExecResult>;
  /** Whether the daemon answers. */
  available(): Promise<boolean>;
  /** Containers matching a label filter, with their labels parsed. */
  ps(filters: string[], options?: { all?: boolean }): Promise<ContainerRow[]>;
  inspect(name: string): Promise<unknown | undefined>;
  containerExists(name: string): Promise<boolean>;
  containerRunning(name: string): Promise<boolean>;
  labels(name: string): Promise<Record<string, string>>;
  exec(name: string, cmd: string[], options?: { workdir?: string; env?: Record<string, string> }): Promise<ExecResult>;
  /** Replaces this process with an interactive `docker exec`. Never returns. */
  execInteractive(name: string, cmd: string[], options?: { workdir?: string }): Promise<number>;
  logs(name: string, options?: { tail?: number; follow?: boolean }): Promise<ExecResult>;
  /**
   * Streams a container's log to this process until it stops.
   *
   * Separate from `logs` because a followed log has no end: buffering it would
   * hold every line in memory and print none of them until the container died.
   */
  logsFollow(name: string, options?: { tail?: number }): Promise<number>;
  rm(name: string, options?: { force?: boolean }): Promise<void>;
  volumes(prefix: string): Promise<string[]>;
  volumeRm(name: string): Promise<boolean>;
  ensureNetwork(name: string): Promise<void>;
  imageExists(reference: string): Promise<boolean>;
  /** Copies a host file into a container. */
  cp(from: string, toContainer: string, toPath: string): Promise<void>;
}

const JSON_FORMAT = "{{json .}}";

export function createDocker(run: Runner = nodeRunner, bin = "docker"): Docker {
  const raw: Docker["raw"] = (args, options) => run(bin, args, options);

  const ok: Docker["ok"] = async (args, options) => {
    const result = await raw(args, options);
    if (result.code !== 0) throw new DockerError(args, result);
    return result;
  };

  const inspectField = async (args: string[]): Promise<string | undefined> => {
    const result = await raw(args);
    if (result.code !== 0) return undefined;
    return result.stdout.trim();
  };

  return {
    raw,
    ok,

    async available() {
      return (await raw(["info", "--format", "{{.ServerVersion}}"])).code === 0;
    },

    async ps(filters, options = {}) {
      const args = ["ps"];
      if (options.all !== false) args.push("-a");
      for (const filter of filters) args.push("--filter", filter);
      args.push("--format", JSON_FORMAT);
      const result = await raw(args);
      if (result.code !== 0) throw new DockerError(args, result);
      return parsePsJson(result.stdout);
    },

    async inspect(name) {
      const result = await raw(["inspect", name]);
      if (result.code !== 0) return undefined;
      try {
        const parsed = JSON.parse(result.stdout) as unknown[];
        return parsed[0];
      } catch {
        return undefined;
      }
    },

    async containerExists(name) {
      return (await raw(["inspect", "--type", "container", name])).code === 0;
    },

    async containerRunning(name) {
      return (await inspectField(["inspect", "-f", "{{.State.Running}}", name])) === "true";
    },

    async labels(name) {
      // One `printf` per label rather than JSON, because a label value can
      // contain any character a branch name can and the template is the only
      // form that survives it intact.
      const format = "{{range $k, $v := .Config.Labels}}{{$k}}={{$v}}\n{{end}}";
      const out = await inspectField(["inspect", "-f", format, name]);
      return out === undefined ? {} : parseLabelLines(out);
    },

    async exec(name, cmd, options = {}) {
      const args = ["exec"];
      if (options.workdir) args.push("-w", options.workdir);
      for (const [key, value] of Object.entries(options.env ?? {})) args.push("-e", `${key}=${value}`);
      args.push(name, ...cmd);
      return raw(args);
    },

    async execInteractive(name, cmd, options = {}) {
      const args = ["exec", "-it"];
      if (options.workdir) args.push("-w", options.workdir);
      args.push(name, ...cmd);
      return new Promise((resolveCode) => {
        const child = spawn(bin, args, { stdio: "inherit" });
        child.on("exit", (code) => resolveCode(code ?? 0));
        child.on("error", () => resolveCode(1));
      });
    },

    async logs(name, options = {}) {
      const args = ["logs"];
      if (options.tail !== undefined) args.push("--tail", String(options.tail));
      if (options.follow) args.push("-f");
      args.push(name);
      return raw(args);
    },

    async logsFollow(name, options = {}) {
      const args = ["logs", "-f"];
      if (options.tail !== undefined) args.push("--tail", String(options.tail));
      args.push(name);
      return new Promise((resolveCode) => {
        // stdin is ignored rather than inherited: nothing reads it, and holding
        // it open stops the parent shell noticing that the pipe has closed.
        const child = spawn(bin, args, { stdio: ["ignore", "inherit", "inherit"] });
        child.on("exit", (code) => resolveCode(code ?? 0));
        child.on("error", () => resolveCode(1));
      });
    },

    async rm(name, options = {}) {
      const args = ["rm"];
      if (options.force !== false) args.push("-f");
      args.push(name);
      await raw(args);
    },

    async volumes(prefix) {
      const result = await raw(["volume", "ls", "--filter", `name=${prefix}`, "--format", "{{.Name}}"]);
      if (result.code !== 0) return [];
      return result.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "");
    },

    async volumeRm(name) {
      return (await raw(["volume", "rm", name])).code === 0;
    },

    async ensureNetwork(name) {
      if ((await raw(["network", "inspect", name])).code === 0) return;
      await ok(["network", "create", name]);
    },

    async imageExists(reference) {
      return (await raw(["image", "inspect", reference])).code === 0;
    },

    async cp(from, toContainer, toPath) {
      await ok(["cp", from, `${toContainer}:${toPath}`]);
    },
  };
}

/**
 * Parses `docker ps --format {{json .}}`, which emits one JSON object per line.
 *
 * Labels arrive as a comma-separated `k=v` string. A value containing a comma
 * would be ambiguous in that encoding, so the label reader used for state
 * (`labels()`) goes through `docker inspect` instead; this parse exists to keep
 * `list` a single call.
 */
export function parsePsJson(stdout: string): ContainerRow[] {
  const rows: ContainerRow[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    let parsed: { Names?: string; ID?: string; State?: string; Status?: string; Labels?: string };
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    rows.push({
      name: parsed.Names ?? "",
      id: parsed.ID ?? "",
      state: parsed.State ?? deriveStateFromStatus(parsed.Status ?? ""),
      labels: parseLabelPairs(parsed.Labels ?? ""),
    });
  }
  return rows;
}

/** Older docker clients report only a human `Status` string. */
function deriveStateFromStatus(status: string): string {
  const lower = status.toLowerCase();
  if (lower.startsWith("up")) return "running";
  if (lower.startsWith("exited") || lower.startsWith("dead")) return "exited";
  if (lower.startsWith("created")) return "created";
  if (lower.startsWith("restarting")) return "restarting";
  return lower.split(" ")[0] ?? "";
}

export function parseLabelPairs(labels: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of labels.split(",")) {
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    out[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return out;
}

export function parseLabelLines(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    if (line === "") continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    out[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return out;
}

/** The default instance, backed by the docker CLI on PATH. */
export const docker: Docker = createDocker();
