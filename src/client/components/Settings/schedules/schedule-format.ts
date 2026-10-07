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

/** A run time in the browser's own zone, e.g. "Wed, Oct 7, 09:00". */
export function formatRunTime(at: string | Date): string {
  return new Date(at).toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
}
