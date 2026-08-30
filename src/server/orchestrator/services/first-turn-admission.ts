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

/** True while someone holds or is waiting for this session's first-turn admission. */
export function firstTurnAdmissionHeld(sessionId: string): boolean {
  return chains.has(sessionId);
}

/** Test-only: drop every chain, so one case cannot leak a section into the next. */
export function _resetFirstTurnAdmission(): void {
  chains.clear();
}
