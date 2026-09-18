// Serialize every Compose mutation per session. Reentry would deadlock on its own tail.
const stackOps = new Map<string, Promise<unknown>>();

export function serializeStackOp<T>(sessionId: string, op: () => Promise<T>): Promise<T> {
  const previous = stackOps.get(sessionId) ?? Promise.resolve();
  // eslint-disable-next-line no-restricted-syntax -- Run op after either settlement.
  const next = previous.then(op, op);
  const tail: Promise<unknown> = next.catch(() => undefined).finally(() => {
    if (stackOps.get(sessionId) === tail) stackOps.delete(sessionId);
  });
  stackOps.set(sessionId, tail);
  return next;
}
