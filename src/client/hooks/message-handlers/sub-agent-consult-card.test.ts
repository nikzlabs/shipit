import { describe, it, expect, beforeEach } from "vitest";
import { useSessionStore } from "../../stores/session-store.js";
import { handleAgentEvent } from "./agent-event.js";
import { handleSubAgentConsultCard } from "./sub-agent-consult-card.js";
import { handleSubAgentSpawn } from "./sub-agent-spawn.js";
import { buildVisualElements } from "../../components/visual-elements.js";
import type { HandlerContext } from "./types.js";
import type { WsAgentEvent, WsSubAgentConsultCard, WsSubAgentSpawn } from "../../../server/shared/types.js";

/**
 * docs/144 + docs/220 — the "Consulted Codex" card must never flash-then-vanish.
 *
 * It is a mid-turn, side-channel transcript card emitted from the HTTP
 * `runSubAgent` path while the parent agent is BLOCKED on the `shipit agent run`
 * Bash call. That makes it the same hazard class as the permission card fixed in
 * 2e585cb0 (turn-event replay overlap), but with an extra wrinkle no other card
 * has: it is immediately followed by the Bash *tool_result* for the very command
 * that produced it, which the `agent_tool_result` handler merges into the card's
 * carrier message. 2e585cb0 only added permission-card coverage, so this locks in
 * the consult card across all three surfaces it must survive: live, a mid-turn
 * reconnect (streaming card + replayed pre-card event), and a full reload.
 */

const ctx: HandlerContext = { terminalRef: { current: null }, queuedMessageStash: new Map() };

const assistantEvent = (
  text: string,
  toolUse: { id: string; name: string; input: Record<string, unknown> }[] = [],
): WsAgentEvent =>
  ({
    type: "agent_event",
    event: {
      type: "agent_assistant",
      content: [
        ...(text ? [{ type: "text" as const, text }] : []),
        ...toolUse.map((t) => ({ type: "tool_use" as const, ...t })),
      ],
    },
  }) as unknown as WsAgentEvent;

const toolResultEvent = (toolUseId: string, content: string): WsAgentEvent =>
  ({
    type: "agent_event",
    event: { type: "agent_tool_result", content: [{ type: "tool_result", tool_use_id: toolUseId, content }] },
  }) as unknown as WsAgentEvent;

const card = (over: Record<string, unknown> = {}) => ({
  cardId: "card-1",
  spawnId: "sp-1",
  subAgentId: "codex",
  status: "success",
  durationMs: 15000,
  costUsd: 0.03,
  outputMarkdown: "Favorite: Strong and specific.",
  createdAt: "2026-06-23T00:00:00.000Z",
  ...over,
});

const spawnEvent: WsSubAgentSpawn = { type: "sub_agent_spawn", spawnId: "sp-1", subAgentId: "codex" } as unknown as WsSubAgentSpawn;
const consultCardEvent: WsSubAgentConsultCard = { type: "sub_agent_consult_card", sessionId: "s1", card: card() } as unknown as WsSubAgentConsultCard;

/** The card is "visible" only if buildVisualElements emits a renderable element for it. */
const cardVisible = (): boolean => {
  const { messages } = useSessionStore.getState();
  return buildVisualElements(messages).some(
    (el) => el.kind === "message" && messages[el.index].subAgentConsult?.cardId === "card-1",
  );
};

beforeEach(() => {
  useSessionStore.setState({ messages: [], historyLoaded: true, subAgentSpawns: {} });
});

describe("consult card survival (docs/144, docs/220)", () => {
  it("stays visible through the live cross-agent sequence (Bash → spinner → card → tool_result → relayed prose)", () => {
    handleAgentEvent(ctx, assistantEvent("Let me ask Codex.", [{ id: "bash-1", name: "Bash", input: { command: "shipit agent run --agent codex --prompt-file -" } }]));
    handleSubAgentSpawn(ctx, spawnEvent);
    handleSubAgentConsultCard(ctx, consultCardEvent);
    expect(cardVisible()).toBe(true);

    // The Bash tool_result for the `shipit agent run` command lands on the card
    // (it is the last message); the merge must preserve the subAgentConsult field.
    handleAgentEvent(ctx, toolResultEvent("bash-1", "Favorite: Strong and specific."));
    expect(cardVisible()).toBe(true);

    // Parent relays Codex's take as prose, then the turn ends.
    handleAgentEvent(ctx, assistantEvent("Codex's take (relayed): ..."));
    handleAgentEvent(ctx, { type: "agent_event", event: { type: "agent_result" } } as unknown as WsAgentEvent);
    expect(cardVisible()).toBe(true);
  });

  it("survives a mid-turn reconnect: a streaming:true card is not clobbered by a replayed pre-card agent_assistant", () => {
    // loadSessionHistory maps inProgress -> streaming:true for an in-progress turn.
    useSessionStore.setState({ messages: [{ role: "assistant", text: "", subAgentConsult: card(), streaming: true }] as never });
    // The turn-event buffer replays the pre-card Bash agent_assistant on top of the snapshot.
    handleAgentEvent(ctx, assistantEvent("Let me ask Codex.", [{ id: "bash-1", name: "Bash", input: { command: "shipit agent run" } }]));
    expect(cardVisible()).toBe(true);
  });

  it("survives a full reload (clean server structure: bash group, card, relayed prose)", () => {
    useSessionStore.setState({
      messages: [
        { role: "assistant", text: "Let me ask Codex.", toolUse: [{ type: "tool_use", id: "bash-1", name: "Bash", input: { command: "shipit agent run" } }], toolResults: [{ toolUseId: "bash-1", content: "..." }], streaming: false },
        { role: "assistant", text: "", subAgentConsult: card(), streaming: false },
        { role: "assistant", text: "Codex's take (relayed): ...", streaming: false },
      ] as never,
    });
    expect(cardVisible()).toBe(true);
  });
});
