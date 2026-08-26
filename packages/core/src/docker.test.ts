// Tests for the docker CLI wrapper:
// - every call is an argument array, and a name that looks like shell syntax is passed through untouched
// - raw returns a non-zero exit as data; ok turns it into a DockerError that quotes the daemon
// - DockerError quotes the *end* of both streams, so a legacy build's error survives its deprecation notice
// - archBuildArgs: the mapping onto docker's spelling, and silence for an architecture it does not know
// - ps: label filters, the JSON-per-line format, an unparseable line, a state derived from Status
// - labels: the inspect template form, values containing commas and equals signs
// - containerExists / containerRunning / available: the exit code and field each reads
// - volumes / volumeRm / ensureNetwork / imageExists: the arguments and the answers
// - parseLabelPairs and parseLabelLines: pairs, empty input, a missing separator

import { describe, expect, it } from "vitest";

import {
  DockerError,
  archBuildArgs,
  createDocker,
  parseLabelLines,
  parseLabelPairs,
  parsePsJson,
  type Runner,
} from "./docker.js";

interface Call {
  bin: string;
  args: string[];
  input?: string | undefined;
}

/** A runner that records what it was asked and replies from a table. */
function recorder(replies: Array<Partial<{ code: number; stdout: string; stderr: string }>> = []) {
  const calls: Call[] = [];
  let index = 0;
  const run: Runner = async (bin, args, options) => {
    calls.push({ bin, args, input: options?.input });
    const reply = replies[index++] ?? {};
    return { code: reply.code ?? 0, stdout: reply.stdout ?? "", stderr: reply.stderr ?? "" };
  };
  return { calls, run };
}

describe("createDocker", () => {
  it("passes arguments as an array, so a name can never become shell syntax", async () => {
    const { calls, run } = recorder();
    await createDocker(run).exec("sandboxr-p-s", ["sh", "-c", "echo hi; rm -rf /"]);
    expect(calls[0]?.args).toEqual(["exec", "sandboxr-p-s", "sh", "-c", "echo hi; rm -rf /"]);
  });

  it("returns a non-zero exit as data", async () => {
    const { run } = recorder([{ code: 1, stderr: "No such object" }]);
    const result = await createDocker(run).raw(["inspect", "nope"]);
    expect(result).toEqual({ code: 1, stdout: "", stderr: "No such object" });
  });

  it("turns a non-zero exit into a DockerError that quotes the daemon", async () => {
    const { run } = recorder([{ code: 125, stderr: "port is already allocated" }]);
    await expect(createDocker(run).ok(["run", "x"])).rejects.toThrow(DockerError);
    const { run: run2 } = recorder([{ code: 125, stderr: "port is already allocated" }]);
    await expect(createDocker(run2).ok(["run", "x"])).rejects.toThrow(/port is already allocated/);
  });

  it("quotes the end of the output, not the deprecation notice the legacy builder opens with", async () => {
    // The exact shape of a failed `docker build` without buildx: one line on
    // stderr, the whole build — error included — on stdout. Reporting stderr
    // alone told the reader the builder was deprecated and nothing else.
    const stderr = "DEPRECATED: The legacy builder is deprecated and will be removed in a future release.";
    const stdout = ["Step 4/9 : RUN set -eux; ...", "unsupported arch ", "The command '/bin/sh -c ...' returned 1"].join(
      "\n",
    );
    const { run } = recorder([{ code: 1, stdout, stderr }]);
    const error = await createDocker(run)
      .ok(["build", "-t", "sandboxr/acme:abc", "/tmp/ctx"])
      .then(
        () => undefined,
        (thrown: unknown) => thrown as DockerError,
      );
    expect(error?.message).toContain("unsupported arch");
    expect(error?.message).toContain("returned 1");
    // The notice is still there — it is one line of context, not the headline.
    expect(error?.message).toContain("DEPRECATED");
  });

  it("does not repeat a line both streams carried", async () => {
    const { run } = recorder([{ code: 1, stdout: "boom", stderr: "boom" }]);
    const error = await createDocker(run)
      .ok(["build", "x"])
      .then(
        () => undefined,
        (thrown: unknown) => thrown as DockerError,
      );
    expect(error?.message.match(/boom/g)).toHaveLength(1);
  });

  it("asks the daemon for its version to decide whether it is available", async () => {
    const { calls, run } = recorder([{ code: 0, stdout: "27.0\n" }]);
    expect(await createDocker(run).available()).toBe(true);
    expect(calls[0]?.args).toEqual(["info", "--format", "{{.ServerVersion}}"]);
  });

  it("reports the daemon as unavailable on a non-zero exit", async () => {
    const { run } = recorder([{ code: 1 }]);
    expect(await createDocker(run).available()).toBe(false);
  });

  it("filters ps by label and asks for JSON", async () => {
    const { calls, run } = recorder([
      {
        stdout: [
          '{"Names":"sandboxr-p-a","ID":"aaa","State":"running","Labels":"sandboxr.slug=a,sandboxr.project=p"}',
          '{"Names":"sandboxr-p-b","ID":"bbb","State":"exited","Labels":"sandboxr.slug=b"}',
        ].join("\n"),
      },
    ]);
    const rows = await createDocker(run).ps(["label=sandboxr.slug"]);
    expect(calls[0]?.args).toEqual(["ps", "-a", "--filter", "label=sandboxr.slug", "--format", "{{json .}}"]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      name: "sandboxr-p-a",
      id: "aaa",
      state: "running",
      labels: { "sandboxr.slug": "a", "sandboxr.project": "p" },
    });
  });

  it("throws when ps itself fails, rather than reporting no sandboxes", async () => {
    const { run } = recorder([{ code: 1, stderr: "Cannot connect to the Docker daemon" }]);
    await expect(createDocker(run).ps(["label=x"])).rejects.toThrow(DockerError);
  });

  it("reads labels through an inspect template, which survives a comma in a value", async () => {
    const { calls, run } = recorder([{ stdout: "sandboxr.branch=feat/a,b\nsandboxr.slug=s\n" }]);
    const labels = await createDocker(run).labels("sandboxr-p-s");
    expect(calls[0]?.args[1]).toBe("-f");
    expect(labels).toEqual({ "sandboxr.branch": "feat/a,b", "sandboxr.slug": "s" });
  });

  it("returns no labels for a container that does not exist", async () => {
    const { run } = recorder([{ code: 1 }]);
    expect(await createDocker(run).labels("ghost")).toEqual({});
  });

  it.each([
    ["true\n", true],
    ["false\n", false],
  ])("reads the running state from %s", async (stdout, want) => {
    const { run } = recorder([{ stdout }]);
    expect(await createDocker(run).containerRunning("x")).toBe(want);
  });

  it("treats a failed inspect as not running", async () => {
    const { run } = recorder([{ code: 1 }]);
    expect(await createDocker(run).containerRunning("x")).toBe(false);
  });

  it("lists volumes by prefix and drops blank lines", async () => {
    const { calls, run } = recorder([{ stdout: "sandboxr-data-p-a\n\nsandboxr-www-p-a\n" }]);
    expect(await createDocker(run).volumes("sandboxr-")).toEqual(["sandboxr-data-p-a", "sandboxr-www-p-a"]);
    expect(calls[0]?.args).toEqual(["volume", "ls", "--filter", "name=sandboxr-", "--format", "{{.Name}}"]);
  });

  it("reports whether a volume was actually removed", async () => {
    const { run } = recorder([{ code: 1, stderr: "volume is in use" }]);
    expect(await createDocker(run).volumeRm("sandboxr-data-p-a")).toBe(false);
  });

  it("creates the shared network only when it is missing", async () => {
    const present = recorder([{ code: 0 }]);
    await createDocker(present.run).ensureNetwork("sandboxr");
    expect(present.calls).toHaveLength(1);

    const absent = recorder([{ code: 1 }, { code: 0 }]);
    await createDocker(absent.run).ensureNetwork("sandboxr");
    expect(absent.calls[1]?.args).toEqual(["network", "create", "sandboxr"]);
  });

  it("passes an environment as separate -e arguments", async () => {
    const { calls, run } = recorder();
    await createDocker(run).exec("c", ["true"], { workdir: "/workspace", env: { A: "1" } });
    expect(calls[0]?.args).toEqual(["exec", "-w", "/workspace", "-e", "A=1", "c", "true"]);
  });

  it("builds a logs call from its options", async () => {
    const { calls, run } = recorder();
    await createDocker(run).logs("c", { tail: 40, follow: true });
    expect(calls[0]?.args).toEqual(["logs", "--tail", "40", "-f", "c"]);
  });

  // The window the router's access log is read through — see sandbox/activity.ts.
  it("passes a since window through to docker", async () => {
    const { calls, run } = recorder();
    await createDocker(run).logs("sandboxr-router", { since: "13h" });
    expect(calls[0]?.args).toEqual(["logs", "--since", "13h", "sandboxr-router"]);
  });

  it("omits an empty since rather than sending docker a blank window", async () => {
    const { calls, run } = recorder();
    await createDocker(run).logs("c", { since: "" });
    expect(calls[0]?.args).toEqual(["logs", "c"]);
  });
});

