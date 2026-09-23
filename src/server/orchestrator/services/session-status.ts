import { randomUUID } from "node:crypto";
import type { ActionChecklistItem, OfferedAction, SessionStatus } from "../../shared/types.js";
import type { ValidatedSessionStatus } from "../../shared/session-status-validation.js";
import type { SessionManager } from "../sessions.js";
import { loadPrompt } from "../load-prompt.js";

const RECONCILE = loadPrompt(import.meta.url, "../prompts/status-card-reconcile.md").trim();
const MISSED = loadPrompt(import.meta.url, "../prompts/status-card-missed.md").trim();
const ABSENT = loadPrompt(import.meta.url, "../prompts/status-card-absent.md").trim();

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
  turnSeq: number,
): OfferedAction {
  return {
    ...item,
    offerId: randomUUID(),
    offeredAt: now,
    offeredSeq: turnSeq,
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
  turnSeq: number,
): OfferedAction[] {
  const items = write.actions;
  if (!items) return storedActions;

  const carry = (item: ActionChecklistItem): OfferedAction => {
    const previous = storedActions.find((offer) => offer.id === item.id);
    if (!previous || !sameOffer(previous, item)) return newOffer(item, write, now, turnSeq);
    return {
      ...item,
      offerId: previous.offerId,
      offeredAt: previous.offeredAt,
      ...(previous.offeredSeq !== undefined ? { offeredSeq: previous.offeredSeq } : {}),
      ...(previous.branch ? { branch: previous.branch } : {}),
      ...(previous.headSha ? { headSha: previous.headSha } : {}),
      ...(previous.takenAt ? { takenAt: previous.takenAt } : {}),
      ...(previous.takenSeq !== undefined ? { takenSeq: previous.takenSeq } : {}),
    };
  };

  if (write.replaceActions === true) return items.map(carry);

  const added = items.filter((item) => !storedActions.some((offer) => offer.id === item.id));
  const merged = storedActions.map((offer) => {
    const item = items.find((candidate) => candidate.id === offer.id);
    return item ? carry(item) : offer;
  });
  return [...merged, ...added.map((item) => newOffer(item, write, now, turnSeq))];
}

/**
 * docs/303 req 40 — a manual step is a plain string and gains no identity (the req 37
 * receipt), so its age is carried index-aligned beside the list and matched by text: a
 * step the agent repeats keeps the turn it first appeared on, a reworded one starts again.
 */
function reconcileStepSeq(
  steps: string[],
  stored: SessionStatus | undefined,
  turnSeq: number,
): (number | null)[] {
  return steps.map((text) => {
    const at = stored?.needsYou?.indexOf(text) ?? -1;
    // Already on the card: keep its turn, and keep "unrecorded" unrecorded — a step
    // stored before req 40 must not be given a birthday by the next bare confirmation.
    if (at >= 0) return stored?.stepSeq?.[at] ?? null;
    return turnSeq;
  });
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
    const turnSeq = stored?.turnSeq ?? 0;
    const needsYou = write.needsYou ?? stored?.needsYou ?? [];
    const stepSeq = reconcileStepSeq(needsYou, stored, turnSeq);
    const card: SessionStatus = {
      // req 31 — the one field that is not a delta: it names the turn that is
      // ending, so a call that omits it drops the line rather than inheriting a
      // line about a turn that is over.
      ...(write.lastTurn ? { lastTurn: write.lastTurn } : {}),
      status,
      ...(needsYou.length > 0 ? { needsYou, stepSeq } : {}),
      actions: reconcileOffers(stored?.actions ?? [], write, now, turnSeq),
      fresh: true,
      writeSeq: (stored?.writeSeq ?? 0) + 1,
      turnSeq,
      // req 38 — the call is the answer to the miss, so the notice does not ride on.
    };
    const before = shown(stored);
    deps.sessionManager.setSessionStatus(sessionId, card);
    if (shown(card) !== before) broadcast(deps);
    return card;
  });
}

/**
 * The one write a settling turn makes to the card (req 11, 38, 40): it marks the card
 * stale when the turn did not update it, records whether the next turn's prompt carries
 * the miss notice, and counts the turn.
 *
 * `ifWriteSeq` is the settling turn's own view of the record: a predecessor that settles
 * after its successor already wrote must touch nothing. A turn that DID write moved the
 * record itself, so it cannot use that guard — and therefore says nothing about freshness
 * or the ask at all, both of which its own call already settled.
 */
