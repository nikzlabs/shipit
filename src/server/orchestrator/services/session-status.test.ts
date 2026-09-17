import { describe, it, expect, vi } from "vitest";
import {
  clearConversationThread,
  formatSessionStatusContext,
  MAX_STATUS_CONTEXT_CHARS,
  markAllSessionStatusesStale,
  markSessionStatusStale,
  recordSessionStatus,
  runStatusExclusive,
  sessionStatusTurnContext,
  shouldNudgeForStatusCard,
  statusNudgePrompt,
  takeOfferedActions,
} from "./session-status.js";
import type { SessionStatusDeps, TurnStatusFacts } from "./session-status.js";
import type { SessionManager } from "../sessions.js";
import type { SessionStatus } from "../../shared/types.js";

/** Stores what it is given, so reconciliation runs against a real previous card. */
function fakeSessions(seed: Record<string, SessionStatus | undefined> = {}) {
  const cards = new Map<string, SessionStatus | undefined>(Object.entries(seed));
  const known = new Set<string>(Object.keys(seed));
  return {
    cards,
    track: (id: string) => known.add(id),
    get: (id: string) => (known.has(id) ? { id, sessionStatus: cards.get(id) } : undefined),
    list: () => [],
    setSessionStatus: vi.fn((id: string, status: SessionStatus | null) => {
      cards.set(id, status ?? undefined);
    }),
    sessionIdsWithStatus: () => [...cards.keys()].filter((id) => cards.get(id)),
  };
}

function deps(sessions: ReturnType<typeof fakeSessions>) {
  const sseBroadcast = vi.fn<(event: string, data: unknown) => void>();
  return {
    sessionManager: sessions as unknown as SessionStatusDeps["sessionManager"],
    sseBroadcast,
  };
}

const item = (over: Record<string, unknown> = {}) => ({
  id: "webhook",
  label: "Wire the webhook",
  payload: "Add the webhook route.",
  ...over,
});

async function seededCard(): Promise<{
  sessions: ReturnType<typeof fakeSessions>;
  d: ReturnType<typeof deps>;
  card: SessionStatus;
}> {
  const sessions = fakeSessions();
  sessions.track("s1");
  const d = deps(sessions);
  const card = await recordSessionStatus(d, "s1", {
    status: "Routes done.",
    actions: [item(), item({ id: "readme", label: "Add a README section", payload: "Write it." })],
    branch: "shipit/x",
    headSha: "abc12345",
  });
  return { sessions, d, card: card! };
}

