/**
 * Phase timings for the session-activation → preview-ready path.
 *
 * The phases are measured where each one happens — container acquisition in
 * `app-lifecycle.ts`, the install gate and the `docker compose up` in
 * `service-manager.ts` / `compose-cli.ts`. This module carries the ONE fact
 * that spans two modules: `docker compose up` returned in the ServiceManager,
 * and the first request the upstream answered arrives later, in
 * `preview-proxy.ts`. Neither side can time that gap alone.
 *
 * Marks are per PORT, not per session. A session's stack does not come up in
 * one `up`: the non-gated services start first and the install-gated ones
 * follow, sometimes minutes later. A session-wide mark let the second `up`
 * re-open the first batch's ports and then report their boot against the wrong
 * clock (review finding).
 *
 * Every line is `console.log` in the shared `[timing]` shape used by
 * `claim-session.ts` and `app-lifecycle.ts`, so one grep collects the path.
 */

/** What one service's last `docker compose up` settled at. */
interface PortMark {
  at: number;
  service: string;
  reported: boolean;
}

/** sessionId → port → mark. Nested so a session's marks drop in one step. */
const marks = new Map<string, Map<number, PortMark>>();

/** A service whose `docker compose up` has just returned. */
export interface StartedService {
  name: string;
  /** Container port the preview proxy addresses. Portless services are skipped. */
  port?: number;
}

/**
 * Record that `docker compose up` returned for these services. Call it as soon
 * as the command settles — anything done afterwards (containment, network
 * joins) runs while the dev server is already booting, and would otherwise be
 * charged to the dev server instead of to us.
 *
 * Re-marking a port resets it: a restart or a reconcile is a new boot of that
 * service, and its first connect is a new measurement.
 */
export function markStackUp(sessionId: string, services: StartedService[]): void {
  let byPort = marks.get(sessionId);
  if (!byPort) {
    byPort = new Map();
    marks.set(sessionId, byPort);
  }
  const at = Date.now();
  for (const svc of services) {
    if (svc.port === undefined) continue;
    byPort.set(svc.port, { at, service: svc.name, reported: false });
  }
}

/**
 * Record that a preview request reached the upstream. Logs the gap since that
 * port's `compose up` returned — the dev server's own boot plus its first
 * compile, which is the part of the wait no pre-warming currently covers.
 *
 * A no-op when the port has no mark (a preview reached before any `up` this
 * process ran, e.g. a container adopted across a restart) or when it has
 * already been reported — a live preview serves hundreds of requests.
 */
export function markPreviewReachable(sessionId: string, port: number): void {
  const mark = marks.get(sessionId)?.get(port);
  if (!mark || mark.reported) return;
  mark.reported = true;
  console.log(
    `[timing] preview.first-connect for ${sessionId} port=${port} ` +
      `afterComposeUp=${Date.now() - mark.at}ms service=${mark.service}`,
  );
}

/** Drop a session's marks — its stack is going away (dispose / stop). */
export function forgetStackUp(sessionId: string): void {
  marks.delete(sessionId);
}