export function settleSessionStatusCard(
  deps: SessionStatusDeps,
  sessionId: string,
  turn: { ifWriteSeq: number; statusUpdated: boolean; nudgePending: boolean },
): Promise<void> {
  return runStatusExclusive(sessionId, async () => {
    const stored = deps.sessionManager.get(sessionId)?.sessionStatus;
    if (!stored) return;
    if (turn.statusUpdated) {
      // The call itself already made the card current and cleared the ask, so this turn
      // has nothing left to say about either — and must not say it, since a successor may
      // have written or missed in between and this settlement cannot tell.
      deps.sessionManager.setSessionStatus(sessionId, { ...stored, turnSeq: stored.turnSeq + 1 });
      return;
    }
    if (stored.writeSeq !== turn.ifWriteSeq) return;
    deps.sessionManager.setSessionStatus(sessionId, {
      ...stored,
      fresh: false,
      turnSeq: stored.turnSeq + 1,
      // req 38 — an ask stands until a CALL answers it. An exempt turn settling on top of
      // one (a question, a crash) records no ask of its own and must not drop that one.
      ...(turn.nudgePending || stored.nudgePending ? { nudgePending: true } : {}),
    });
    // `turnSeq` and the notice are bookkeeping; only the freshness mark is on screen.
    if (stored.fresh) broadcast(deps);
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
      return { ...offer, takenAt: now, takenSeq: stored.turnSeq };
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
  /**
   * req 13 — the turn ended with a question card or a plan to approve, so it is complete
   * without an update. Narrower than `wasInterrupted`, which also covers a user stop: a
   * stopped turn did the session's work and is asked for the card like any other (req 38).
   */
  awaitingAnswer: boolean;
  receivedResult: boolean;
  /**
   * req 36 — the harness answered this turn by operating on the conversation itself
   * (compaction), so the turn produced no work of the agent's own: the card cannot
   * be behind and there is nothing to ask about.
   */
  harnessCommand: boolean;
  /** req 38 — the Stop button or a kill, which `wasInterrupted` latches and a crash does not. */
  userStopped: boolean;
  /** The record as the turn saw it, so a predecessor can tell its own state from a later write. */
  writeSeq: number;
}

/**
 * req 12, 38 — ShipIt checks at the end of each turn that the agent updated or confirmed
 * the card, and asks for the update when it did not. The ask is a line in the NEXT turn's
 * prompt, so it costs no turn and nothing it could preempt: every gate that existed only
 * because a nudge spent a turn and replaced the resident process — a steer, a queued
 * prompt, a running or queued successor, the nudge turn itself — is gone with it, and a
 * miss on any of those shapes is now asked about.
 *
 * What is left are the four exemptions that stand on their own terms. A driver-owned turn
 * (`postTurn: "none"`) is NOT among them any more: it does real work and its card is marked
 * stale, so its ask is recorded like any other and read by the next turn that carries a
 * prompt. Withholding it was about not starting a turn inside the driver's interval, and
 * there is no turn to start.
 */
export function shouldCarryStatusNudge(facts: TurnStatusFacts): boolean {
  if (facts.statusUpdated) return false;
  // A question card or a plan to approve: the turn is complete without one (req 13).
  if (facts.awaitingAnswer) return false;
  // A crash has its own recovery, and produced no work of the agent's to report. A turn
  // the user STOPPED is not that: it did the session's work, and a harness that answers a
  // stop by exiting rather than by a result must not be read as a crash.
  if (!facts.receivedResult && !facts.userStopped) return false;
  // The harness answered by operating on the conversation, so the card is not behind (req 36).
  if (facts.harnessCommand) return false;
  return true;
}

/** req 35 — the whole block rides every turn, so it is bounded. */
export const MAX_STATUS_CONTEXT_CHARS = 8000;

/** How much of an offer fits. Each step drops a whole field, never half of one. */
type OfferDetail = "full" | "no-payload" | "id-only";

/**
 * docs/303 req 40 — an entry's age, counted in the turns the card has been settled
 * against. A card or an entry stored before req 40 carries no seq, and says nothing
 * rather than claiming an age of zero.
 */
function turnsAgo(turnSeq: number, seq: number | null | undefined): string {
  if (seq === undefined || seq === null) return "at an unrecorded turn";
  const n = Math.max(0, turnSeq - seq);
  if (n === 0) return "this turn";
  return n === 1 ? "1 turn ago" : `${n} turns ago`;
}

function offerBlock(offer: OfferedAction, detail: OfferDetail, turnSeq: number): string {
  const sent = offer.takenAt
    ? `, ALREADY SENT to you ${turnsAgo(turnSeq, offer.takenSeq)}`
    : "";
  return [
    `- id: ${offer.id} — offered ${turnsAgo(turnSeq, offer.offeredSeq)}${sent}`,
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
 *
 * req 39 — the instruction CLOSES the block, in the words the nudge used, because that
 * is where the measurement found an instruction is obeyed. req 40 — each manual step and
 * each offer carries its age in turns, so drift the agent has stopped seeing is visible.
 * req 38 — a session with no card carries the block too, asking for the first one: that
 * ask used to be the nudge turn's, and the nudge turn is gone.
 */
export function formatSessionStatusContext(card: SessionStatus | undefined): string {
  if (!card) return ["<session_status_card>", ABSENT, "</session_status_card>"].join("\n");
  const head = [
    "<session_status_card>",
    "This is the status card currently on screen, which you own.",
    "",
    "Status:",
    card.status,
  ];
  const steps = card.needsYou ?? [];
  if (steps.length > 0) {
    head.push(
      "",
      "Manual steps (only the user can do these):",
      ...steps.map((s, i) => `- ${s} — added ${turnsAgo(card.turnSeq, card.stepSeq?.[i])}`),
    );
  }
  const offers = card.actions;
  head.push("", offers.length === 0 ? "Follow-ups offered: none." : "Follow-ups offered:");
  const tail = [
    "",
    ...(card.nudgePending ? [MISSED, ""] : []),
    RECONCILE,
    "</session_status_card>",
  ].join("\n");

  // Rendered at the fullest detail that fits, and never half a value: a truncated
  // payload is one the agent would echo back as a changed offer, silently re-creating
  // the offer it meant to keep.
  const render = (detail: OfferDetail, shown: number): string => {
    const lines = [...head];
    for (const offer of offers.slice(0, shown)) lines.push(offerBlock(offer, detail, card.turnSeq));
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

/**
 * Where a composition site put the block into the turn's prompt: the text it inserted and
 * the offset it inserted it at. Both are needed — see `refreshStatusContextInPrompt`.
 */
export interface InsertedStatusContext {
  text: string;
  at: number;
}

/**
 * The position of the block in a composed prompt. The block is the LAST entry of the
 * agent prefix, so `lastIndexOf` over the prefix names it even when an earlier notice
 * carries the same text — which a parked rebase follow-up, whose body is arbitrary agent
 * prose, can (`services/rebase-followup.ts`). Returns undefined when nothing was inserted.
 */
export function locateStatusContext(
  agentPrefix: string,
  statusContext: string,
): InsertedStatusContext | undefined {
  if (!statusContext) return undefined;
  const at = agentPrefix.lastIndexOf(statusContext);
  return at === -1 ? undefined : { text: statusContext, at };
}

/**
 * docs/303 req 35 — the block is a snapshot of standing state, and a TURN IS SUBMITTED
 * MORE THAN ONCE: a quota failover, an auth heal and the lost-conversation recovery all
 * re-enter `executeAgentTurn` with the prompt composed for the first attempt. Frozen, that
 * prompt hands the retried attempt the card as it stood before the failed attempt's work —
 * the `session_status` write the tool reported as saved reads as discarded, and an offer
 * the user's submit already took reads as still outstanding, payload and all, so the agent
 * does it again. So each attempt swaps its own rendering in.
 *
 * `inserted` is the text AND the offset the composition site used, and the swap happens
 * only where the text still sits at that offset. Neither half alone is enough: without the
 * text a prompt composed WITHOUT a block (a compaction, a verbatim command, a driver-owned
 * turn) could be given one, and without the offset a search would rewrite the FIRST copy
 * of that text in the prompt — which a notice quoting an earlier block, or a user message
 * doing the same, can be.
 *
 * An empty `current` — the setting turned off mid-turn — leaves the prompt alone: with the
 * card off it is not ShipIt's to edit (req 21).
 */
export function refreshStatusContextInPrompt(
  prompt: string,
  inserted: InsertedStatusContext | undefined,
  current: string,
): string {
  if (!inserted || !current || current === inserted.text) return prompt;
  // A prompt whose block has moved is not one this can edit: nothing rewrites a composed
  // prompt today, and guessing where the block went would be how that changes silently.
  if (!prompt.startsWith(inserted.text, inserted.at)) return prompt;
  const after = inserted.at + inserted.text.length;
  return prompt.slice(0, inserted.at) + current + prompt.slice(after);
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
 * req 23 — turning the setting back on shows the earlier card, marked stale, and
 * the next turn refreshes it. What a stored card claimed was true of the last
 * turn ShipIt watched, and nothing watched the turns in between.
 *
 * The sweep queues one session at a time, so a turn can accept a write for a
 * later session while it runs — and that card WAS confirmed with the setting on.
 * So each session carries the `writeSeq` the sweep saw, and the same guard
 * `settleSessionStatusCard` uses decides. The snapshot is taken before the first
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
