import { randomUUID } from "node:crypto";
import type { ActionChecklistItem, OfferedAction, SessionStatus } from "../../shared/types.js";
import type { ValidatedSessionStatus } from "../../shared/session-status-validation.js";
import type { SessionManager } from "../sessions.js";

export interface SessionStatusDeps {
  sessionManager: Pick<SessionManager, "get" | "list" | "setSessionStatus" | "sessionIdsWithStatus">;
  sseBroadcast: (event: string, data: unknown) => void;
}

/** Provenance of the offers a call creates, captured by the route (docs/303 → Call path). */
export interface SessionStatusWrite extends ValidatedSessionStatus {
  branch?: string;
  headSha?: string;
}

const statusChains = new Map<string, Promise<unknown>>();

/**
 * One status operation per session at a time, so a stale mark and an agent write
 * cannot interleave. Copied from `runGoalExclusive` (`agent-goal.ts`), whose
 * chain never rejects, so awaiting the tail cannot fail.
 */
export function runStatusExclusive<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  const previous = statusChains.get(sessionId) ?? Promise.resolve();
  const next = (async () => {
    await previous;
    return fn();
  })();
  const tail = next.catch(() => undefined);
  statusChains.set(sessionId, tail);
  void (async () => {
    await tail;
    if (statusChains.get(sessionId) === tail) statusChains.delete(sessionId);
  })();
  return next;
}

/** What a viewer reads. `writeSeq` is bookkeeping, so a bump alone is not a change. */
function shown(card: SessionStatus | undefined): string {
  if (!card) return "";
  return JSON.stringify({
    status: card.status,
    needsYou: card.needsYou ?? "",
    fresh: card.fresh,
    actions: card.actions,
  });
}

function broadcast(deps: SessionStatusDeps): void {
  deps.sseBroadcast("session_list", { sessions: deps.sessionManager.list() });
}

function sameOffer(stored: OfferedAction, item: ActionChecklistItem): boolean {
  return stored.id === item.id && stored.label === item.label && stored.payload === item.payload;
}

function newOffer(
  item: ActionChecklistItem,
  write: SessionStatusWrite,
  now: string,
): OfferedAction {
  return {
    ...item,
    offerId: randomUUID(),
    offeredAt: now,
    ...(write.branch ? { branch: write.branch } : {}),
    ...(write.headSha ? { headSha: write.headSha } : {}),
  };
}

/**
 * docs/303 req 17 — the agent's `id` is a name, not the identity.
 *
 * An item that repeats a stored offer unchanged keeps its `offerId`, its
 * provenance and its taken state, so a replacement that repeats a taken offer
 * leaves it taken. An item whose id matches but whose label or payload moved is
 * a different offer: it gets a new `offerId` and arrives untaken, so a submit
 * composed before the change marks nothing.
 */
function reconcileOffers(
  storedActions: OfferedAction[],
  write: SessionStatusWrite,
  now: string,
): OfferedAction[] {
  const items = write.actions;
  if (!items) return storedActions;

  const carry = (item: ActionChecklistItem): OfferedAction => {
    const previous = storedActions.find((offer) => offer.id === item.id);
    if (!previous || !sameOffer(previous, item)) return newOffer(item, write, now);
    return {
      ...item,
      offerId: previous.offerId,
      offeredAt: previous.offeredAt,
      ...(previous.branch ? { branch: previous.branch } : {}),
      ...(previous.headSha ? { headSha: previous.headSha } : {}),
      ...(previous.takenAt ? { takenAt: previous.takenAt } : {}),
    };
  };

  if (write.replaceActions === true) return items.map(carry);

  const added = items.filter((item) => !storedActions.some((offer) => offer.id === item.id));
  const merged = storedActions.map((offer) => {
    const item = items.find((candidate) => candidate.id === offer.id);
    return item ? carry(item) : offer;
  });
  return [...merged, ...added.map((item) => newOffer(item, write, now))];
}

/**
 * Any accepted agent call: merges the delta into the stored card, bumps
 * `writeSeq` and marks the card current. A call with no fields is the agent
 * confirming the card (req 14) and still counts as a write.
 */