describe("recordSessionStatus", () => {
  it("stores the card, marks it current and broadcasts", async () => {
    const { d, card } = await seededCard();

    expect(card).toMatchObject({ status: "Routes done.", fresh: true, writeSeq: 1 });
    expect(card.actions).toHaveLength(2);
    expect(card.actions[0]).toMatchObject({ branch: "shipit/x", headSha: "abc12345" });
    expect(card.actions[0].offerId).not.toBe(card.actions[1].offerId);
    expect(d.sseBroadcast).toHaveBeenCalledWith("session_list", { sessions: [] });
  });

  it("rewrites or drops the last-turn line on every write, never carrying it (req 31)", async () => {
    const { d } = await seededCard();

    const first = await recordSessionStatus(d, "s1", { lastTurn: "Wired the webhook route." });
    expect(first).toMatchObject({ lastTurn: "Wired the webhook route." });

    const second = await recordSessionStatus(d, "s1", { lastTurn: "Fixed the signature check." });
    expect(second).toMatchObject({ lastTurn: "Fixed the signature check." });

    // The bare confirming call says the SESSION still holds; it is not a claim
    // about a turn, so the previous turn's line goes.
    const confirmed = await recordSessionStatus(d, "s1", {});
    expect(confirmed?.lastTurn).toBeUndefined();
    expect(confirmed).toMatchObject({ status: "Routes done." });
  });

  it("broadcasts when only the last-turn line moved", async () => {
    const { d } = await seededCard();
    d.sseBroadcast.mockClear();

    await recordSessionStatus(d, "s1", { status: "Routes done.", lastTurn: "Ran the suite." });
    expect(d.sseBroadcast).toHaveBeenCalledWith("session_list", { sessions: [] });
  });

  it("leaves an omitted field alone and clears needsYou on an empty list", async () => {
    const { d } = await seededCard();

    await recordSessionStatus(d, "s1", { needsYou: ["Add the Stripe key.", "Merge PR #212."] });
    const withNeeds = await recordSessionStatus(d, "s1", {});
    expect(withNeeds).toMatchObject({
      status: "Routes done.",
      needsYou: ["Add the Stripe key.", "Merge PR #212."],
    });
    expect(withNeeds?.actions).toHaveLength(2);

    const cleared = await recordSessionStatus(d, "s1", { needsYou: [] });
    expect(cleared?.needsYou).toBeUndefined();
  });

  it("counts an unchanged confirmation as a write, and shows nothing new", async () => {
    const { d, card } = await seededCard();
    d.sseBroadcast.mockClear();

    const confirmed = await recordSessionStatus(d, "s1", {});

    // req 14 — the agent confirmed the whole card. Nothing a viewer reads moved,
    // so there is nothing to broadcast, but the turn DID write.
    expect(confirmed?.writeSeq).toBe(card.writeSeq + 1);
    expect(confirmed?.fresh).toBe(true);
    expect(d.sseBroadcast).not.toHaveBeenCalled();
  });

  it("makes a bare call on a stale card current, and counts as a write", async () => {
    const { d, card } = await seededCard();
    await markSessionStatusStale(d, "s1", card.writeSeq);
    d.sseBroadcast.mockClear();

    const confirmed = await recordSessionStatus(d, "s1", {});

    expect(confirmed).toMatchObject({ fresh: true, writeSeq: 2 });
    expect(d.sseBroadcast).toHaveBeenCalledTimes(1);
  });

  it("writes nothing for a bare call with no card, or for a session that is gone", async () => {
    const sessions = fakeSessions();
    sessions.track("s1");
    const d = deps(sessions);

    expect(await recordSessionStatus(d, "s1", {})).toBeNull();
    expect(await recordSessionStatus(d, "deleted", { status: "x" })).toBeNull();
    expect(sessions.setSessionStatus).not.toHaveBeenCalled();
    expect(d.sseBroadcast).not.toHaveBeenCalled();

    expect(await recordSessionStatus(d, "s1", { status: "First." })).not.toBeNull();
  });
});

describe("offer reconciliation", () => {
  it("keeps the offerId and the taken state of an item that did not change", async () => {
    const { d, card } = await seededCard();
    const kept = card.actions[0];
    await takeOfferedActions(d, "s1", [kept.offerId]);

    const after = await recordSessionStatus(d, "s1", {
      actions: [item()],
      replaceActions: true,
    });

    expect(after?.actions).toHaveLength(1);
    expect(after?.actions[0].offerId).toBe(kept.offerId);
    expect(after?.actions[0].offeredAt).toBe(kept.offeredAt);
    expect(after?.actions[0].takenAt).toBeDefined();
  });

  it("gives an item whose payload moved a new identity, untaken", async () => {
    const { d, card } = await seededCard();
    await takeOfferedActions(d, "s1", [card.actions[0].offerId]);

    const after = await recordSessionStatus(d, "s1", {
      actions: [item({ payload: "Add the webhook route AND its retry." })],
    });

    const renewed = after!.actions.find((offer) => offer.id === "webhook")!;
    expect(renewed.offerId).not.toBe(card.actions[0].offerId);
    expect(renewed.takenAt).toBeUndefined();
    // Replaced in place rather than appended, so the list keeps its order.
    expect(after!.actions.map((offer) => offer.id)).toEqual(["webhook", "readme"]);
  });

  it("adds to the offered list by default and replaces it on request", async () => {
    const { d } = await seededCard();

    const added = await recordSessionStatus(d, "s1", {
      actions: [item({ id: "retry", label: "Add retry on 5xx", payload: "Retry 5xx." })],
    });
    expect(added?.actions.map((offer) => offer.id)).toEqual(["webhook", "readme", "retry"]);

    const replaced = await recordSessionStatus(d, "s1", {
      actions: [item({ id: "retry", label: "Add retry on 5xx", payload: "Retry 5xx." })],
      replaceActions: true,
    });
    expect(replaced?.actions.map((offer) => offer.id)).toEqual(["retry"]);
  });

  it("clears the offers on an empty replacement", async () => {
    const { d } = await seededCard();
    const cleared = await recordSessionStatus(d, "s1", { actions: [], replaceActions: true });
    expect(cleared?.actions).toEqual([]);
  });
});

