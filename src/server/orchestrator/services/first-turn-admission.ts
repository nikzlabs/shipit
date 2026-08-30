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
  for (const entry of claims.values()) entry.release();
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
 *  - **It has to be awaitable.** The first turn's mode is not sampled when
 *    reconciliation returns: the replacement can still be `starting`, and its
 *    containment is resolved later, when creation reaches the plumbing step. A
 *    write landing in between silently moves the admitted turn to another
 *    policy. So every writer of a session's egress override waits here first.
 */
interface FirstTurnClaimEntry {
  done: Promise<void>;
  release: () => void;
}

const claims = new Map<string, FirstTurnClaimEntry>();

/**
 * How long a writer will wait for an in-flight first turn before giving up and
 * writing anyway.
 *
 * Generous relative to the work it covers (an 8s readiness wait plus spawn), and
 * bounded because the alternative failure is worse: a claim leaked by some future
 * path would otherwise wedge the Session settings dialog for the life of the
 * process, with no error and nothing to retry.
 */
const CLAIM_WAIT_TIMEOUT_MS = 30_000;

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
  const existing = claims.get(sessionId);
  if (existing) return null;
  let release!: () => void;
  const done = new Promise<void>((resolve) => {
    release = () => {
      if (claims.get(sessionId)?.done === done) claims.delete(sessionId);
      resolve();
    };
  });
  claims.set(sessionId, { done, release });
  return release;
}

/** True while a first turn is being started for this session. */
export function firstTurnClaimed(sessionId: string): boolean {
  return claims.has(sessionId);
}

/**
 * Wait for an in-flight first turn to be dispatched, so a write cannot change
 * the mode that turn's container is about to sample. Resolves immediately when
 * nothing is claimed.
 */
export async function awaitFirstTurnClaim(sessionId: string): Promise<void> {
  const entry = claims.get(sessionId);
  if (!entry) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    entry.done,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, CLAIM_WAIT_TIMEOUT_MS);
    }),
  ]);
  if (timer) clearTimeout(timer);
}
