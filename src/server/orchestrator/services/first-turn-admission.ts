/**
 * docs/285 — a session-keyed critical section around a session's **first** turn,
 * so the network mode that turn runs under cannot move while it is being decided.
 *
 * Two independent things have to be serialized against each other, and only one
 * of them is a message:
 *
 *  - **Competing first Sends.** Dispatch admission is checked near the top of
 *    `handleSendMessage` while the runner is not claimed until much further down,
 *    and WS callbacks are independently asynchronous. With a container restart in
 *    between — seconds, not microseconds — two near-simultaneous first messages
 *    (two tabs, or a fast double Enter) can both pass the idle check and both
 *    decide to reconcile. One should reconcile; the rest wait and then re-ask,
 *    rather than proceeding on a decision that was true when they made it.
 *  - **The override write.** `PUT /api/egress/session/:id` is an ordinary HTTP
 *    route with no relationship to the WS handler, and the control stays
 *    deliberately editable during the restart. A change landing *after* the
 *    comparison — or after the replacement container has booted — would run the
 *    first turn under a mode different from the one now on screen. Once the first
 *    Send is admitted its target is **frozen**: a later write waits here and then
 *    becomes an ordinary post-first-turn change, with the normal pending state.
 *
 * Deliberately NOT a general session lock. It is taken on the first turn and by
 * the one route that can move that turn's target, and nothing else — a lock held
 * across ordinary sends would put a GitHub round trip in front of every message.
 *
 * The section is a promise chain per session, so waiters run in arrival order and
 * a thrown body still releases the next one. The entry is dropped once the chain
 * drains, so an idle session holds no state here.
 */

/** Per-session tail of the admission chain. Absent = nobody holds or waits. */
const chains = new Map<string, Promise<unknown>>();

/**
 * Run `fn` with exclusive first-turn admission for `sessionId`.
 *
 * Waiters queue in arrival order. `fn`'s rejection propagates to its own caller
 * and never to the next waiter — a failed first Send must not take the queue
 * down with it.
 */
export function withFirstTurnAdmission<T>(
  sessionId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = chains.get(sessionId) ?? Promise.resolve();
  // `.then(fn, fn)` rather than `.finally(fn)`: the predecessor's outcome is its
  // own caller's business, and a rejected predecessor must still let this one run.
  // eslint-disable-next-line no-restricted-syntax -- Promise two-arg form: run `fn` whether or not the predecessor settled cleanly
  const run = previous.then(fn, fn);
  // The chain tail swallows rejections so an unhandled one can never escape from
  // a link nobody awaited. Callers still see their own via `run`.
  // eslint-disable-next-line no-restricted-syntax -- Promise two-arg form: the chain tail must settle cleanly on both outcomes
  const tail = run.then(
    () => {},
    () => {},
  );
  chains.set(sessionId, tail);
  // eslint-disable-next-line no-restricted-syntax -- fire-and-forget cleanup in a sync function
  void tail.then(() => {
    // Only the CURRENT tail may clear the entry. A later waiter has already
    // replaced it, and dropping theirs would let the next arrival run
    // concurrently with them.
    if (chains.get(sessionId) === tail) chains.delete(sessionId);
  });
  return run;
}

/** Test-only: drop every chain and claim, so one case cannot leak into the next. */
export function _resetFirstTurnAdmission(): void {
  chains.clear();
  claims.clear();
}

// ---------------------------------------------------------------------------
// The first-turn claim
// ---------------------------------------------------------------------------

