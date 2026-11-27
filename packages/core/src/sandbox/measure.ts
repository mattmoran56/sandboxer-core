import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { docker as defaultDocker, type Docker } from "../docker.js";

export interface ResourceSample {
  elapsedMs: number;
  memoryBytes: number;
  lifetimePeakMemoryBytes: number;
  cpuUsec: number;
}

/** cgroup v2 counters, without inspecting the container's environment or logs. */
export function parseResourceSample(output: string, elapsedMs: number): ResourceSample {
  const lines = output.trim().split(/\r?\n/);
  const memoryBytes = Number(lines[0]);
  const lifetimePeakMemoryBytes = Number(lines[1]);
  const cpuUsec = Number(/^usage_usec (\d+)$/m.exec(lines.slice(2).join("\n"))?.[1]);
  if (lines.length < 3 || !/^\d+$/.test(lines[0] ?? "") || !/^\d+$/.test(lines[1] ?? "") || [memoryBytes, lifetimePeakMemoryBytes, cpuUsec]
    .some((value) => !Number.isFinite(value) || value < 0)) {
    throw new Error("Expected cgroup v2 memory.current, memory.peak and cpu.stat counters");
  }
  return { elapsedMs, memoryBytes, lifetimePeakMemoryBytes, cpuUsec };
}

export function summarizeResources(samples: ResourceSample[]) {
  const first = samples[0];
  const last = samples.at(-1);
  if (!first || !last) throw new Error("No resource samples collected");
  if (samples.some((sample, index) => index > 0 && sample.cpuUsec < samples[index - 1]!.cpuUsec)) {
    throw new Error("Container CPU counters reset during measurement");
  }
  const observedMs = last.elapsedMs - first.elapsedMs;
  const cpuSeconds = (last.cpuUsec - first.cpuUsec) / 1_000_000;
  return {
    observedMs,
    cpuSeconds,
    // One fully occupied CPU is 100%; this may exceed 100% on multiple CPUs.
    averageCpuPercent: observedMs > 0 ? cpuSeconds / (observedMs / 1000) * 100 : null,
    sampledPeakMemoryBytes: Math.max(...samples.map((sample) => sample.memoryBytes)),
    lifetimePeakMemoryBytes: last.lifetimePeakMemoryBytes,
    finalMemoryBytes: last.memoryBytes,
  };
}

/** Bounded, read-only diagnostic. Start sampling before starting the container. */
export async function measureSandbox(options: {
  container: string;
  seconds?: number;
  intervalMs?: number;
  readyPort?: number;
  readyPath?: string;
  docker?: Docker;
}) {
  const { container, readyPort } = options;
  const seconds = options.seconds ?? 30;
  const intervalMs = options.intervalMs ?? 1000;
  const readyPath = options.readyPath ?? "/health";
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(container)) throw new Error("Invalid container name");
  if (!Number.isFinite(seconds) || seconds < 1 || seconds > 600) {
    throw new Error("seconds must be between 1 and 600");
  }
  if (!Number.isFinite(intervalMs) || intervalMs < 250 || intervalMs > 10_000) {
    throw new Error("intervalMs must be between 250 and 10000");
  }
  if (readyPort !== undefined && (!Number.isInteger(readyPort) || readyPort < 1 || readyPort > 65535)) {
    throw new Error("readyPort must be between 1 and 65535");
  }
  if (!/^\/[a-zA-Z0-9/_?=&.%-]*$/.test(readyPath)) throw new Error("Invalid readiness path");
  const docker = options.docker ?? defaultDocker;
  const started = performance.now();
  const samples: ResourceSample[] = [];
  let readyAfterMs: number | null = null;
  let missedSamples = 0;
  while (performance.now() - started < seconds * 1000) {
    const result = await docker.raw([
      "exec", container, "cat", "/sys/fs/cgroup/memory.current",
      "/sys/fs/cgroup/memory.peak", "/sys/fs/cgroup/cpu.stat",
    ], { timeoutMs: 3000 });
    if (result.code === 0) {
      samples.push(parseResourceSample(result.stdout, performance.now() - started));
      if (readyPort !== undefined && readyAfterMs === null) {
        const ready = await docker.raw([
          "exec", container, "curl", "--fail", "--silent", "--output", "/dev/null",
          "--write-out", "%{http_code}", "--max-time", "1",
          `http://127.0.0.1:${readyPort}${readyPath}`,
        ], { timeoutMs: 3000 });
        if (ready.code === 0 && /^2\d{2}$/.test(ready.stdout.trim())) {
          readyAfterMs = performance.now() - started;
        }
      }
    } else {
      missedSamples++;
    }
    const remaining = seconds * 1000 - (performance.now() - started);
    if (remaining > 0) await delay(Math.min(intervalMs, remaining));
  }
  return {
    container, readyAfterMs, missedSamples,
    ...summarizeResources(samples), samples,
  };
}
