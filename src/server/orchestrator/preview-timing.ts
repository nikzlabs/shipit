/**
 * Phase timings for the session-activation → preview-ready path.
 *
 * The phases are measured where each one happens — container acquisition in
 * `app-lifecycle.ts`, the install gate and the `docker compose up` in
 * `service-manager.ts` / `compose-cli.ts`. This module carries the ONE fact
 * that spans two modules: `docker compose up` returned in the ServiceManager,
 * and the first request that the preview proxy got an answer for arrives later,
 * in `preview-proxy.ts`. Neither side can time that gap alone.
 *
 * Every line is `console.log` in the shared `[timing]` shape used by
 * `claim-session.ts` and `app-lifecycle.ts`, so one grep collects the whole
 * path.
 */

/** What a session's last `docker compose up` settled at, and for which services. */
interface StackUpMark {
  at: number;
  services: string[];
  /** Ports already reported, so a busy preview logs once per boot, not per request. */
  reported: Set<number>;
}

const stackUpMarks = new Map<string, StackUpMark>();

/**
 * Record that the auto-preview services' `docker compose up` has returned.
 *
 * Resets the reported-ports set: a restart, a reconcile or a gate release is a
 * new boot of those services, and its first-connect is a new measurement.
 */
export function markStackUp(sessionId: string, services: string[]): void {
  stackUpMarks.set(sessionId, { at: Date.now(), services: [...services], reported: new Set() });
}

/**
 * Record that a preview request reached the upstream. Logs the gap since the
 * `compose up` returned — the dev server's own boot plus its first compile,
 * which is the part of the wait no pre-warming currently covers.
 *
 * A no-op when the session has no mark (a preview reached before any `up` this
 * process ran, e.g. a container adopted across a restart) — there is no honest
 * number to report there.
 */
export function markPreviewReachable(sessionId: string, port: number): void {
  const mark = stackUpMarks.get(sessionId);
  if (!mark || mark.reported.has(port)) return;
  mark.reported.add(port);
  console.log(
    `[timing] preview.first-connect for ${sessionId} port=${port} ` +
      `afterComposeUp=${Date.now() - mark.at}ms services=${mark.services.join(",") || "none"}`,
  );
}

/** Drop a session's mark — its stack is going away (dispose / stop). */
export function forgetStackUp(sessionId: string): void {
  stackUpMarks.delete(sessionId);
}
