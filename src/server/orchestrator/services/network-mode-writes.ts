// Container rebuilds must finish before another write or first message proceeds.
// Await instead of claiming: a claim without an owner turn cannot drain queued messages.
const chains = new Map<string, Promise<unknown>>();

export function serializeNetworkModeWrite<T>(
  sessionId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = chains.get(sessionId) ?? Promise.resolve();
  // eslint-disable-next-line no-restricted-syntax -- Promise two-arg form: run `fn` whether or not the predecessor settled cleanly
  const run = previous.then(fn, fn);
  // eslint-disable-next-line no-restricted-syntax -- Promise two-arg form: the chain tail must settle cleanly on both outcomes
  const tail = run.then(
    () => {},
    () => {},
  );
  chains.set(sessionId, tail);
  // eslint-disable-next-line no-restricted-syntax -- fire-and-forget cleanup in a sync function
  void tail.then(() => {
    if (chains.get(sessionId) === tail) chains.delete(sessionId);
  });
  return run;
}

export async function settleNetworkModeWrites(sessionId: string): Promise<void> {
  const tail = chains.get(sessionId);
  if (!tail) return;
  await tail;
}

export function _resetNetworkModeWrites(): void {
  chains.clear();
}
