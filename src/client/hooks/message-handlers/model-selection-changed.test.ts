import { describe, it, expect, beforeEach } from "vitest";
import { useSessionStore } from "../../stores/session-store.js";
import { useUiStore } from "../../stores/ui-store.js";
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

/**
 * docs/252 phase 4 (req 4) — the server's confirmation of a selection change.
 */
describe("handleModelSelectionChanged", () => {
  it("moves the session onto the confirmed service even when the model id is unchanged", () => {
    // The case the whole message exists for: nothing else refreshes the session
    // list after a selection change, so without this the picker's checkmark sits
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
    // carries no service and mode at all. Keeping the old pair would leave the
    // picker claiming a service the session is not on.
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
    // The store update still applies — it is keyed by id, so it is safe.
    expect(useSessionStore.getState().sessions.find((s) => s.id === "s2")?.serviceId).toBe("vercel");
  });

  it("says nothing when the user asked for the change themselves", () => {
    handleModelSelectionChanged(ctx, message());
    expect(useUiStore.getState().toast).toBeUndefined();
  });

  it("records that the server answered — including when it REFUSED and changed nothing", () => {
    // The composer's optimistic pick has to be dropped either way, and a refusal
    // leaves the row exactly as it was, so "the row now matches" cannot be the
    // signal. Cross-backend review found the picker sitting on a refused pick.
    const before = useSessionStore.getState().modelSelectionEcho.s1 ?? 0;
    handleModelSelectionChanged(
      ctx,
      message({
        // A refusal: the selection reported is the one the session already had.
        selection: { serviceId: "openrouter", billingMode: "key", modelId: "anthropic/claude-opus-5" },
        notice: "vercel has no credential Claude Code can use.",
      }),
    );
    expect(useSessionStore.getState().modelSelectionEcho.s1).toBe(before + 1);
  });
});
