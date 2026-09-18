/**
 * planning#575 — a send decides between queueing its message and running it as
 * its own turn, and that decision spans awaits: attachments are read one file at
 * a time, network-mode writes settle, the session activates. The decision read
 * `running` before those awaits and set it after them, so two sends could both
 * pass the check, and the one with the longer path — a message carrying
 * attachments, the first message of a session — lost its turn to the message
 * sent after it.
 *
 * This gate serialises that region per session. Order is fixed when `acquire` is
 * CALLED, not when its promise settles, so messages decide in the order they
 * arrived. The caller releases in a `finally`: releasing instead at each of the
 * five early returns above the claim is one omission away from a session that
 * accepts no further turn.
 *
 * Deliberately not deadline-bounded. A holder can only keep the gate while one
 * of its own awaits is pending, and a timeout that let the next message through
 * would reopen the exact window this closes.
 */
const chains = new Map<string, Promise<void>>();

/**
 * Wait for the gate on `key`, then own it until the returned function is called.
 * Calling it more than once is harmless.
 */
export function acquireTurnClaimGate(key: string): Promise<() => void> {
  const previous = chains.get(key) ?? Promise.resolve();
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  // `chains.set` runs before this function returns, which is what fixes the
  // order at CALL time: a later acquire chains onto this one, not onto whatever
  // happens to be last when an await resumes.
  const mine = (async () => { await previous; await held; })();
  chains.set(key, mine);
  void (async () => {
    await mine;
    // Last holder out drops the key, so the map does not keep a settled promise
    // per session for the life of the process.
    if (chains.get(key) === mine) chains.delete(key);
  })();
  return (async () => { await previous; return release; })();
}

/** How many sessions currently have a holder or a waiter. Asserted against leaks. */
export function turnClaimGateKeyCount(): number {
  return chains.size;
}
