import { describe, it, expect } from "vitest";
import { resolveAuthedSelection } from "./resolve-authed-selection.js";
import type { AgentOption } from "../agent-types.js";

function agent(over: Partial<AgentOption> & Pick<AgentOption, "id">): AgentOption {
  return {
    name: over.id,
    installed: true,
    authConfigured: true,
    models: [],
    supportsReview: false,
    ...over,
  };
}

const claude = (over: Partial<AgentOption> = {}) =>
  agent({ id: "claude", models: ["claude-opus-4-8", "sonnet"], ...over });
const codex = (over: Partial<AgentOption> = {}) =>
  agent({ id: "codex", models: ["gpt-5.5"], ...over });

describe("resolveAuthedSelection", () => {
  it("returns null when the active agent is installed and authed", () => {
    const agents = [claude(), codex({ authConfigured: false })];
    expect(resolveAuthedSelection(agents, "claude", undefined)).toBeNull();
  });

  it("redirects to the only authed agent on a Codex-only install (fresh: no saved model)", () => {
    // Reproduces the bug: picker hydrates with agent="claude"/no model, but
    // only Codex is authed. Must redirect AND carry Codex's default model so the
    // WS connection wires up Codex instead of the unauthed Claude.
    const agents = [claude({ authConfigured: false }), codex()];
    expect(resolveAuthedSelection(agents, "claude", undefined)).toEqual({
      agentId: "codex",
      modelId: "gpt-5.5",
    });
  });

  it("overwrites a stale saved model owned by the unauthed agent", () => {
    // A leftover Claude model would otherwise pull the WS agent derivation back
    // to the unauthed Claude (model is the source of truth for the agent).
    const agents = [claude({ authConfigured: false }), codex()];
    expect(resolveAuthedSelection(agents, "claude", "sonnet")).toEqual({
      agentId: "codex",
      modelId: "gpt-5.5",
    });
  });

  it("preserves a saved model that already resolves to an authed agent", () => {
    // activeAgentId is the unauthed Claude (e.g. mirrored from a stale agent
    // pref) but the saved model already points at authed Codex — keep the pick.
    const agents = [claude({ authConfigured: false }), codex()];
    expect(resolveAuthedSelection(agents, "claude", "gpt-5.5")).toEqual({
      agentId: "codex",
      modelId: "gpt-5.5",
    });
  });

  it("returns null when no agent is authed (nothing to redirect to)", () => {
    const agents = [claude({ authConfigured: false }), codex({ authConfigured: false })];
    expect(resolveAuthedSelection(agents, "claude", undefined)).toBeNull();
  });

  it("treats an installed-but-not-authed agent as needing redirect", () => {
    const agents = [claude({ authConfigured: false }), codex()];
    expect(resolveAuthedSelection(agents, "claude", undefined)?.agentId).toBe("codex");
  });

  it("treats a not-installed agent as needing redirect", () => {
    const agents = [claude({ installed: false }), codex()];
    expect(resolveAuthedSelection(agents, "claude", undefined)?.agentId).toBe("codex");
  });

  it("returns null when the active agent is already the first authed agent", () => {
    // Avoids a redundant redirect/persist when nothing would change.
    const agents = [claude({ authConfigured: false }), codex()];
    expect(resolveAuthedSelection(agents, "codex", "gpt-5.5")).toBeNull();
  });
});
