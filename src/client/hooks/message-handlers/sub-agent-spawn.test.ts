import { describe, it, expect, beforeEach } from "vitest";
import { useSessionStore } from "../../stores/session-store.js";
import { handleSubAgentSpawn } from "./sub-agent-spawn.js";
import { handleSubAgentConsultCard } from "./sub-agent-consult-card.js";
import type { HandlerContext } from "./types.js";
import type { WsSubAgentSpawn, WsSubAgentConsultCard } from "../../../server/shared/types.js";

const ctx: HandlerContext = {
  terminalRef: { current: null },
  queuedMessageStash: new Map(),
};

beforeEach(() => {
  useSessionStore.setState({ subAgentSpawns: {}, messages: [] });
});

describe("handleSubAgentSpawn (docs/144)", () => {
  it("adds an in-flight spinner keyed by spawnId", () => {
    const msg: WsSubAgentSpawn = { type: "sub_agent_spawn", spawnId: "x1", subAgentId: "codex" };
    handleSubAgentSpawn(ctx, msg);
    expect(useSessionStore.getState().subAgentSpawns.x1).toMatchObject({ subAgentId: "codex" });
  });
});

describe("handleSubAgentConsultCard (docs/144)", () => {
  const card: WsSubAgentConsultCard["card"] = {
    cardId: "c1",
    spawnId: "x1",
    subAgentId: "codex",
    status: "success",
    durationMs: 4700,
    costUsd: 0.03,
    truncated: false,
    createdAt: "2026-06-13T00:00:00.000Z",
  };

  it("clears the in-flight spinner and appends a persisted consult card", () => {
    handleSubAgentSpawn(ctx, { type: "sub_agent_spawn", spawnId: "x1", subAgentId: "codex" });
    handleSubAgentConsultCard(ctx, { type: "sub_agent_consult_card", sessionId: "s1", card });

    const state = useSessionStore.getState();
    // spinner gone (the card is the terminal record)
    expect(state.subAgentSpawns.x1).toBeUndefined();
    // card appended to the transcript as an empty-text carrier message
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]).toMatchObject({ role: "assistant", text: "", subAgentConsult: { cardId: "c1" } });
  });

  it("is idempotent by cardId (reconnect buffer replay + history replay)", () => {
    const msg: WsSubAgentConsultCard = { type: "sub_agent_consult_card", sessionId: "s1", card };
    handleSubAgentConsultCard(ctx, msg);
    handleSubAgentConsultCard(ctx, msg);
    expect(useSessionStore.getState().messages).toHaveLength(1);
  });
});
