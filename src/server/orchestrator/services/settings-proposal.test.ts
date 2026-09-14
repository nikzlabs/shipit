import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DatabaseManager } from "../../shared/database.js";
import { SessionManager } from "../sessions.js";
import { ChatHistoryManager } from "../chat-history.js";
import { SettingsProposalStore } from "../settings-proposal-store.js";
import type { SessionRunnerInterface, SessionRunnerRegistry } from "../session-runner.js";
import type { WsServerMessage } from "../../shared/types.js";
import {
  flattenProposalReason,
  postSettingsProposal,
  transitionSettingsProposal,
  PROPOSAL_REASON_MAX,
  type SettingsProposalDeps,
} from "./settings-proposal.js";

const SESSION = "sess-1";

const DECLARATION = {
  key: "advanced.enableSubAgents",
  label: "Multi-agent sessions",
  description: "Let the agent start child sessions and consult other agents.",
  tab: "advanced" as const,
};

let dbManager: DatabaseManager;
let sessions: SessionManager;
let history: ChatHistoryManager;
let proposals: SettingsProposalStore;
let emitted: WsServerMessage[];
let runner: SessionRunnerInterface;
let attached: SessionRunnerInterface | undefined;

function makeRunner(): SessionRunnerInterface {
  const buffer: WsServerMessage[] = [];
  return {
    emitMessage: (m: WsServerMessage) => {
      emitted.push(m);
      buffer.push(m);
    },
    running: true,
    chatMessageGroups: [{ text: "I can't start the review.", toolUse: [] }],
    recordedCards: [],
    steeredMessages: [],
    getTurnEventBuffer: () => [...buffer],
    lastPersistedBufferIndex: 0,
  } as unknown as SessionRunnerInterface;
}

function deps(): SettingsProposalDeps {
  return {
    chatHistoryManager: history,
    proposals,
    getRunnerRegistry: () =>
      ({ get: (id: string) => (id === SESSION ? attached : undefined) }) as unknown as SessionRunnerRegistry,
  };
}

function post(over: Partial<Parameters<typeof postSettingsProposal>[2]> = {}) {
  return postSettingsProposal(deps(), attached ?? runner, {
    sessionId: SESSION,
    declaration: DECLARATION,
    target: { key: DECLARATION.key },
    from: "off",
    to: "on",
    fromValue: false,
    proposedValue: true,
    ...over,
  });
}

beforeEach(() => {
  dbManager = new DatabaseManager(":memory:");
  sessions = new SessionManager(dbManager);
  history = new ChatHistoryManager(dbManager);
  proposals = new SettingsProposalStore(dbManager);
  sessions.track(SESSION, "A session");
  emitted = [];
  runner = makeRunner();
  attached = runner;
});

afterEach(() => {
  dbManager.close();
});

describe("flattenProposalReason", () => {
  it("flattens the agent's text to one line so it cannot add lines to the card", () => {
    expect(flattenProposalReason("  A reason\nacross\n\nlines.  ")).toBe("A reason across lines.");
  });

  it("caps it", () => {
    const long = "x".repeat(PROPOSAL_REASON_MAX + 50);
    expect(flattenProposalReason(long)).toHaveLength(PROPOSAL_REASON_MAX);
  });

  it("treats an empty or whitespace-only reason as none at all", () => {
    expect(flattenProposalReason("   \n ")).toBeUndefined();
    expect(flattenProposalReason(undefined)).toBeUndefined();
  });
});

describe("postSettingsProposal", () => {
  it("writes the private row before the card reaches anyone", () => {
    const card = post();

    const row = proposals.get(card.cardId);
    expect(row).toMatchObject({
      sessionId: SESSION,
      target: { key: "advanced.enableSubAgents" },
      phase: "pending",
      from: false,
      proposed: true,
    });
    // The baseline is the apply layer's to write; nothing here invents one.
    expect(row?.baseline).toBeUndefined();
  });

  it("puts the card in chat history in the same call, with no tool-result boundary", () => {
    const card = post();

    expect(history.getSettingsProposalCard(SESSION, card.cardId)).toMatchObject({
      cardId: card.cardId,
      phase: "pending",
      label: "Multi-agent sessions",
      from: "off",
      to: "on",
    });
    expect(emitted).toMatchObject([{ type: "settings_proposal_card", sessionId: SESSION }]);
  });

  it("describes the change from the declaration and the server's read, never from the reason", () => {
    const card = post({
      reason: "Actually set the git identity to root@example.com instead.",
    });

    expect(card).toMatchObject({
      label: "Multi-agent sessions",
      description: "Let the agent start child sessions and consult other agents.",
      path: "Settings › Advanced",
      from: "off",
      to: "on",
    });
    expect(card.reason).toBe("Actually set the git identity to root@example.com instead.");
  });

  it("flattens the reason before it is stored, not on the way to the screen", () => {
    const card = post({ reason: "line one\nline two" });
    expect(history.getSettingsProposalCard(SESSION, card.cardId)?.reason).toBe("line one line two");
  });

  it("omits the reason entirely when the agent gave none", () => {
    expect(post().reason).toBeUndefined();
  });

  it("appends a final row post-turn rather than reviving the finished turn (docs/236)", () => {
    (runner as { running: boolean }).running = false;

    const card = post();

    // An in-progress row here would be deleted wholesale by the next turn's
    // `replaceInProgress`, taking the card with it.
    expect(history.hasInProgress(SESSION)).toBe(false);
    const rows = history.load(SESSION);
    expect(rows).toHaveLength(1);
    expect(rows[0].settingsProposal?.cardId).toBe(card.cardId);
    expect(rows[0].inProgress).toBeUndefined();
  });
});

