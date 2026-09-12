import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useSessionStore } from "../../stores/session-store.js";
import { useUiStore } from "../../stores/ui-store.js";
import { useFileStore } from "../../stores/file-store.js";
import { handleModelSelectionChanged } from "./model-selection-changed.js";
import type { HandlerContext } from "./types.js";
import type { SessionInfo, WsModelSelectionChanged } from "../../../server/shared/types.js";

const ctx: HandlerContext = {
  terminalRef: { current: null },
  queuedMessageStash: new Map(),
};

function session(over: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: "s1",
    title: "Test",
    createdAt: new Date().toISOString(),
    lastUsedAt: new Date().toISOString(),
    agentId: "claude",
    model: "anthropic/claude-opus-5",
    serviceId: "openrouter",
    billingMode: "key",
    ...over,
  } as SessionInfo;
}

function message(over: Partial<WsModelSelectionChanged> = {}): WsModelSelectionChanged {
  return {
    type: "model_selection_changed",
    sessionId: "s1",
    agentId: "claude",
    selection: { serviceId: "vercel", billingMode: "key", modelId: "anthropic/claude-opus-5" },
    modelId: "anthropic/claude-opus-5",
    reasoningEffort: null,
    roleName: null,
    ...over,
  };
}

beforeEach(() => {
  useSessionStore.setState({
    sessionId: "s1",
    sessions: [session(), session({ id: "s2" })],
    modelSelectionEcho: {},
  });
  useUiStore.setState({ toast: undefined });
});

describe("handleModelSelectionChanged", () => {
  it("moves the session onto the confirmed service even when the model id is unchanged", () => {

    // on the service the user just left — invisible, because the id agrees.
    handleModelSelectionChanged(ctx, message());
    const updated = useSessionStore.getState().sessions.find((s) => s.id === "s1");
    expect(updated?.serviceId).toBe("vercel");
    expect(updated?.billingMode).toBe("key");
    expect(updated?.model).toBe("anthropic/claude-opus-5");
  });

  it("touches only the session it names", () => {
    handleModelSelectionChanged(ctx, message());
    expect(useSessionStore.getState().sessions.find((s) => s.id === "s2")?.serviceId).toBe(
      "openrouter",
    );
  });

  it("clears the service and mode when the server could not place the model id", () => {
    // The stored invariant: a selection either names a real catalogue row or

    handleModelSelectionChanged(ctx, message({ selection: null, modelId: "some-legacy-slug" }));
    const updated = useSessionStore.getState().sessions.find((s) => s.id === "s1");
    expect(updated?.serviceId).toBeUndefined();
    expect(updated?.billingMode).toBeUndefined();
    expect(updated?.model).toBe("some-legacy-slug");
  });

  it("toasts a notice for the active session", () => {
    handleModelSelectionChanged(ctx, message({ notice: "Codex moved to GPT-5.6 Sol." }));
    expect(useUiStore.getState().toast?.message).toBe("Codex moved to GPT-5.6 Sol.");
  });

  it("does NOT toast for a session the user is not looking at", () => {
    handleModelSelectionChanged(
      ctx,
      message({ sessionId: "s2", notice: "Codex moved to GPT-5.6 Sol." }),
    );
    expect(useUiStore.getState().toast).toBeUndefined();

    expect(useSessionStore.getState().sessions.find((s) => s.id === "s2")?.serviceId).toBe("vercel");
  });

  it("says nothing when the user asked for the change themselves", () => {
    handleModelSelectionChanged(ctx, message());
    expect(useUiStore.getState().toast).toBeUndefined();
  });

  describe("the role seed", () => {
    beforeEach(() => localStorage.setItem("shipit-role-name", "deep dive"));
    afterEach(() => localStorage.removeItem("shipit-role-name"));

    it("follows the session's role while the session has not started", () => {

      handleModelSelectionChanged(ctx, message({ roleName: null }));
      expect(localStorage.getItem("shipit-role-name")).toBeNull();
    });

    it("is left alone once the session has started", () => {

      useSessionStore.setState({ sessions: [session({ agentPinned: true }), session({ id: "s2" })] });
      handleModelSelectionChanged(ctx, message({ roleName: null }));
      expect(localStorage.getItem("shipit-role-name")).toBe("deep dive");
    });

    it("does not make an agent-started child's role the user's default either", () => {

      // one the user never selected in this browser.
      useSessionStore.setState({ sessions: [session({ agentPinned: true }), session({ id: "s2" })] });
      handleModelSelectionChanged(ctx, message({ roleName: "triage" }));
      expect(localStorage.getItem("shipit-role-name")).toBe("deep dive");
    });
  });

  // On `/{repo}/new` the warm session has no row, so this is what the pickers read.
  describe("the ui store's active harness", () => {
    it("follows the answer for the session on screen", () => {
      useUiStore.setState({ activeAgentId: "claude" });
      handleModelSelectionChanged(ctx, message({ agentId: "codex", roleName: "triage" }));
      expect(useUiStore.getState().activeAgentId).toBe("codex");
    });

    it("refetches the skills when the harness actually moved", () => {
      // Skills are per-backend; an explicit harness pick already refetches.
      useUiStore.setState({ activeAgentId: "claude" });
      const fetchSkills = vi.fn().mockResolvedValue(undefined);
      useFileStore.setState({ fetchSkills } as never);
      handleModelSelectionChanged(ctx, message({ agentId: "codex", roleName: "triage" }));
      expect(fetchSkills).toHaveBeenCalledWith("s1", "codex");
    });
  });

  it("records that the server answered — including when it REFUSED and changed nothing", () => {

    // leaves the row exactly as it was, so "the row now matches" cannot be the

    const before = useSessionStore.getState().modelSelectionEcho.s1 ?? 0;
    handleModelSelectionChanged(
      ctx,
      message({

        selection: { serviceId: "openrouter", billingMode: "key", modelId: "anthropic/claude-opus-5" },
        notice: "vercel has no credential Claude Code can use.",
      }),
    );
    expect(useSessionStore.getState().modelSelectionEcho.s1).toBe(before + 1);
  });
});
