import { describe, it, expect, vi } from "vitest";
import {
  markAllSessionStatusesStale,
  markSessionStatusStale,
  recordSessionStatus,
  runStatusExclusive,
  takeOfferedActions,
} from "./session-status.js";
import type { SessionStatusDeps } from "./session-status.js";
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

  it("leaves an omitted field alone and clears needsYou on an empty string", async () => {
    const { d } = await seededCard();

    await recordSessionStatus(d, "s1", { needsYou: "Add the Stripe key." });
    const withNeeds = await recordSessionStatus(d, "s1", {});
    expect(withNeeds).toMatchObject({ status: "Routes done.", needsYou: "Add the Stripe key." });
    expect(withNeeds?.actions).toHaveLength(2);

    const cleared = await recordSessionStatus(d, "s1", { needsYou: "" });
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