describe("takeOfferedActions", () => {
  it("stamps the named offers and marks nothing for an unknown id", async () => {
    const { d, card } = await seededCard();
    d.sseBroadcast.mockClear();

    await takeOfferedActions(d, "s1", ["not-an-offer"]);
    expect(d.sseBroadcast).not.toHaveBeenCalled();

    await takeOfferedActions(d, "s1", [card.actions[1].offerId]);
    const stored = d.sessionManager.get("s1")!.sessionStatus!;
    expect(stored.actions[0].takenAt).toBeUndefined();
    expect(stored.actions[1].takenAt).toBeDefined();
    expect(d.sseBroadcast).toHaveBeenCalledTimes(1);
  });

  it("does not move writeSeq: the user acted, the agent did not write", async () => {
    const { d, card } = await seededCard();
    await takeOfferedActions(d, "s1", [card.actions[0].offerId]);
    expect(d.sessionManager.get("s1")!.sessionStatus!.writeSeq).toBe(card.writeSeq);
  });
});

describe("markSessionStatusStale", () => {
  it("marks the card and broadcasts", async () => {
    const { d, card } = await seededCard();
    d.sseBroadcast.mockClear();

    await markSessionStatusStale(d, "s1", card.writeSeq);

    expect(d.sessionManager.get("s1")!.sessionStatus!.fresh).toBe(false);
    expect(d.sseBroadcast).toHaveBeenCalledTimes(1);
  });

  it("is a no-op once a later turn wrote the card", async () => {
    const { d, card } = await seededCard();
    await recordSessionStatus(d, "s1", { status: "Ready to merge." });
    d.sseBroadcast.mockClear();

    await markSessionStatusStale(d, "s1", card.writeSeq);

    expect(d.sessionManager.get("s1")!.sessionStatus!.fresh).toBe(true);
    expect(d.sseBroadcast).not.toHaveBeenCalled();
  });

  it("leaves writeSeq alone: a freshness mark is not an agent write", async () => {
    const { d, card } = await seededCard();
    await markSessionStatusStale(d, "s1", card.writeSeq);
    expect(d.sessionManager.get("s1")!.sessionStatus!.writeSeq).toBe(card.writeSeq);
  });

  it("stays quiet on an already stale card and on a session with none", async () => {
    const { d, card } = await seededCard();
    await markSessionStatusStale(d, "s1", card.writeSeq);
    d.sseBroadcast.mockClear();

    await markSessionStatusStale(d, "s1", card.writeSeq);
    await markSessionStatusStale(d, "s2", 1);

    expect(d.sseBroadcast).not.toHaveBeenCalled();
  });
});

describe("markAllSessionStatusesStale", () => {
  it("marks every stored card once and broadcasts once", async () => {
    const sessions = fakeSessions({
      s1: { status: "a", actions: [], fresh: true, writeSeq: 3 },
      s2: { status: "b", actions: [], fresh: false, writeSeq: 1 },
    });
    const d = deps(sessions);

    await markAllSessionStatusesStale(d);

    expect(sessions.cards.get("s1")!.fresh).toBe(false);
    // Unchanged records are not rewritten, and `writeSeq` never moves here.
    expect(sessions.setSessionStatus).toHaveBeenCalledTimes(1);
    expect(sessions.cards.get("s1")!.writeSeq).toBe(3);
    expect(d.sseBroadcast).toHaveBeenCalledTimes(1);
  });

  // The sweep queues sessions one at a time, so a turn can accept a write for a
  // later session while it runs — with the setting already on, so that card was
  // confirmed and must stay current.
  it("does not mark a card written after the sweep began", async () => {
    const sessions = fakeSessions({
      s1: { status: "a", actions: [], fresh: true, writeSeq: 1 },
      s2: { status: "b", actions: [], fresh: true, writeSeq: 1 },
    });
    const d = deps(sessions);

    const sweep = markAllSessionStatusesStale(d);
    await recordSessionStatus(d, "s2", { status: "written during the sweep" });
    await sweep;

    expect(sessions.cards.get("s1")!.fresh).toBe(false);
    expect(sessions.cards.get("s2")).toMatchObject({
      status: "written during the sweep",
      fresh: true,
      writeSeq: 2,
    });
  });

  it("marks the rest when one session's write fails, and says what failed", async () => {
    const sessions = fakeSessions({
      s1: { status: "a", actions: [], fresh: true, writeSeq: 1 },
      s2: { status: "b", actions: [], fresh: true, writeSeq: 1 },
    });
    sessions.setSessionStatus.mockImplementationOnce(() => { throw new Error("disk full"); });
    const d = deps(sessions);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    await markAllSessionStatusesStale(d);

    expect(sessions.cards.get("s1")!.fresh).toBe(true);
    expect(sessions.cards.get("s2")!.fresh).toBe(false);
    expect(logged).toHaveBeenCalledWith(expect.stringContaining("s1"), expect.any(Error));
    expect(d.sseBroadcast).toHaveBeenCalledTimes(1);
    logged.mockRestore();
  });

  it("broadcasts nothing when every card is already stale", async () => {
    const d = deps(fakeSessions({ s1: { status: "a", actions: [], fresh: false, writeSeq: 1 } }));
    await markAllSessionStatusesStale(d);
    expect(d.sseBroadcast).not.toHaveBeenCalled();
  });
});

