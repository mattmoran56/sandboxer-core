// The orchestrator container's `docker run` arguments.
//
// Covers:
//   - the mounts it needs: the socket, the home, the installation, the workspace
//   - the Claude login is mounted when the machine has one, and not when it does not
//   - a setup token reaches it as CLAUDE_CODE_OAUTH_TOKEN
//   - it idles rather than running the agent as its entrypoint
//   - it is named and labelled so teardown and `docker ps` can find it

import { describe, expect, it } from "vitest";

import { ORCHESTRATOR_CONTAINER, orchestratorArgs } from "./orchestrator.js";

const env = { SANDBOXR_HOME: "/home/ada/.sandboxr", HOME: "/home/ada" } as NodeJS.ProcessEnv;

const mountsOf = (args: string[]): string[] =>
  args.filter((_, at) => args[at - 1] === "-v");

const varsOf = (args: string[]): Record<string, string> => {
  const held: Record<string, string> = {};
  args.forEach((value, at) => {
    if (args[at - 1] !== "-e") return;
    const split = value.indexOf("=");
    held[value.slice(0, split)] = value.slice(split + 1);
  });
  return held;
};

describe("orchestratorArgs", () => {
  it("mounts the socket, the home and the installation", () => {
    const mounts = mountsOf(orchestratorArgs({ env }));
    expect(mounts).toContain("/var/run/docker.sock:/var/run/docker.sock");
    expect(mounts.some((m) => m.startsWith("/home/ada/.sandboxr:/home/ada/.sandboxr"))).toBe(true);
    expect(mounts.some((m) => m.endsWith(":ro"))).toBe(true);
  });

  it("mounts the Claude login when the machine has one", () => {
    const mounts = mountsOf(
      orchestratorArgs({ env, claudeCredentials: "/home/ada/.claude/.credentials.json" }),
    );
    expect(mounts).toContain("/home/ada/.claude/.credentials.json:/root/.claude/.credentials.json");
  });

  it("mounts nothing for a machine with no login", () => {
    const mounts = mountsOf(orchestratorArgs({ env }));
    expect(mounts.some((m) => m.includes(".credentials.json"))).toBe(false);
  });

  it("passes a setup token through as the variable Claude Code reads", () => {
    const vars = varsOf(orchestratorArgs({ env: { ...env, SANDBOXR_CLAUDE_TOKEN: "sk-ant-oat-x" } }));
    expect(vars.CLAUDE_CODE_OAUTH_TOKEN).toBe("sk-ant-oat-x");
  });

  it("omits the token variable when there is none", () => {
    expect(varsOf(orchestratorArgs({ env }))).not.toHaveProperty("CLAUDE_CODE_OAUTH_TOKEN");
  });

  it("idles rather than running the agent as its entrypoint", () => {
    // The agent's lifetime is a conversation's, not the container's: it is execed
    // in. A container that ran it as its command would be one conversation, ended
    // by every restart.
    expect(orchestratorArgs({ env }).slice(-2)).toEqual(["sleep", "infinity"]);
  });

  it("is named and labelled so teardown can find it", () => {
    const args = orchestratorArgs({ env });
    expect(args).toContain(ORCHESTRATOR_CONTAINER);
    expect(args).toContain("sandboxr.role=orchestrator");
  });
});