/**
 * docs/285 — a session-scoped claim held from BEFORE the first turn's
 * reconciliation until that turn is dispatched.
 *
 * Distinct from the admission section above, and both are needed. The section
 * serializes *entry*; this marks the whole span as taken, and it lives here
 * rather than on the runner for two reasons the runner cannot satisfy:
 *
 *  - **It has to outlive the runner.** Reconciliation destroys the container and
 *    builds a replacement runner, so a flag on the runner object is dropped in
 *    the middle of the very window it guards. `restartContainer` publishes that
 *    replacement and then waits for readiness — and in that interval a
 *    programmatic `dispatch()` (a CI fix, a wake, a parent's message) saw an
 *    unclaimed runner and started a turn alongside the first Send.
 *  - **It has to carry the turn's mode.** The first turn's containment is not
 *    sampled when reconciliation returns: the replacement can still be
 *    `starting`, and its policy is resolved later, when creation reaches the
 *    plumbing step. So the claim carries a **pin** — the containment this turn
 *    was admitted under — and creation reads that instead of re-reading the
 *    store. See {@link pinFirstTurnEgress}.
 */
interface FirstTurnClaimEntry {
  /** The containment frozen for this turn; `undefined` until reconciliation pins it. */
  pinnedContained?: boolean;
}

const claims = new Map<string, FirstTurnClaimEntry>();

/**
 * Take the claim, or return `null` when someone already holds it.
 *
 * `null` rather than a silent no-op release, and the difference is the whole
 * point: a no-op made a LOSER indistinguishable from a winner, so it carried on
 * as though it owned the span and started a second turn. The caller has to be
 * able to tell, because "someone else owns this session's first turn" is exactly
 * the condition it must act on.
 *
 * The winner MUST call the returned release in a `finally`.
 */
export function claimFirstTurn(sessionId: string): (() => void) | null {
  if (claims.has(sessionId)) return null;
  const entry: FirstTurnClaimEntry = {};
  claims.set(sessionId, entry);
  return () => {
    // Only the holder may clear it. Identity rather than presence, so a release
    // arriving after a LATER claim was taken cannot drop that one's pin.
    if (claims.get(sessionId) === entry) claims.delete(sessionId);
  };
}

/** True while a first turn is being started for this session. */
export function firstTurnClaimed(sessionId: string): boolean {
  return claims.has(sessionId);
}

/**
 * docs/285 — freeze the containment this session's first turn was admitted
 * under, for as long as the claim is held.
 *
 * This is the whole fix, and it is a fix at the *cause* rather than another
 * lock. Containment is decided when a container is CREATED, by re-reading the
 * mutable override store at the plumbing step — a moment the Send path does not
 * control and cannot be made to control: `restartContainer` bounds its readiness
 * wait at 8s and can return with the replacement still `starting`, so creation
 * samples the store an unbounded time after the turn was admitted. Every lock
 * around that samples narrows the window; none closes it.
 *
 * So the admitted turn stops depending on when creation happens to look. It
 * carries its answer with it, and creation reads the answer instead of asking
 * again. A write landing mid-span still persists and still takes effect — on the
 * next container start, which is exactly what a mode changed after the first
 * turn has always done. That is why the writer no longer waits for anything: a
 * settings PUT that used to block for up to 30s (and then wrote through anyway,
 * silently moving the in-flight turn) is now an ordinary write.
 *
 * Applied at ONE seam — `resolveEgressConfig` in `index.ts`, the single function
 * that turns the stores into a per-session egress decision — so the restart
 * decision and the creation cannot answer differently. Deliberately does NOT
 * widen a docs/211 sandbox lifeline: that check runs first and a user's pick
 * must not reopen a sealed sandbox.
 *
 * A no-op when nothing is claimed: with no claim there is no admitted turn to
 * protect, and a pin with no owner would have no one to release it.
 */
export function pinFirstTurnEgress(sessionId: string, contained: boolean): void {
  const entry = claims.get(sessionId);
  if (!entry) return;
  entry.pinnedContained = contained;
}

/**
 * The containment frozen for this session's in-flight first turn, or `undefined`
 * when there is none — in which case the caller resolves normally.
 *
 * Lives on the claim entry rather than in a map of its own so the two cannot
 * outlive each other: releasing the claim drops the pin in the same statement,
 * and there is no second lifetime to leak.
 */
export function firstTurnEgressPin(sessionId: string): boolean | undefined {
  return claims.get(sessionId)?.pinnedContained;
}
