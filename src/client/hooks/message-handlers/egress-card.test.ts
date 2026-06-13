import { describe, it, expect, beforeEach } from "vitest";
import { handleEgressPromptCard, handleEgressPromptResolved } from "./egress-card.js";
import { useSessionStore } from "../../stores/session-store.js";
import { useEgressPromptStore } from "../../stores/egress-prompt-store.js";
import type { WsEgressPromptCard } from "../../../server/shared/types.js";

const card = (over: Partial<WsEgressPromptCard> = {}): WsEgressPromptCard => ({
  type: "egress_prompt_card",
  sessionId: "s1",
  cardId: "egress-s1-cdn.example.com",
  host: "cdn.example.com",
  createdAt: "2026-06-13T00:00:00.000Z",
  ...over,
});

// The handlers only touch zustand stores; ctx is unused.
const ctx = {} as never;

beforeEach(() => {
  useEgressPromptStore.getState().reset();
  useSessionStore.setState({ messages: [] } as never);
});

describe("handleEgressPromptCard (docs/172)", () => {
  it("seeds the store and appends one marker message", () => {
    handleEgressPromptCard(ctx, card());
    expect(useEgressPromptStore.getState().cards["egress-s1-cdn.example.com"].host).toBe("cdn.example.com");
    expect(useSessionStore.getState().messages.filter((m) => m.egressPrompt)).toHaveLength(1);
  });

  it("is idempotent by cardId (history load + buffer replay)", () => {
    handleEgressPromptCard(ctx, card());
    handleEgressPromptCard(ctx, card());
    expect(useSessionStore.getState().messages.filter((m) => m.egressPrompt)).toHaveLength(1);
  });

  it("resolved updates the phase without adding a message", () => {
    handleEgressPromptCard(ctx, card());
    handleEgressPromptResolved(ctx, {
      type: "egress_prompt_resolved",
      sessionId: "s1",
      cardId: "egress-s1-cdn.example.com",
      phase: "added",
    });
    expect(useEgressPromptStore.getState().cards["egress-s1-cdn.example.com"].phase).toBe("added");
    expect(useSessionStore.getState().messages.filter((m) => m.egressPrompt)).toHaveLength(1);
  });
});