describe("runStatusExclusive", () => {
  it("serializes per session and runs different sessions independently", async () => {
    const order: string[] = [];
    const gate: (() => void)[] = [];
    const block = (name: string) => runStatusExclusive("gated", async () => {
      order.push(`${name}:start`);
      await new Promise<void>((resolve) => gate.push(resolve));
      order.push(`${name}:end`);
    });

    const first = block("a");
    const second = block("b");
    const other = runStatusExclusive("other-session", async () => { order.push("other"); });
    await other;

    expect(order).toEqual(["a:start", "other"]);
    gate[0]();
    await first;
    await new Promise((resolve) => setTimeout(resolve, 0));
    gate[1]();
    await second;
    expect(order).toEqual(["a:start", "other", "a:end", "b:start", "b:end"]);
  });

  // The helper test above proves the lock works; this proves each service uses
  // it. Bypassing the wrappers leaves these assertions passing otherwise.
  it("holds every service entry point behind the session's lock", async () => {
    const { d, card } = await seededCard();
    let release = () => {};
    const held = runStatusExclusive("s1", () => new Promise<void>((resolve) => { release = resolve; }));
    (d.sessionManager.setSessionStatus as ReturnType<typeof vi.fn>).mockClear();

    const pending = [
      recordSessionStatus(d, "s1", { status: "later" }),
      markSessionStatusStale(d, "s1", card.writeSeq),
      takeOfferedActions(d, "s1", [card.actions[0].offerId]),
    ];
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(d.sessionManager.setSessionStatus).not.toHaveBeenCalled();

    release();
    await held;
    await Promise.all(pending);
    expect(d.sessionManager.setSessionStatus).toHaveBeenCalled();
  });

  it("lets the next operation run after one throws", async () => {
    await expect(runStatusExclusive("s3", () => Promise.reject(new Error("boom"))))
      .rejects.toThrow("boom");
    await expect(runStatusExclusive("s3", () => Promise.resolve("ok"))).resolves.toBe("ok");
  });

  it("keeps a concurrent stale mark behind an agent write", async () => {
    const { d, card } = await seededCard();

    await Promise.all([
      recordSessionStatus(d, "s1", { status: "Ready to merge." }),
      markSessionStatusStale(d, "s1", card.writeSeq),
    ]);

    // The mark ran second and saw a moved writeSeq, so the new card stays current.
    expect(d.sessionManager.get("s1")!.sessionStatus).toMatchObject({
      status: "Ready to merge.",
      fresh: true,
    });
  });
});

