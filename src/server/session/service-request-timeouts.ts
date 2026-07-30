/**
 * Per-action timeouts for the worker → orchestrator service-control bridge
 * (docs/238).
 *
 * The bridge used a single flat 60s deadline for every action, which is fine for
 * a `list` (an in-memory read) and actively wrong for a `start`: the orchestrator
 * services that one by running `docker compose up -d --build <name>`, so a cold
 * image pull or a `build:` routinely runs for minutes. The agent got
 * `Service start request timed out` while the start kept going in the
 * background — a failure message for an operation that was in fact succeeding.
 *
 * A service is `manual` precisely BECAUSE it is heavy, so the actions the agent
 * most wants (start/restart) are the ones the flat cap broke.
 */

/** Service-control actions the bridge understands. */
export type ServiceAction = "list" | "start" | "stop" | "restart" | "logs";

/**
 * How long the worker waits for the orchestrator's callback, per action.
 *
 * `start`/`restart` dominate: they cover a full `docker compose up -d --build`,
 * which on a cold host means pulling a multi-GB image (the Android emulator) or
 * running a Dockerfile. 10 minutes is generous enough that a legitimate cold
 * boot completes inside it, and bounded enough that a genuinely wedged compose
 * command doesn't strand the caller forever.
 */
export const SERVICE_REQUEST_TIMEOUTS_MS: Record<ServiceAction, number> = {
  list: 60_000,
  logs: 60_000,
  // `docker compose stop` sends SIGTERM and waits out a 10s grace period per
  // container before SIGKILL, so a multi-container service needs more than the
  // read actions but nothing like a build.
  stop: 120_000,
  start: 600_000,
  restart: 600_000,
};

/** Upper bound for a caller-supplied timeout. A caller may lower, never raise. */
export function serviceRequestTimeoutMs(action: string, requestedMs?: number): number {
  const ceiling = SERVICE_REQUEST_TIMEOUTS_MS[action as ServiceAction] ?? 60_000;
  if (typeof requestedMs !== "number" || !Number.isFinite(requestedMs) || requestedMs <= 0) {
    return ceiling;
  }
  return Math.min(Math.floor(requestedMs), ceiling);
}

/**
 * Message for a timed-out request.
 *
 * The distinction this copy carries is load-bearing: the worker giving up on the
 * callback does NOT cancel the orchestrator-side `docker compose up`. For
 * start/restart the operation is still in flight, so the honest report is "still
 * running, here's how to check" rather than "failed" — otherwise the agent tears
 * down and retries a start that was about to succeed, doubling the wait.
 */
export function serviceTimeoutMessage(action: string, timeoutMs: number): string {
  const seconds = Math.round(timeoutMs / 1000);
  const base = `Service ${action} request timed out after ${seconds}s.`;
  if (action !== "start" && action !== "restart") return base;
  return (
    `${base}\n\n` +
    `The ${  action  } is still running in the background — a cold image pull or a ` +
    `\`build:\` can take longer than this. Re-check with \`shipit service list\`, and ` +
    `read progress with \`shipit service logs <name>\`.`
  );
}
