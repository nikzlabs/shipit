import { describe, it, expect } from "vitest";
import { shipitToolSpec } from "./mcp-tool-spec.js";
import { GrokAdapter } from "./agents/grok/adapter.js";
import { AntigravityAdapter } from "./agents/antigravity/adapter.js";
import { OpencodeAdapter } from "./agents/opencode/adapter.js";
import type { AgentMcpBridge } from "./agents/agent-process.js";

const bridge: AgentMcpBridge = { tsxBin: "/usr/bin/tsx", bridgePath: "/opt/bridge.ts" };

describe("shipitToolSpec (docs/303 req 21)", () => {
  it("returns the spec untouched while the session status card is off", () => {
    const spec = "present,voice,bug,ask,propose_actions,propose_repo_session";
    expect(shipitToolSpec(spec, {})).toBe(spec);
    expect(shipitToolSpec(spec, { sessionStatusCard: false })).toBe(spec);
  });

  it("swaps only the offer tool while it is on, keeping the order", () => {
    expect(
      shipitToolSpec("present,voice,bug,ask,propose_actions,propose_repo_session", {
        sessionStatusCard: true,
      }),
    ).toBe("present,voice,bug,ask,session_status,propose_repo_session");
  });

  it("leaves propose_repo_session alone", () => {
    const out = shipitToolSpec("propose_actions,propose_repo_session", { sessionStatusCard: true });
    expect(out).toBe("session_status,propose_repo_session");
  });
});

/** The spec each harness hands its bridge, read without spawning the CLI. */
function bridgeSpec(servers: Record<string, unknown>): string {
  const shipit = servers.shipit as {
    env?: Record<string, string>;
    environment?: Record<string, string>;
  };
  return (shipit.env?.SHIPIT_MCP_TOOLS ?? shipit.environment?.SHIPIT_MCP_TOOLS)!;
}

function pendingServers(adapter: unknown): Record<string, unknown> {
  return (adapter as { pendingMcpServers: Record<string, unknown> }).pendingMcpServers;
}

describe.each([
  ["grok", () => new GrokAdapter(), "present,voice,bug,ask,propose_actions,propose_repo_session"],
  ["antigravity", () => new AntigravityAdapter(), "present,voice,bug,ask,propose_actions,propose_repo_session"],
  ["opencode", () => new OpencodeAdapter(), "present,voice,bug,ask,propose_actions,propose_repo_session"],
])("%s bridge tool list", (_name, make, offSpec) => {
  it("is byte for byte the pre-card list while the setting is off", () => {
    const adapter = make();
    adapter.writeMcpConfig({ servers: [], shipitBridge: bridge, onServerFailed: () => undefined });
    expect(bridgeSpec(pendingServers(adapter))).toBe(offSpec);
  });

  it("offers session_status instead of propose_actions while the setting is on", () => {
    const adapter = make();
    adapter.writeMcpConfig({
      servers: [],
      shipitBridge: bridge,
      sessionStatusCard: true,
      onServerFailed: () => undefined,
    });
    const spec = bridgeSpec(pendingServers(adapter));
    expect(spec).toBe(offSpec.replace("propose_actions", "session_status"));
    expect(spec).not.toContain("propose_actions");
  });
});
