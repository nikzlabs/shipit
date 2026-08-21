/**
 * Per-session serial queue for operations that rebuild a session's compose
 * stack — the first `start()`, any plugin-service reconcile, the config-change
 * reconcile, the containment-change reconcile on the agent-restart adopt path,
 * and the install gate's batched release of gated services.
 *
 * **Every compose invocation for a session belongs on it.** The last two were
 * the ones left off, and both are on the same collision: an unqueued `docker
 * compose up` that lands inside a queued one's recreate.
 *
 * Every one of them is non-reentrant, and they genuinely race. Plugin
 * activation is fire-and-forget, so a repository that finishes fetching while
 * the first `docker compose up` is still running settles right in the middle of
 * it. Left unserialized, that round would set the new services, see a manager
 * that has not finished starting, and either reconcile into an in-flight start
 * or skip — and skipping means the services it just resolved reach nothing
 * until some later round happens to change them again.
 *
 * The install gate's release is on the same queue for the same reason, and it
 * was the last one left off it. A session activation runs the plugin reconcile
 * and `agent.install` concurrently by design, so the gate opening lands in the
 * middle of the reconcile's `up` often enough to be the common case rather than
 * a corner: compose then fails mid-recreate with "removal of container … is
 * already in progress", the just-started container is force-removed with exit
 * 137, and the service walks to `stopped` 30s later when the poller gives up on
 * it. Diagnosed live on an ops session against a841e147.
 *
 * Chained rather than joined, for the reason `plugin-generations.ts` gives its
 * own queue: every trigger must run against the state it was given, in order,
 * and the last one always wins. A failing link never poisons the next.
 *
 * **Not reentrant.** A function documented as needing the queue must not be
 * called from inside an op that already holds it — the inner call would wait on
 * a tail that cannot settle until it returns.
 */

const stackOps = new Map<string, Promise<unknown>>();

export function serializeStackOp<T>(sessionId: string, op: () => Promise<T>): Promise<T> {
  const previous = stackOps.get(sessionId) ?? Promise.resolve();
  // eslint-disable-next-line no-restricted-syntax -- Promise two-arg form: run `op` whether the previous entry settled or rejected
  const next = previous.then(op, op);
  const tail: Promise<unknown> = next.catch(() => undefined).finally(() => {
    if (stackOps.get(sessionId) === tail) stackOps.delete(sessionId);
  });
  stackOps.set(sessionId, tail);
  return next;
}
