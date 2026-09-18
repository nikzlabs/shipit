import { describe, it, expect } from "vitest";
import { resolveAuthedSelection, resolveParkedRestore } from "./resolve-authed-selection.js";
import type { AgentOption } from "../agent-types.js";

function agent(over: Partial<AgentOption> & Pick<AgentOption, "id">): AgentOption {
  return {
    name: over.id,
    installed: true,
    hasRunnableModels: true,
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
    const agents = [claude(), codex({ hasRunnableModels: false })];
    expect(resolveAuthedSelection(agents, "claude", undefined)).toBeNull();
  });

  it("redirects to the only authed agent on a Codex-only install (fresh: no saved model)", () => {

    // only Codex is authed. Must redirect AND carry Codex's default model so the

    const agents = [claude({ hasRunnableModels: false }), codex()];
    expect(resolveAuthedSelection(agents, "claude", undefined)).toEqual({
      agentId: "codex",
      modelId: "gpt-5.5",
    });
  });

  it("overwrites a stale saved model owned by the unauthed agent", () => {

    const agents = [claude({ hasRunnableModels: false }), codex()];
    expect(resolveAuthedSelection(agents, "claude", "sonnet")).toEqual({
      agentId: "codex",
      modelId: "gpt-5.5",
    });
  });

  it("preserves a saved model that already resolves to an authed agent", () => {

    const agents = [claude({ hasRunnableModels: false }), codex()];
    expect(resolveAuthedSelection(agents, "claude", "gpt-5.5")).toEqual({
      agentId: "codex",
      modelId: "gpt-5.5",
    });
  });

  it("returns null when no agent is authed (nothing to redirect to)", () => {
    const agents = [claude({ hasRunnableModels: false }), codex({ hasRunnableModels: false })];
    expect(resolveAuthedSelection(agents, "claude", undefined)).toBeNull();
  });

  it("treats an installed-but-not-authed agent as needing redirect", () => {
    const agents = [claude({ hasRunnableModels: false }), codex()];
    expect(resolveAuthedSelection(agents, "claude", undefined)?.agentId).toBe("codex");
  });

  it("treats a not-installed agent as needing redirect", () => {
    const agents = [claude({ installed: false }), codex()];
    expect(resolveAuthedSelection(agents, "claude", undefined)?.agentId).toBe("codex");
  });

  it("returns null when the active agent is already the first authed agent", () => {

    const agents = [claude({ hasRunnableModels: false }), codex()];
    expect(resolveAuthedSelection(agents, "codex", "gpt-5.5")).toBeNull();
  });
});

describe("resolveParkedRestore", () => {
  it("hands the parked harness back once it can run a turn again", () => {

    const agents = [claude(), codex()];
    expect(resolveParkedRestore(agents, { agentId: "claude" })?.id).toBe("claude");
  });

  it("holds the park while the harness still cannot run one", () => {
    const agents = [claude({ hasRunnableModels: false }), codex()];
    expect(resolveParkedRestore(agents, { agentId: "claude" })).toBeUndefined();
  });

  it("holds the park while the harness is not installed at all", () => {
    // A deployment that dropped the harness (req 14) must not be restored onto.
    const agents = [claude({ installed: false }), codex()];
    expect(resolveParkedRestore(agents, { agentId: "claude" })).toBeUndefined();
  });

  it("restores nothing when nothing is parked", () => {
    expect(resolveParkedRestore([claude(), codex()], undefined)).toBeUndefined();
  });

  it("does not test the parked MODEL — only the harness", () => {

    const agents = [claude(), codex()];
    const parked = { agentId: "claude" as const, model: { modelId: "a-model-since-retired" } };
    expect(resolveParkedRestore(agents, parked)?.id).toBe("claude");
  });
});