describe("clearConversationThread", () => {
  it("marks the card stale and tells viewers, once", async () => {
    const { d } = await seededCard();
    const cleared = { calls: 0 };
    const sessions = {
      clearAgentSessionId: () => {
        cleared.calls += 1;
        const stored = d.sessionManager.get("s1")!.sessionStatus!;
        if (!stored.fresh) return false;
        d.sessionManager.setSessionStatus("s1", { ...stored, fresh: false });
        return true;
      },
      list: () => [],
    };
    const deps = { sessionManager: sessions as never, sseBroadcast: vi.fn() };

    clearConversationThread(deps, "s1");
    expect(d.sessionManager.get("s1")!.sessionStatus!.fresh).toBe(false);
    expect(deps.sseBroadcast).toHaveBeenCalledWith("session_list", { sessions: [] });

    // An already-stale card is not a change, so viewers are not told again.
    clearConversationThread(deps, "s1");
    expect(cleared.calls).toBe(2);
    expect(deps.sseBroadcast).toHaveBeenCalledTimes(1);
  });

  it("clears the thread even where no broadcast is wired", () => {
    const cleared: string[] = [];
    const sessions = { clearAgentSessionId: (id: string) => { cleared.push(id); return true; }, list: () => [] };
    clearConversationThread({ sessionManager: sessions as never }, "s1");
    expect(cleared).toEqual(["s1"]);
  });
});

describe("shouldNudgeForStatusCard (docs/303 req 12–15)", () => {
  const plainTurn = (over: Partial<TurnStatusFacts> = {}): TurnStatusFacts => ({
    statusUpdated: false,
    wasInterrupted: false,
    receivedResult: true,
    harnessCommand: false,
    statusNudge: false,
    steered: false,
    promptQueued: false,
    postTurn: "commit-push",
    writeSeq: 3,
    ...over,
  });

  it("nudges a turn that produced a result and did not write the card", () => {
    expect(shouldNudgeForStatusCard(plainTurn(), { writeSeq: 3 }, false)).toBe(true);
  });

  it("nudges a session that has no card at all yet (req 22 — the first ordinary turn writes it)", () => {
    expect(shouldNudgeForStatusCard(plainTurn({ writeSeq: 0 }), undefined, false)).toBe(true);
  });

  const noCases: [string, Partial<TurnStatusFacts>][] = [
    ["the agent wrote or confirmed the card", { statusUpdated: true }],
    ["the turn was interrupted — a question, a plan approval or a stop", { wasInterrupted: true }],
    ["no result came back — a crash has its own recovery", { receivedResult: false }],
    ["the harness ran the prompt as its own command — compaction, a goal command", { harnessCommand: true }],
    ["the turn was itself a nudge (req 15: one attempt)", { statusNudge: true }],
    ["a driver owns the turn", { postTurn: "none" }],
  ];
  for (const [why, over] of noCases) {
    it(`does not nudge when ${why}`, () => {
      expect(shouldNudgeForStatusCard(plainTurn(over), { writeSeq: 3 }, false)).toBe(false);
    });
  }

  it("does not nudge when a later turn already wrote the card", () => {
    expect(shouldNudgeForStatusCard(plainTurn({ writeSeq: 3 }), { writeSeq: 4 }, false)).toBe(false);
  });

  it("defers while a successor is running or queued", () => {
    expect(shouldNudgeForStatusCard(plainTurn(), { writeSeq: 3 }, true)).toBe(false);
  });
});

describe("statusNudgePrompt", () => {
  it("opens with [ShipIt] and asks for one call, bare if nothing changed", () => {
    const prompt = statusNudgePrompt(undefined);
    expect(prompt.startsWith("[ShipIt]")).toBe(true);
    expect(prompt).toContain("session_status");
    expect(prompt).toContain("no arguments");
  });

  it("carries the whole card and asks for a reconciliation, not just a call (req 35)", async () => {
    const { d } = await seededCard();
    const stored = d.sessionManager.get("s1")!.sessionStatus!;
    await takeOfferedActions(d, "s1", [stored.actions[0]!.offerId]);

    const prompt = statusNudgePrompt(d.sessionManager.get("s1")!.sessionStatus);
    expect(prompt).toContain(formatSessionStatusContext(d.sessionManager.get("s1")!.sessionStatus));
    expect(prompt).toContain("Routes done.");
    expect(prompt).toContain("Add the webhook route.");
    expect(prompt).toContain("ALREADY SENT");
  });
});

