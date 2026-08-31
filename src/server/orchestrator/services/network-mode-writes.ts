/**
 * docs/285 — a session's in-flight network-mode write, as something other code
 * can wait for.
 *
 * Changing an ungraduated session's network mode REBUILDS its container: the
 * settings route persists the override and then destroys and recreates the
 * container before it answers. Two things must not overlap that.
 *
 *  - **Another write.** `restartContainer` has no concurrency guard of its own,
 *    so two writes for one session would interleave a destroy and a create.
 *    Two tabs, or the composer and the Session settings dialog, are two clients;
 *    the browser's save barrier orders one surface's writes, not two clients'.
 *  - **A first message.** The composer that issued the write is barred while it
 *    is in flight, but ANOTHER viewer's composer is not — it learns about the
 *    change only from the invalidation broadcast at the end. Without this, that
 *    viewer can send the session's first message into the container currently
 *    being torn down.
 *
 * It is an **await**, not a claim, and that distinction is the whole design. A
 * claim marks a session busy, which means the losing message goes to a queue —
 * and releasing a claim drains nothing, so with no owner turn behind it that
 * message is lost. An earlier revision of this feature did exactly that. Waiting
 * costs the losing Send the rebuild's duration and then lets it proceed normally,
 * which is both correct and the behaviour the user expects from a control that
 * says "in force from this session's first turn".
 *
 * Nothing here can deadlock: the write never waits on a turn, only the other way
 * round, and an entry is dropped as soon as its chain drains.
 */

/** Per-session tail of the write chain. Absent = nothing in flight. */
const chains = new Map<string, Promise<unknown>>();

/**
 * Run `fn` as this session's network-mode write, serialized against any other.
 *
 * `fn`'s rejection propagates to its own caller and never to the next waiter — a
 * failed write must not take the queue down with it.
 */
export function serializeNetworkModeWrite<T>(
  sessionId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = chains.get(sessionId) ?? Promise.resolve();
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
    // Only the CURRENT tail may clear the entry. A later writer has already
    // replaced it, and dropping theirs would let the next arrival run
    // concurrently with them.
    if (chains.get(sessionId) === tail) chains.delete(sessionId);
  });
  return run;
}

/**
 * Wait for any in-flight network-mode write for this session, then continue.
 * Resolves immediately when there is none, which is the overwhelmingly common
 * case — this costs one map lookup on the ordinary Send path.
 */
export async function settleNetworkModeWrites(sessionId: string): Promise<void> {
  const tail = chains.get(sessionId);
  if (!tail) return;
  await tail;
}

/** Test-only: drop every chain so one case cannot leak into the next. */
export function _resetNetworkModeWrites(): void {
  chains.clear();
}
