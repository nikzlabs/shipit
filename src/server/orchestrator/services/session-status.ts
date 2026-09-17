import { randomUUID } from "node:crypto";
import type { ActionChecklistItem, OfferedAction, SessionStatus } from "../../shared/types.js";
import type { ValidatedSessionStatus } from "../../shared/session-status-validation.js";
import type { SessionManager } from "../sessions.js";
import { loadPrompt, fillPromptTokens } from "../load-prompt.js";

const STATUS_NUDGE_PROMPT = loadPrompt(import.meta.url, "../prompts/status-card-nudge.md");

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
    lastTurn: card.lastTurn ?? "",
    status: card.status,
    needsYou: card.needsYou ?? [],
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
    const needsYou = write.needsYou ?? stored?.needsYou ?? [];
    const card: SessionStatus = {
      // req 31 — the one field that is not a delta: it names the turn that is
      // ending, so a call that omits it drops the line rather than inheriting a
      // line about a turn that is over.
      ...(write.lastTurn ? { lastTurn: write.lastTurn } : {}),
      status,
      ...(needsYou.length > 0 ? { needsYou } : {}),
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
 * Conversation reset, rewind and the two recovery paths that discard the agent's thread.
 *
 * docs/303 — the card is kept and marked stale rather than cleared: after a rewind it may
 * describe work that is gone, and "Stale" is how it says so. The mark itself lives in
 * `clearAgentSessionId`, beside the goal's clear, so no caller can forget it; this wraps it
 * with the broadcast, so viewers never keep a card that reads current.
 */
export function clearConversationThread(
  deps: {
    sessionManager: Pick<SessionManager, "clearAgentSessionId" | "list">;
    sseBroadcast?: (event: string, data: unknown) => void;
  },
  sessionId: string,
): void {
  if (!deps.sessionManager.clearAgentSessionId(sessionId)) return;
  deps.sseBroadcast?.("session_list", { sessions: deps.sessionManager.list() });
}

/**
 * docs/303 — what a settling turn knew about itself, taken before its drain step: the
 * drained successor resets the runner state these three come from, and it starts before
 * the network post-turn work and `idle`.
 */
export interface TurnStatusFacts {
  statusUpdated: boolean;
  wasInterrupted: boolean;
  receivedResult: boolean;
  /**
   * req 36 — the harness answered this turn by operating on the conversation itself
   * (compaction), so the turn produced no work of the agent's own: the card cannot
   * be behind and there is nothing to ask about.
   */
  harnessCommand: boolean;
  /** This turn IS a nudge; an ignored one is not nudged again (req 15). */
  statusNudge: boolean;
  /** req 34 — a message reached this turn after it started, so it owes an answer. */
  steered: boolean;
  /** req 34 — this turn's own prompt went in behind a turn of the CLI's own. */
  promptQueued: boolean;
  postTurn: "commit-push" | "none";
  /** The record as the turn saw it, so a predecessor can tell its own state from a later write. */
  writeSeq: number;
}

/**
 * req 12 — ShipIt checks at the end of each turn that the agent updated or confirmed the
 * card, and asks for the update when it did not.
 *
 * A successor running or queued is a DEFERRAL, not an exemption: that turn is checked
 * afresh when it ends, and nudging under it would ask about a session the successor is
 * already changing.
 */
export function shouldNudgeForStatusCard(
  facts: TurnStatusFacts,
  stored: Pick<SessionStatus, "writeSeq"> | undefined,
  successorPending: boolean,
): boolean {
  if (facts.statusUpdated) return false;
  // A question, a plan approval or a user stop (req 13).
  if (facts.wasInterrupted) return false;
  // A crash has its own recovery; there is no turn to ask.
  if (!facts.receivedResult) return false;
  if (facts.harnessCommand) return false;
  if (facts.statusNudge) return false;
  // A driver owns this turn and the interval around it.
  if (facts.postTurn === "none") return false;
  if ((stored?.writeSeq ?? 0) !== facts.writeSeq) return false;
  if (successorPending) return false;
  return true;
}

/** req 35 — the whole block rides every turn, so it is bounded. */
export const MAX_STATUS_CONTEXT_CHARS = 8000;

/** How much of an offer fits. Each step drops a whole field, never half of one. */
type OfferDetail = "full" | "no-payload" | "id-only";

function offerBlock(offer: OfferedAction, detail: OfferDetail): string {
  return [
    `- id: ${offer.id}${offer.takenAt ? " — ALREADY SENT to you" : ""}`,
    `  label: ${offer.label}`,
    ...(detail !== "id-only" && offer.description ? [`  description: ${offer.description}`] : []),
    // Not part of the offer's identity, so a replacement that omits it would drop the
    // recommendation silently; the prompt tells the agent to repeat what is printed.
    ...(offer.defaultChecked ? ["  defaultChecked: true"] : []),
    ...(detail === "full" ? [`  payload: ${offer.payload}`] : ["  payload: (not printed this turn — too long)"]),
  ].join("\n");
}

const REPLACE_UNSAFE =
  "This listing is incomplete, so you cannot repeat every offer exactly."
  + " Do NOT use `replaceActions` this turn — it would drop the ones not printed in full.";

/**
 * docs/303 req 35 — what the agent reconciles at the end of the turn. Without it
 * a bare confirmation is the only honest call available, and an entry the agent
 * has forgotten cannot be dropped.
 *
 * `lastTurn` and the freshness mark are deliberately absent: the line describes
 * the turn that wrote it and every write rewrites or clears it (req 31), so
 * showing it invites carrying it forward, and whether the card currently reads
 * stale changes none of the contents being reconciled.
 *
 * The payload is listed because dropping one offer and keeping the rest means
 * sending the rest back with `replaceActions`, and an offer whose payload
 * differs by a byte arrives as a new untaken one (req 17).
 *
 * The cap therefore falls on the PAYLOADS, never on the offers: req 35 asks that
 * the agent see each offer, and an offer it cannot see is one a replacement would
 * silently drop. When a payload is withheld the block says so and forbids
 * `replaceActions` for that turn, so a large card costs reconciliation power, not
 * offers.
 */
export function formatSessionStatusContext(card: SessionStatus | undefined): string {
  if (!card) return "";
  const head = [
    "<session_status_card>",
    "This is the status card currently on screen, which you own. Reconcile it before the turn ends.",
    "",
    "Status:",
    card.status,
  ];
  const steps = card.needsYou ?? [];
  if (steps.length > 0) {
    head.push("", "Manual steps (only the user can do these):", ...steps.map((s) => `- ${s}`));
  }
  const offers = card.actions;
  head.push("", offers.length === 0 ? "Follow-ups offered: none." : "Follow-ups offered:");
  const tail = "</session_status_card>";

  // Rendered at the fullest detail that fits, and never half a value: a truncated
  // payload is one the agent would echo back as a changed offer, silently re-creating
  // the offer it meant to keep.
  const render = (detail: OfferDetail, shown: number): string => {
    const lines = [...head];
    for (const offer of offers.slice(0, shown)) lines.push(offerBlock(offer, detail));
    if (shown < offers.length) {
      lines.push(`(${offers.length - shown} further offer(s) are on the card, not listed here.)`);
    }
    if (detail !== "full" || shown < offers.length) lines.push("", REPLACE_UNSAFE);
    lines.push(tail);
    return lines.join("\n");
  };

  for (const detail of ["full", "no-payload", "id-only"] as const) {
    const whole = render(detail, offers.length);
    if (whole.length <= MAX_STATUS_CONTEXT_CHARS) return whole;
  }
  // A card with a great many offers: shrink the list itself, which the warning covers.
  let shown = offers.length;
  while (shown > 0 && render("id-only", shown).length > MAX_STATUS_CONTEXT_CHARS) shown -= 1;
  return render("id-only", shown);
}

export interface StatusContextDeps {
  sessionManager: Pick<SessionManager, "get">;
  credentialStore: { getSessionStatusCard(): boolean };
}

/** The setting gate and the read together, so a caller needs neither (req 21, 35). */
export function sessionStatusTurnContext(deps: StatusContextDeps, sessionId: string): string {
  if (!deps.credentialStore.getSessionStatusCard()) return "";
  return formatSessionStatusContext(deps.sessionManager.get(sessionId)?.sessionStatus);
}

/**
 * The nudge's own prompt (req 12). It carries the whole card (req 35) and asks for a
 * reconciliation; the prose is the `.md` above, loaded once at module load, per the
 * `prompt-architecture` skill.
 */
export function statusNudgePrompt(card: SessionStatus | undefined): string {
  const block = formatSessionStatusContext(card);
  return fillPromptTokens(STATUS_NUDGE_PROMPT, {
    CARD: block || "The card is empty: write it with `status`.",
  }).trim();
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