describe("formatSessionStatusContext (docs/303 req 35)", () => {
  it("is empty for a session with no card, so a new session carries nothing", () => {
    expect(formatSessionStatusContext(undefined)).toBe("");
  });

  it("carries the status, the manual steps and every offer with its payload and sent state", async () => {
    const { d } = await seededCard();
    await recordSessionStatus(d, "s1", { needsYou: ["Paste the Stripe key."] });
    const stored = d.sessionManager.get("s1")!.sessionStatus!;
    await takeOfferedActions(d, "s1", [stored.actions[0]!.offerId]);

    const block = formatSessionStatusContext(d.sessionManager.get("s1")!.sessionStatus);
    expect(block).toContain("<session_status_card>");
    expect(block).toContain("Routes done.");
    expect(block).toContain("- Paste the Stripe key.");
    expect(block).toContain("id: webhook — ALREADY SENT to you");
    expect(block).toContain("payload: Add the webhook route.");
    expect(block).toContain("id: readme");
    expect(block).not.toContain("readme — ALREADY SENT");
    expect(block.endsWith("</session_status_card>")).toBe(true);
  });

  it("leaves out the last-turn line, which every write rewrites or clears (req 31)", async () => {
    const { d } = await seededCard();
    await recordSessionStatus(d, "s1", { lastTurn: "Wired the webhook route." });
    const block = formatSessionStatusContext(d.sessionManager.get("s1")!.sessionStatus);
    expect(block).not.toContain("Wired the webhook route.");
  });

  it("stays within the cap by withholding payloads, and still lists every offer", async () => {
    const { d } = await seededCard();
    const bulky = Array.from({ length: 12 }, (_, i) =>
      item({ id: `big-${i}`, label: `Offer ${i}`, payload: "x".repeat(1500) }),
    );
    await recordSessionStatus(d, "s1", { actions: bulky, replaceActions: true });

    const card = d.sessionManager.get("s1")!.sessionStatus!;
    const block = formatSessionStatusContext(card);
    expect(block.length).toBeLessThanOrEqual(MAX_STATUS_CONTEXT_CHARS);
    // req 35 asks that the agent see each offer, so the cap falls on the payloads.
    for (const offer of card.actions) expect(block).toContain(`- id: ${offer.id}`);
    // And it says so, because a replacement it cannot copy exactly would drop them.
    expect(block).toContain("Do NOT use `replaceActions` this turn");
    // Never half a payload: a truncated one is echoed back as a changed offer.
    const printed = block.split("\n").filter((line) => line.startsWith("  payload: "));
    for (const line of printed) {
      expect(line === "  payload: (not printed this turn — too long)"
        || line === `  payload: ${"x".repeat(1500)}`).toBe(true);
    }
  });

  it("shrinks the listing itself only when the ids alone do not fit, and warns then too", async () => {
    const { d } = await seededCard();
    const many = Array.from({ length: 40 }, (_, i) =>
      item({ id: `o-${i}`.padEnd(60, "z"), label: `Offer ${i}`.padEnd(118, "y"), payload: "p" }),
    );
    await recordSessionStatus(d, "s1", { actions: many, replaceActions: true });

    const block = formatSessionStatusContext(d.sessionManager.get("s1")!.sessionStatus);
    expect(block.length).toBeLessThanOrEqual(MAX_STATUS_CONTEXT_CHARS);
    expect(block).toContain("further offer(s) are on the card, not listed here.");
    expect(block).toContain("Do NOT use `replaceActions` this turn");
  });

  it("prints every payload and no warning on an ordinary card", async () => {
    const { d } = await seededCard();
    const block = formatSessionStatusContext(d.sessionManager.get("s1")!.sessionStatus);
    expect(block).not.toContain("not printed this turn");
    expect(block).not.toContain("replaceActions");
  });
});

describe("sessionStatusTurnContext (docs/303 req 21, 35)", () => {
  const sessionManager = {
    get: (id: string) =>
      id === "s1"
        ? { id, sessionStatus: { status: "Billing service.", actions: [], fresh: true, writeSeq: 1 } }
        : undefined,
  } as unknown as SessionManager;

  it("sends nothing while the setting is off", () => {
    const ctx = sessionStatusTurnContext(
      { sessionManager, credentialStore: { getSessionStatusCard: () => false } },
      "s1",
    );
    expect(ctx).toBe("");
  });

  it("sends nothing for a session with no stored card", () => {
    const ctx = sessionStatusTurnContext(
      { sessionManager, credentialStore: { getSessionStatusCard: () => true } },
      "other",
    );
    expect(ctx).toBe("");
  });

  it("renders the stored card while the setting is on", () => {
    const ctx = sessionStatusTurnContext(
      { sessionManager, credentialStore: { getSessionStatusCard: () => true } },
      "s1",
    );
    expect(ctx).toContain("Billing service.");
  });
});