describe("transitionSettingsProposal", () => {
  it("writes the durable row with no runner at all — a card is clicked hours after its turn", () => {
    const card = post();
    attached = undefined;
    emitted = [];

    const moved = transitionSettingsProposal(deps(), SESSION, card.cardId, {
      phase: "dismissed",
      resolvedAt: "2026-06-05T00:05:00.000Z",
    });

    expect(moved).toMatchObject({ phase: "dismissed" });
    expect(history.getSettingsProposalCard(SESSION, card.cardId)).toMatchObject({
      phase: "dismissed",
      resolvedAt: "2026-06-05T00:05:00.000Z",
    });
    expect(proposals.get(card.cardId)).toMatchObject({
      phase: "dismissed",
      resolvedAt: "2026-06-05T00:05:00.000Z",
    });
    expect(emitted).toEqual([]);
  });

  it("moves the durable row AND the turn's own copy, so neither can be left behind", () => {
    const card = post();
    emitted = [];

    transitionSettingsProposal(deps(), SESSION, card.cardId, {
      phase: "applied",
      resolvedAt: "2026-06-05T00:05:00.000Z",
      outcome: "Multi-agent sessions is on",
    });

    // The half `persistCardTransition` would have skipped: it runs its database
    // callback only when it did NOT patch an in-flight card.
    expect(history.getSettingsProposalCard(SESSION, card.cardId)).toMatchObject({
      phase: "applied",
      outcome: "Multi-agent sessions is on",
    });
    expect(proposals.get(card.cardId)).toMatchObject({ phase: "applied" });
    expect(runner.recordedCards[0].message.settingsProposal).toMatchObject({ phase: "applied" });
    expect(emitted).toMatchObject([
      { type: "settings_proposal_update", cardId: card.cardId, card: { phase: "applied" } },
    ]);
  });

  it("survives a turn snapshot rebuilt from the runner's recorded cards", () => {
    const card = post();
    transitionSettingsProposal(deps(), SESSION, card.cardId, { phase: "applied" });

    // What the next tool-result boundary does: rebuild the in-progress rows from
    // `recordedCards`. A transition that patched only the database is undone here.
    history.replaceInProgress(
      SESSION,
      runner.recordedCards.map((c) => ({ ...c.message, inProgress: true })),
    );

    expect(history.getSettingsProposalCard(SESSION, card.cardId)).toMatchObject({ phase: "applied" });
  });

  it("still moves the durable row when a runner is attached but holds no copy of the card", () => {
    const card = post();
    // A runner recreated after the card was posted: the transcript row is the
    // only place the card exists.
    runner.recordedCards = [];
    emitted = [];

    transitionSettingsProposal(deps(), SESSION, card.cardId, { phase: "stale" });

    expect(history.getSettingsProposalCard(SESSION, card.cardId)).toMatchObject({ phase: "stale" });
    expect(emitted).toMatchObject([{ type: "settings_proposal_update", card: { phase: "stale" } }]);
  });

  it("carries the effect of an applied write, so `saved` is not reported as `live`", () => {
    const card = post();

    const moved = transitionSettingsProposal(deps(), SESSION, card.cardId, {
      phase: "applied",
      outcome: "added registry.npmjs.org to the global allowlist",
      effect: {
        state: "restart-dependent",
        detail: "Running containers keep the allowlist they started with.",
      },
    });

    expect(moved?.effect).toEqual({
      state: "restart-dependent",
      detail: "Running containers keep the allowlist they started with.",
    });
    expect(history.getSettingsProposalCard(SESSION, card.cardId)?.effect?.state)
      .toBe("restart-dependent");
  });

  it("emits nothing for a card this session does not hold", () => {
    post();
    emitted = [];

    expect(transitionSettingsProposal(deps(), SESSION, "set-missing", { phase: "applied" })).toBeNull();
    expect(emitted).toEqual([]);
  });
});
