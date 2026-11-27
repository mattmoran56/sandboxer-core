// Covers cgroup parsing, CPU usage across multiple cores, sampled vs lifetime
// peaks, reset detection, and refusing invalid options before invoking Docker.
import { describe, expect, it } from "vitest";
import { createDocker } from "../docker.js";
import { measureSandbox, parseResourceSample, summarizeResources } from "./measure.js";

describe("resource measurements", () => {
  it("distinguishes current and lifetime peak memory", () => {
    expect(parseResourceSample("100\n500\nusage_usec 3000000\nuser_usec 100\n", 2000))
      .toEqual({ elapsedMs: 2000, memoryBytes: 100, lifetimePeakMemoryBytes: 500, cpuUsec: 3000000 });
  });
  it.each(["", "1\n2\nuser_usec 5", "max\n2\nusage_usec 5", "-1\n2\nusage_usec 5", "1\n\nusage_usec 5"])(
    "refuses unavailable or invalid counters: %s", (input) => {
      expect(() => parseResourceSample(input, 0)).toThrow("Expected cgroup v2");
    },
  );
  it("reports aggregate CPU time, not an artificially capped percentage", () => {
    const samples = [
      parseResourceSample("100\n500\nusage_usec 1000000", 100),
      parseResourceSample("200\n500\nusage_usec 4000000", 2100),
    ];
    expect(summarizeResources(samples)).toEqual({
      observedMs: 2000, cpuSeconds: 3, averageCpuPercent: 150,
      sampledPeakMemoryBytes: 200, lifetimePeakMemoryBytes: 500, finalMemoryBytes: 200,
    });
    expect(() => summarizeResources(samples.reverse())).toThrow("reset");
  });
  it.each([
    { container: "--help" }, { container: "demo", seconds: NaN },
    { container: "demo", intervalMs: 0 }, { container: "demo", readyPort: 0 },
    { container: "demo", readyPath: "http://external" },
  ])("refuses invalid input before Docker runs", async (options) => {
    await expect(measureSandbox(options)).rejects.toThrow();
  });
  it("keeps probing past a redirect and records readiness only on a 2xx response", async () => {
    let probes = 0;
    const docker = createDocker(async (_bin, args) => {
      if (args.includes("curl")) {
        return { code: 0, stdout: ++probes === 1 ? "302" : "204", stderr: "" };
      }
      return { code: 0, stdout: "100\n200\nusage_usec 1000\n", stderr: "" };
    });
    const report = await measureSandbox({
      container: "demo", seconds: 1, intervalMs: 250, readyPort: 8000, docker,
    });
    expect(probes).toBe(2);
    expect(report.readyAfterMs).not.toBeNull();
    expect(report.missedSamples).toBe(0);
  });

  it("reports no samples when the named container cannot be read", async () => {
    const docker = createDocker(async () => ({ code: 1, stdout: "", stderr: "container unavailable" }));
    await expect(measureSandbox({ container: "demo", seconds: 1, intervalMs: 250, docker }))
      .rejects.toThrow("No resource samples collected");
  });
});
