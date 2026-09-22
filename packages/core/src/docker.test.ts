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
// - parseDockerSize: decimal and binary units, and zero for anything unreadable
// - parseDockerTime: docker's offset-plus-abbreviation stamps, and nanoseconds
// - parseDiskUsage: the three arrays, and why an uncounted container reads as one rather than none
// - diskUsage / imageRm / builderPrune: the arguments, and the bytes a prune reports back

import { describe, expect, it } from "vitest";

import {
  DockerError,
  archBuildArgs,
  createDocker,
  parseDiskUsage,
  parseDockerSize,
  parseDockerTime,
  parseLabelLines,
  parseLabelPairs,
  parsePsJson,
  parseReclaimed,
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
    await createDocker(run).exec("sandboxer-p-s", ["sh", "-c", "echo hi; rm -rf /"]);
    expect(calls[0]?.args).toEqual(["exec", "sandboxer-p-s", "sh", "-c", "echo hi; rm -rf /"]);
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
      .ok(["build", "-t", "sandboxer/acme:abc", "/tmp/ctx"])
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
          '{"Names":"sandboxer-p-a","ID":"aaa","State":"running","Labels":"sandboxer.slug=a,sandboxer.project=p"}',
          '{"Names":"sandboxer-p-b","ID":"bbb","State":"exited","Labels":"sandboxer.slug=b"}',
        ].join("\n"),
      },
    ]);
    const rows = await createDocker(run).ps(["label=sandboxer.slug"]);
    expect(calls[0]?.args).toEqual(["ps", "-a", "--filter", "label=sandboxer.slug", "--format", "{{json .}}"]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      name: "sandboxer-p-a",
      id: "aaa",
      state: "running",
      labels: { "sandboxer.slug": "a", "sandboxer.project": "p" },
    });
  });

  it("throws when ps itself fails, rather than reporting no sandboxes", async () => {
    const { run } = recorder([{ code: 1, stderr: "Cannot connect to the Docker daemon" }]);
    await expect(createDocker(run).ps(["label=x"])).rejects.toThrow(DockerError);
  });

  it("reads labels through an inspect template, which survives a comma in a value", async () => {
    const { calls, run } = recorder([{ stdout: "sandboxer.branch=feat/a,b\nsandboxer.slug=s\n" }]);
    const labels = await createDocker(run).labels("sandboxer-p-s");
    expect(calls[0]?.args[1]).toBe("-f");
    expect(labels).toEqual({ "sandboxer.branch": "feat/a,b", "sandboxer.slug": "s" });
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
    const { calls, run } = recorder([{ stdout: "sandboxer-data-p-a\n\nsandboxer-www-p-a\n" }]);
    expect(await createDocker(run).volumes("sandboxer-")).toEqual(["sandboxer-data-p-a", "sandboxer-www-p-a"]);
    expect(calls[0]?.args).toEqual(["volume", "ls", "--filter", "name=sandboxer-", "--format", "{{.Name}}"]);
  });

  it("reports whether a volume was actually removed", async () => {
    const { run } = recorder([{ code: 1, stderr: "volume is in use" }]);
    expect(await createDocker(run).volumeRm("sandboxer-data-p-a")).toBe(false);
  });

  it("creates the shared network only when it is missing", async () => {
    const present = recorder([{ code: 0 }]);
    await createDocker(present.run).ensureNetwork("sandboxer");
    expect(present.calls).toHaveLength(1);

    const absent = recorder([{ code: 1 }, { code: 0 }]);
    await createDocker(absent.run).ensureNetwork("sandboxer");
    expect(absent.calls[1]?.args).toEqual(["network", "create", "sandboxer"]);
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
    await createDocker(run).logs("sandboxer-router", { since: "13h" });
    expect(calls[0]?.args).toEqual(["logs", "--since", "13h", "sandboxer-router"]);
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

describe("parseDockerSize", () => {
  it.each([
    ["6.01GB", 6.01e9],
    ["679.3MB", 679.3e6],
    ["51.8kB", 51_800],
    ["0B", 0],
    ["512", 512],
    ["1GiB", 1024 ** 3],
  ])("reads %s", (input, want) => {
    expect(parseDockerSize(input)).toBeCloseTo(want, 0);
  });

  // Zero rather than a guess: these numbers are added up and shown as "this
  // much would come back", and a misread unit is the difference between
  // megabytes and gigabytes in a sentence someone acts on.
  it.each(["N/A", "", "lots", "12 parsecs"])("reads %s as nothing", (input) => {
    expect(parseDockerSize(input)).toBe(0);
  });
});

describe("parseDockerTime", () => {
  it("reads a stamp carrying both an offset and a zone abbreviation", () => {
    expect(parseDockerTime("2026-08-28 07:43:32 +0100 BST")?.toISOString()).toBe("2026-08-28T06:43:32.000Z");
  });

  it("reads a build cache record's nanoseconds", () => {
    expect(parseDockerTime("2023-09-06 16:26:48.746507788 +0000 UTC")?.toISOString()).toBe(
      "2023-09-06T16:26:48.746Z",
    );
  });

  // Undefined rather than the epoch: callers order by this to decide what to
  // delete, and 1970 sorts a perfectly good image to the front of that queue.
  it.each(["", "not a date"])("gives up on %s rather than guessing", (input) => {
    expect(parseDockerTime(input)).toBeUndefined();
  });
});

describe("parseDiskUsage", () => {
  const stdout = JSON.stringify({
    Images: [
      {
        Repository: "sandboxer/acme",
        Tag: "48273eacdece",
        ID: "sha256:222110270923",
        CreatedAt: "2026-08-28 07:43:32 +0100 BST",
        Size: "6.01GB",
        SharedSize: "671.9MB",
        UniqueSize: "5.34GB",
        Containers: "1",
      },
    ],
    Volumes: [{ Name: "sandboxer-data-acme-tkt-1", Size: "412MB", Links: "0" }],
    BuildCache: [
      { ID: "abc", Size: "1.5GB", InUse: "false", Shared: "true", LastUsedAt: "2026-08-27 09:00:00 +0000 UTC" },
    ],
  });

  it("reads each kind, and strips the digest algorithm off an image id", () => {
    const usage = parseDiskUsage(stdout);
    expect(usage.images[0]).toMatchObject({ repository: "sandboxer/acme", id: "222110270923", containers: 1 });
    expect(usage.images[0]?.uniqueSize).toBeCloseTo(5.34e9, 0);
    expect(usage.volumes[0]).toMatchObject({ name: "sandboxer-data-acme-tkt-1", links: 0 });
    expect(usage.buildCache[0]).toMatchObject({ id: "abc", inUse: false, shared: true });
  });

  // "Unknown" must not become zero. Zero containers is what licenses a
  // deletion, and docker writes `N/A` for a count it did not take.
  it("treats an uncounted container as one rather than none", () => {
    const usage = parseDiskUsage(JSON.stringify({ Images: [{ Repository: "a", Tag: "b", Containers: "N/A" }] }));
    expect(usage.images[0]?.containers).toBe(1);
  });

  it("answers with nothing rather than throwing on output it cannot read", () => {
    expect(parseDiskUsage("not json")).toEqual({ images: [], volumes: [], buildCache: [] });
  });
});

describe("reclaiming", () => {
  it("asks for the verbose, machine-readable form", async () => {
    const { calls, run } = recorder([{ stdout: "{}" }]);
    await createDocker(run).diskUsage();
    expect(calls[0]?.args).toEqual(["system", "df", "-v", "--format", "{{json .}}"]);
  });

  it("removes an image by reference, and reports a refusal as false", async () => {
    const { calls, run } = recorder([{ code: 1, stderr: "image is being used" }]);
    expect(await createDocker(run).imageRm("sandboxer/acme:old")).toBe(false);
    expect(calls[0]?.args).toEqual(["image", "rm", "sandboxer/acme:old"]);
  });

  it("prunes the build cache and reads back what docker says it reclaimed", async () => {
    const { calls, run } = recorder([{ stdout: "Deleted build cache objects:\nTotal reclaimed space: 5.156GB\n" }]);
    expect(await createDocker(run).builderPrune({ all: true })).toBeCloseTo(5.156e9, 0);
    expect(calls[0]?.args).toEqual(["builder", "prune", "--force", "--all"]);
  });

  // A daemon with no builder answers non-zero, and "there was no cache" is not
  // a reason to abandon the rest of a housekeeping run.
  it("reports nothing reclaimed rather than throwing when there is no builder", async () => {
    const { run } = recorder([{ code: 1, stderr: "no builder" }]);
    expect(await createDocker(run).builderPrune()).toBe(0);
  });

  it("finds the reclaimed line wherever it sits in the output", () => {
    expect(parseReclaimed("nothing here")).toBe(0);
    expect(parseReclaimed("Total reclaimed space: 0B")).toBe(0);
  });
});
