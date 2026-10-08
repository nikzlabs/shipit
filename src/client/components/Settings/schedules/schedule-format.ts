import { parseRepoLabel } from "../../../utils/repo-label.js";
import type { SessionStartTarget } from "../../../../server/shared/types.js";

/** docs/324-scheduled-sessions — how Settings → Schedules and the run banner put a schedule into words. */

export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** The sandbox grants the target names, in the Sandbox dialog's order. */
export function targetInWords(target: SessionStartTarget): string {
  if (target.kind === "repo") return parseRepoLabel(target.repoUrl);
  const { capabilities } = target;
  const granted = [
    ...(capabilities.git ? ["GitHub"] : []),
    ...(capabilities.git && capabilities.dangerousGitHubOps ? ["Merge PRs"] : []),
    ...(capabilities.docker ? ["Docker"] : []),
    ...(capabilities.network ? ["Network"] : []),
  ];
  return granted.length > 0 ? `Sandbox · ${granted.join(", ")}` : "Sandbox · no access";
}

export function browserTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/**
 * The schedule's zone when it is not the browser's, else null. A run's title names its time in
 * the schedule's zone, so the banner and the history show run times there too and name it.
 */
export function otherZone(timeZone: string): string | null {
  if (timeZone === browserTimeZone()) return null;
  try {
    new Intl.DateTimeFormat(undefined, { timeZone });
    return timeZone;
  } catch {
    // A zone this browser does not know: its own zone is the best it can show.
    return null;
  }
}

/** A run time, e.g. "Wed, Oct 7, 09:00"; in the browser's own zone unless one is given. */
export function formatRunTime(at: string | Date, timeZone?: string): string {
  return new Date(at).toLocaleString(undefined, {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
}

/** A run time in the schedule's zone, with the zone named when it is not the browser's. */
export function formatScheduleRunTime(at: string | Date, timeZone: string): string {
  const zone = otherZone(timeZone);
  return zone ? `${formatRunTime(at, zone)} (${zone})` : formatRunTime(at);
}