export function recordSessionStatus(
  deps: SessionStatusDeps,
  sessionId: string,
  write: SessionStatusWrite,
): Promise<SessionStatus | null> {
  return runStatusExclusive(sessionId, async () => {
    const session = deps.sessionManager.get(sessionId);
    if (!session) return null;
    const stored = session.sessionStatus;
    const status = write.status ?? stored?.status;
    // The route refuses a call that leaves the card without one.
    if (status === undefined) return null;

    const now = new Date().toISOString();
    const needsYou = write.needsYou ?? stored?.needsYou ?? "";
    const card: SessionStatus = {
      status,
      ...(needsYou ? { needsYou } : {}),
      actions: reconcileOffers(stored?.actions ?? [], write, now),
      fresh: true,
      writeSeq: (stored?.writeSeq ?? 0) + 1,
    };
    const before = shown(stored);
    deps.sessionManager.setSessionStatus(sessionId, card);
    if (shown(card) !== before) broadcast(deps);
    return card;
  });
}

/**
 * req 11 — the card says so rather than reading as current.
 *
 * `ifWriteSeq` is the settling turn's own view of the record: a predecessor that
 * settles after its successor already wrote must mark nothing.
 */
export function markSessionStatusStale(
  deps: SessionStatusDeps,
  sessionId: string,
  ifWriteSeq: number,
): Promise<void> {
  return runStatusExclusive(sessionId, async () => {
    const stored = deps.sessionManager.get(sessionId)?.sessionStatus;
    if (!stored?.fresh) return;
    if (stored.writeSeq !== ifWriteSeq) return;
    deps.sessionManager.setSessionStatus(sessionId, { ...stored, fresh: false });
    broadcast(deps);
  });
}

/**
 * req 17 — a taken offer stays on the card, greyed, until the agent removes it.
 * An unknown `offerId` marks nothing: the offer it named is already gone.
 */
export function takeOfferedActions(
  deps: SessionStatusDeps,
  sessionId: string,
  offerIds: string[],
): Promise<void> {
  return runStatusExclusive(sessionId, async () => {
    const stored = deps.sessionManager.get(sessionId)?.sessionStatus;
    if (!stored) return;
    const wanted = new Set(offerIds);
    const now = new Date().toISOString();
    let changed = false;
    const actions = stored.actions.map((offer) => {
      if (!wanted.has(offer.offerId) || offer.takenAt) return offer;
      changed = true;
      return { ...offer, takenAt: now };
    });
    if (!changed) return;
    // Taking an offer is the user acting, not the agent writing: `writeSeq` holds.
    deps.sessionManager.setSessionStatus(sessionId, { ...stored, actions });
    broadcast(deps);
  });
}

/**
 * req 23 — turning the setting back on shows the earlier card, marked stale, and
 * the next turn refreshes it. What a stored card claimed was true of the last
 * turn ShipIt watched, and nothing watched the turns in between.
 *
 * The sweep queues one session at a time, so a turn can accept a write for a
 * later session while it runs — and that card WAS confirmed with the setting on.
 * So each session carries the `writeSeq` the sweep saw, and the same guard
 * `markSessionStatusStale` uses decides. The snapshot is taken before the first
 * await, where no write can interleave.
 */
export async function markAllSessionStatusesStale(deps: SessionStatusDeps): Promise<void> {
  const snapshot = deps.sessionManager.sessionIdsWithStatus()
    .map((id) => ({ id, card: deps.sessionManager.get(id)?.sessionStatus }))
    .filter((entry): entry is { id: string; card: SessionStatus } => entry.card !== undefined);

  let changed = false;
  for (const { id, card } of snapshot) {
    try {
      await runStatusExclusive(id, async () => {
        const stored = deps.sessionManager.get(id)?.sessionStatus;
        if (!stored?.fresh || stored.writeSeq !== card.writeSeq) return;
        deps.sessionManager.setSessionStatus(id, { ...stored, fresh: false });
        changed = true;
      });
    } catch (err) {
      // One session's failed write must not leave the rest reading as current,
      // and must not vanish: the save that enabled the setting reports success.
      console.error(`[session-status] failed to mark ${id} stale on re-enable:`, err);
    }
  }
  if (changed) broadcast(deps);
}
