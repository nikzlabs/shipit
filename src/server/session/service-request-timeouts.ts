export type ServiceAction = "list" | "start" | "stop" | "restart" | "logs";

// Starts include image pulls/builds; stops include container shutdown grace periods.
export const SERVICE_REQUEST_TIMEOUTS_MS: Record<ServiceAction, number> = {
  list: 60_000,
  logs: 60_000,
  stop: 120_000,
  start: 600_000,
  restart: 600_000,
};

export function serviceRequestTimeoutMs(action: string, requestedMs?: number): number {
  const ceiling = SERVICE_REQUEST_TIMEOUTS_MS[action as ServiceAction] ?? 60_000;
  if (typeof requestedMs !== "number" || !Number.isFinite(requestedMs) || requestedMs <= 0) {
    return ceiling;
  }
  return Math.min(Math.floor(requestedMs), ceiling);
}

// Timing out the callback does not cancel the orchestrator's compose command.
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