describe("parsePsJson", () => {
  it("skips a line it cannot parse rather than failing the whole listing", () => {
    const rows = parsePsJson('not json\n{"Names":"a","ID":"1","State":"running","Labels":""}\n');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe("a");
  });

  it("returns nothing for empty output", () => {
    expect(parsePsJson("")).toEqual([]);
    expect(parsePsJson("\n\n")).toEqual([]);
  });

  it.each([
    ["Up 3 hours", "running"],
    ["Exited (0) 2 minutes ago", "exited"],
    ["Created", "created"],
    ["Restarting (1) 5 seconds ago", "restarting"],
  ])("derives a state from the Status string %s", (status, want) => {
    const rows = parsePsJson(JSON.stringify({ Names: "a", ID: "1", Status: status, Labels: "" }));
    expect(rows[0]?.state).toBe(want);
  });
});

describe("label parsing", () => {
  it.each([
    ["a=1,b=2", { a: "1", b: "2" }],
    ["", {}],
    ["novalue", {}],
    ["=leading", {}],
    ["a=b=c", { a: "b=c" }],
  ])("parses the pair string %s", (input, want) => {
    expect(parseLabelPairs(input)).toEqual(want);
  });

  it.each([
    ["a=1\nb=2\n", { a: "1", b: "2" }],
    ["", {}],
    ["a=with,comma\n", { a: "with,comma" }],
    ["a=\n", { a: "" }],
  ])("parses the line form %s", (input, want) => {
    expect(parseLabelLines(input)).toEqual(want);
  });
});

describe("archBuildArgs", () => {
  it("maps node's architecture names onto docker's", () => {
    expect(archBuildArgs("x64")).toEqual(["--build-arg", "TARGETARCH=amd64"]);
    expect(archBuildArgs("arm64")).toEqual(["--build-arg", "TARGETARCH=arm64"]);
  });

  it("passes nothing for an architecture it does not know", () => {
    // Rather than a guess: the value ends up in a download URL, where a wrong
    // one is a 404 in the middle of a build. The Dockerfile's own `uname -m`
    // fallback is a better answer than anything this could invent.
    expect(archBuildArgs("ppc64")).toEqual([]);
  });
});
