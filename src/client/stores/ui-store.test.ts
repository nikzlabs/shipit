import { describe, it, expect, beforeEach } from "vitest";
import { useUiStore } from "./ui-store.js";
import type { AgentOption } from "../agent-types.js";

function agent(id: string, models: string[]): AgentOption {
  return { id, name: id, installed: true, hasRunnableModels: true, models, supportsReview: false };
}

const agents = [agent("claude", ["claude-sonnet-5"]), agent("codex", ["gpt-5.6-sol"])];

beforeEach(() => {
  localStorage.removeItem("vibe-agent-id");
  localStorage.removeItem("vibe-model-id");
  useUiStore.setState({ agentList: agents });
});

/**
 * docs/252 — `activeAgentId` is synced to the CONNECTED session
 * (`useConnectionSync`), so it is stale the moment there is no session behind
 * it. `resetSessionState` runs on exactly that transition.
 *
 * The case that made this load-bearing: the new-session route claims a warm
 * session, which is bound but excluded from `sessions` (`SessionManager.list`
 * filters `warm = 0`), so the composer falls back to this field. Left stale, the
 * picker named the session the user had just left while creating the seeded one.
 */
describe("useUiStore.reset", () => {
  it("returns activeAgentId to the seed rather than leaving the previous session's", () => {
    useUiStore.setState({ activeAgentId: "codex" });
    localStorage.setItem("vibe-agent-id", "claude");

    useUiStore.getState().reset();

    expect(useUiStore.getState().activeAgentId).toBe("claude");
  });

  it("derives the seed from the saved model, as session creation does", () => {
    useUiStore.setState({ activeAgentId: "claude" });
    localStorage.setItem("vibe-agent-id", "claude");
    localStorage.setItem("vibe-model-id", "openai:key:gpt-5.6-sol");

    useUiStore.getState().reset();

    expect(useUiStore.getState().activeAgentId).toBe("codex");
  });

  it("does NOT write the seed back to localStorage", () => {
    // `setActiveAgentId`'s contract: an internal sync must never move the global
    // "new session default", or a session's own harness would become it.
    useUiStore.setState({ activeAgentId: "codex" });
    localStorage.setItem("vibe-agent-id", "claude");

    useUiStore.getState().reset();

    expect(localStorage.getItem("vibe-agent-id")).toBe("claude");
  });
});
