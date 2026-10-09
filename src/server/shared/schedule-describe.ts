import type { ScheduleTiming, SessionCapabilities, SessionStartTarget } from "./types.js";

/** docs/324-scheduled-sessions — a schedule's values in words, for the cards and `shipit schedule list`. */

const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const pad = (n: number) => String(n).padStart(2, "0");

/** "Every day at 09:00"; the time is the schedule's wall-clock time. */
export function describeTiming(timing: ScheduleTiming): string {
  switch (timing.kind) {
    case "hourly":
      return `Every hour at :${pad(timing.minute)}`;
    case "daily":
      return `Every day at ${pad(timing.hour)}:${pad(timing.minute)}`;
    case "weekdays":
      return `Weekdays at ${pad(timing.hour)}:${pad(timing.minute)}`;
    case "weekly":
      return `Every ${WEEKDAY_NAMES[timing.weekday] ?? `day ${timing.weekday}`} at ${pad(timing.hour)}:${pad(timing.minute)}`;
    case "cron":
      return `Cron ${timing.expression.trim()}`;
  }
}

/** The `when` of the proposal YAML, so the agent reads a schedule the way it writes one. */
export function formatWhen(timing: ScheduleTiming): string {
  switch (timing.kind) {
    case "hourly":
      return `hourly :${pad(timing.minute)}`;
    case "daily":
    case "weekdays":
      return `${timing.kind} ${pad(timing.hour)}:${pad(timing.minute)}`;
    case "weekly":
      return `weekly ${(WEEKDAY_NAMES[timing.weekday] ?? String(timing.weekday)).toLowerCase()} ${pad(timing.hour)}:${pad(timing.minute)}`;
    case "cron":
      return `{ cron: ${JSON.stringify(timing.expression.trim())} }`;
  }
}

/** The Sandbox dialog's names for the grants. */
export const SANDBOX_GRANT_LABELS: Record<keyof SessionCapabilities, string> = {
  git: "GitHub access",
  dangerousGitHubOps: "Allow merging PRs",
  docker: "Docker access",
  network: "Network access",
};

export function describeTarget(target: SessionStartTarget): string {
  return target.kind === "repo" ? `Repository ${target.repoUrl}` : "Sandbox";
}

/** "GitHub access: on · Docker access: off · …", in the dialog's order. */
export function describeGrants(capabilities: SessionCapabilities): string {
  return (Object.keys(SANDBOX_GRANT_LABELS) as (keyof SessionCapabilities)[])
    .map((key) => `${SANDBOX_GRANT_LABELS[key]}: ${capabilities[key] ? "on" : "off"}`)
    .join(" · ");
}
