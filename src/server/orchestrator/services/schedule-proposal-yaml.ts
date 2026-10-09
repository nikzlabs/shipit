import { parse as parseYaml } from "yaml";
import type { ScheduleTiming, SessionCapabilities } from "../../shared/types.js";
import { ServiceError } from "./types.js";

/**
 * The proposal YAML of `shipit schedule propose` (docs/324-scheduled-sessions plan.md → Making
 * and changing a schedule by chat). This reads only the shape; the values are checked by the
 * same checks create and update use (`schedules.ts`).
 */

export const MAX_PROPOSAL_CHARS = 100_000;

export type ProposedTarget =
  | { kind: "repo"; repoUrl: string }
  /** Only the grants the YAML names; on a change, the others stay as they are. */
  | { kind: "sandbox"; capabilities: Partial<SessionCapabilities> };

/** What the YAML gives. A field that is absent does not change on `--id`. */
export interface ProposedSchedule {
  name?: unknown;
  timing?: ScheduleTiming;
  timeZone?: unknown;
  target?: ProposedTarget;
  /** Raw values, read by the session-start spec reader; on a change, null removes a key. */
  params?: Record<string, unknown>;
  prompt?: unknown;
  enabled?: boolean;
}

const FIELDS = ["name", "when", "timeZone", "target", "params", "prompt", "enabled"] as const;

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

const CAPABILITY_KEYS: readonly (keyof SessionCapabilities)[] = ["git", "docker", "network", "dangerousGitHubOps"];

const WHEN_HELP =
  'when must be a preset — "hourly :15", "daily 09:00", "weekdays 09:00", "weekly monday 09:00" — '
  + 'or a cron expression as { cron: "0 9 * * 1-5" }.';

const TARGET_HELP =
  "target must be { repo: <repository URL> }, sandbox, or { sandbox: { git, docker, network, "
  + "dangerousGitHubOps } } with true or false for each grant it names.";

function refuse(message: string): never {
  throw new ServiceError(400, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function weekdayOf(word: string): number | null {
  const index = WEEKDAYS.findIndex((day) => day === word || day.slice(0, 3) === word);
  return index === -1 ? null : index;
}

/** A preset in words or `{ cron }`; the values' ranges are checked with the timing. */
export function parseWhen(value: unknown): ScheduleTiming {
  if (isRecord(value)) {
    const keys = Object.keys(value);
    if (keys.length === 1 && keys[0] === "cron" && typeof value.cron === "string") {
      return { kind: "cron", expression: value.cron };
    }
    refuse(WHEN_HELP);
  }
  if (typeof value !== "string") refuse(WHEN_HELP);
  const words = value.trim().toLowerCase().split(/\s+/);
  const time = (text: string | undefined): { hour: number; minute: number } | null => {
    const match = text ? /^(\d{1,2}):(\d{2})$/.exec(text) : null;
    return match ? { hour: Number(match[1]), minute: Number(match[2]) } : null;
  };
  switch (words[0]) {
    case "hourly": {
      if (words.length === 1) return { kind: "hourly", minute: 0 };
      const minute = words.length === 2 ? /^:?(\d{1,2})$/.exec(words[1]) : null;
      if (minute) return { kind: "hourly", minute: Number(minute[1]) };
      break;
    }
    case "daily":
    case "weekdays": {
      const at = words.length === 2 ? time(words[1]) : null;
      if (at) return { kind: words[0], ...at };
      break;
    }
    case "weekly": {
      const weekday = words.length === 3 ? weekdayOf(words[1]) : null;
      const at = words.length === 3 ? time(words[2]) : null;
      if (weekday !== null && at) return { kind: "weekly", weekday, ...at };
      break;
    }
  }
  return refuse(WHEN_HELP);
}

function parseTarget(value: unknown): ProposedTarget {
  if (value === "sandbox") return { kind: "sandbox", capabilities: {} };
  if (!isRecord(value)) refuse(TARGET_HELP);
  const keys = Object.keys(value);
  if (keys.length !== 1) refuse(TARGET_HELP);
  if (keys[0] === "repo") {
    if (typeof value.repo !== "string" || !value.repo.trim()) refuse(TARGET_HELP);
    return { kind: "repo", repoUrl: value.repo.trim() };
  }
  if (keys[0] !== "sandbox") refuse(TARGET_HELP);
  const grants = value.sandbox ?? {};
  if (!isRecord(grants)) refuse(TARGET_HELP);
  const capabilities: Partial<SessionCapabilities> = {};
  for (const [key, granted] of Object.entries(grants)) {
    if (!(CAPABILITY_KEYS as readonly string[]).includes(key)) {
      refuse(`Unknown sandbox grant "${key}". Grants: ${CAPABILITY_KEYS.join(", ")}.`);
    }
    if (typeof granted !== "boolean") refuse(`The sandbox grant "${key}" must be true or false.`);
    capabilities[key as keyof SessionCapabilities] = granted;
  }
  return { kind: "sandbox", capabilities };
}

/** Refuses YAML that is not a proposal, naming the field. */
export function parseScheduleProposal(text: string): ProposedSchedule {
  if (text.length > MAX_PROPOSAL_CHARS) {
    refuse(`The proposal is longer than ${MAX_PROPOSAL_CHARS.toLocaleString("en-US")} characters.`);
  }
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch (err) {
    refuse(`The proposal is not valid YAML: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!isRecord(doc)) refuse(`The proposal must be a YAML mapping with the fields ${FIELDS.join(", ")}.`);

  const proposal: ProposedSchedule = {};
  for (const [key, value] of Object.entries(doc)) {
    if (value === undefined) continue;
    switch (key) {
      case "name":
        proposal.name = value;
        break;
      case "when":
        proposal.timing = parseWhen(value);
        break;
      case "timeZone":
        proposal.timeZone = value;
        break;
      case "target":
        proposal.target = parseTarget(value);
        break;
      case "params":
        if (value !== null && !isRecord(value)) refuse("params must be a mapping of session-start parameters.");
        proposal.params = value ?? {};
        break;
      case "prompt":
        proposal.prompt = value;
        break;
      case "enabled":
        if (typeof value !== "boolean") refuse("enabled must be true or false.");
        proposal.enabled = value;
        break;
      default:
        refuse(`Unknown field "${key}". Fields: ${FIELDS.join(", ")}.`);
    }
  }
  return proposal;
}
