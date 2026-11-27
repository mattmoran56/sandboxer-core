// Reload dispatch regression tests: spaced targets reach only the requested
// frontend or backend, and bare flags keep their all-target behavior.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { reload } from "@sandboxer/core";
import { main } from "./main.js";

vi.mock("@sandboxer/core", async (importOriginal) => {
  const core = await importOriginal<typeof import("@sandboxer/core")>();
  return {
    ...core,
    reload: vi.fn(async () => ({ built: [], failed: [], output: "" })),
  };
});

let project: string;

beforeAll(async () => {
  project = await mkdtemp(join(tmpdir(), "sbx-reload-cli-"));
  await writeFile(join(project, "sandboxer.yaml"), "project: acme\nsandboxer: \">=0.1.0\"\n");
});

afterAll(async () => {
  await rm(project, { recursive: true, force: true });
});

beforeEach(() => vi.mocked(reload).mockClear());

describe("reload dispatch", () => {
  it.each([
    ["web", "app", "frontend"],
    ["web", "built", "frontend"],
    ["go", "webApi", "backend"],
    ["backend", "companyDashboardApi", "backend"],
  ])("--%s %s rebuilds only that target", async (flag, target, kind) => {
    const code = await main(["reload", "ticket", `--${flag}`, target, "--worktree", project], {
      cwd: project,
      env: { SANDBOXER_HOME: join(project, "home") },
      writer: { out: () => {}, err: () => {}, isTTY: false },
    });
    expect(code).toBe(0);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledWith("acme", "ticket", expect.objectContaining({ kind, target }));
  });

  it.each([
    ["web", "frontend"],
    ["go", "backend"],
    ["backend", "backend"],
  ])("bare --%s keeps the all-target behavior", async (flag, kind) => {
    const code = await main(["reload", "ticket", "--worktree", project, `--${flag}`], {
      cwd: project,
      env: { SANDBOXER_HOME: join(project, "home") },
      writer: { out: () => {}, err: () => {}, isTTY: false },
    });
    expect(code).toBe(0);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledWith("acme", "ticket", expect.objectContaining({ kind, target: "all" }));
  });
});
