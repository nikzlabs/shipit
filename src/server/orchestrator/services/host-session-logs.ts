/**
 * docs/264 — read another session's SERVER-SOURCE log entries, for Ops.
 *
 * ## Why this exists
 *
 * An ops session could already read the host's Docker state, the systemd
 * journal, the deployed ShipIt source and the session inventory — and still
 * could not see the single line that explained a live incident. Nine
 * consecutive post-turn auto-pushes were rejected as non-fast-forward and
 * `docker logs shipit-shipit-1` showed no push and no error, because
 * `services/auto-push-scheduler.ts:report` writes through `broadcastLog`, which
 * goes to the durable log store and the in-memory ring and makes NO console
 * call. From the host the push looked like it had silently vanished; the answer
 * was one line per commit in the session's own Logs panel, which the operator
 * had to read out of the browser by hand.
 *
 * That whole class of failure — auto-push, compose reconcile, container
 * recovery, idle disposal, orphan re-adoption — is orchestrator-generated
 * operational text routed per session rather than to stdout. This module is the
 * read-only, Ops-gated projection of it.
 *
 * ## Why this is NOT "reading another session's conversation"
 *
 * `/shipit-docs/ops-session.md` states, and this module does not weaken, that
 * there is no way for an ops session to read another session's chat history,
 * prompts, queued messages, assistant output, secrets, or workspace files. The
 * agent log channel is a mixed stream: the SAME `agent.jsonl` file carries the
 * agent CLI's own stdout/stderr alongside orchestrator lifecycle lines. So the
 * boundary is held by an ALLOWLIST on `source`, applied here at the store read:
 *
 *   - `"server"`   → orchestrator-generated. The only source that is returned.
 *   - `"stdout"` / `"stderr"` → the agent CLI's own streams. Never returned.
 *   - `"preview"`  → error text posted by the user's running app. Never returned.
 *   - `"install"`  → the workspace's install command output. Never returned.
 *   - anything else, including a missing/empty source → never returned.
 *
 * Fail-closed: the filter is a membership test against {@link SERVER_LOG_SOURCES},
 * so a `LogSource` added later is withheld until someone deliberately adds it.
 * `host-session-logs.test.ts` asserts a non-server entry can never appear.
 *
 * ## Redaction
 *
 * Every returned line goes through `redactStage1` — the same deterministic floor
 * the bug-report path uses (docs/164). It costs some readability (a URL or a
 * 40+ character token collapses to `[REDACTED]`), and that is the right trade at
 * a session boundary: a git error message reaches this stream verbatim, and
 * `pushToOrigin` failures are exactly where a credentialed remote URL shows up.
 * The Stage-2 LLM pass is deliberately NOT run — this is a synchronous read, and
 * Stage 1 is the guaranteed floor.
 */

import type { SessionInfo } from "../../shared/types.js";
import type { SessionManager } from "../sessions.js";
import { redactStage1 } from "./redaction.js";
import { containerNameForSession } from "./host-sessions.js";
import { ServiceError } from "./types.js";

/**
 * The ONLY `LogSource` values an ops session may read across the session
 * boundary. See the module docstring before adding one.
 */
export const SERVER_LOG_SOURCES: ReadonlySet<string> = new Set(["server"]);

/** The durable channel the orchestrator's per-session log lines land in. */
const AGENT_CHANNEL = "agent";

/** Default number of entries returned when the caller doesn't pass `lines`. */
export const DEFAULT_LOG_LINES = 200;
/** Hard cap, so a single read can't flood the ops agent's context. */
export const MAX_LOG_LINES = 2000;

/**
 * How many raw entries to parse out of the durable channel before filtering.
 *
 * Deliberately far above {@link MAX_LOG_LINES}: the tail is taken AFTER the
 * source filter, and the channel is a mixed stream where a chatty agent's
 * stdout can outnumber the orchestrator's lines by orders of magnitude. A small
 * scan window would silently starve the server lines this surface exists to
 * return. Bounded by construction — `LogStore` retains at most two 1 MB files
 * per channel, so this can never read more than a couple of megabytes.
 */
const MAX_SCAN_ENTRIES = 200_000;

/** The subset of `LogStore` this service needs. Keeps the unit tests fake-able. */
export interface LogStoreReader {
  snapshotEntries(
    sessionId: string,
    channel: string,
    maxLines?: number,
  ): { ts: string; source: string; text: string }[];
  hasChannel(sessionId: string, channel: string): boolean;
}

export interface HostSessionLogQuery {
  /** ISO-8601 instant, or a relative age like `30m` / `2h` / `3d`. */
  since?: string;
  until?: string;
  lines?: number;
  /** Injected clock for relative bounds. Defaults to `Date.now()`. */
  nowMs?: number;
}

export interface HostSessionLogEntry {
  ts: string;
  source: string;
  text: string;
}

export interface HostSessionLogResult {
  /** The FULL session id the target resolved to (the caller may pass a prefix). */
  sessionId: string;
  title: string;
  containerName: string;
  diskTier: "hot" | "light" | "evicted";
  archived?: boolean;
  /** Most recent last. Server-source only, redacted. */
  entries: HostSessionLogEntry[];
  /** Matches before the `lines` tail was applied. */
  total: number;
  /** True when older matches were dropped to honour `lines`. */
  truncated: boolean;
  /**
   * Whether the durable channel holds ANY bytes for this session.
   *
   * Distinguishes "this session logged nothing the orchestrator wrote in your
   * window" from "the logs are gone" — archive / delete / full reset call
   * `removeSessionLogs`, and the startup janitor sweeps leftovers. Without it an
   * empty result reads as a clean bill of health for a session whose evidence
   * was simply pruned.
   */
  logsRetained: boolean;
}

/**
 * Resolve a caller-supplied target to one session. Accepts a full id or the
 * truncated prefix an operator lifts out of a journal line or a container name
 * — the same affordance `shipit session find --id` has, so the ops agent does
 * not need a round-trip through `find` just to expand an id it already read.
 *
 * Ambiguity is an ERROR, not a pick: silently choosing one of two sessions is
 * the confidently-wrong attribution the whole ops-inventory surface exists to
 * eliminate.
 */
function resolveTarget(sessionManager: SessionManager, target: string): SessionInfo {
  const trimmed = target.trim();
  if (!trimmed) {
    throw new ServiceError(400, "A session id is required.");
  }
  const exact = sessionManager.get(trimmed);
  if (exact) return exact;

  const matches = sessionManager.findByIdPrefix(trimmed);
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) {
    throw new ServiceError(
      404,
      `No session on this host matches "${trimmed}". ` +
        "Resolve it first with `shipit session find --branch|--pr|--container|--id` " +
        "(add --include-archived for a finished session).",
    );
  }
  throw new ServiceError(
    400,
    `"${trimmed}" matches ${matches.length} sessions (${matches
      .map((s) => s.id)
      .slice(0, 5)
      .join(", ")}). Pass more of the id.`,
  );
}

/** `30m` / `2h` / `3d` / `90s` — the unit multipliers for a relative bound. */
const RELATIVE_UNITS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/**
 * Parse a time bound to epoch millis. Accepts an ISO-8601 instant or a relative
 * AGE (`2h` = two hours before now), which is what an operator has in hand next
 * to `journalctl --since "1 hour ago"`.
 *
 * Rejects rather than ignores an unparseable value: a silently-dropped `--since`
 * returns the whole history dressed as the window the caller asked for, and an
 * operator reading "no lines in the last 10 minutes" off a full-history dump
 * draws exactly the wrong conclusion.
 */
export function parseTimeBound(raw: string, flag: string, nowMs: number): number {
  const value = raw.trim();
  const relative = /^(\d+)([smhd])$/.exec(value);
  if (relative) {
    return nowMs - Number(relative[1]) * RELATIVE_UNITS[relative[2]];
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new ServiceError(
      400,
      `Invalid ${flag} value "${raw}": pass an ISO-8601 timestamp (2026-08-15T09:00:00Z) ` +
        "or a relative age (90s, 30m, 2h, 3d).",
    );
  }
  return parsed;
}

/** Clamp `lines` into `[1, MAX_LOG_LINES]`, falling back to the default. */
function normalizeLines(lines: number | undefined): number {
  if (lines === undefined || !Number.isFinite(lines) || lines <= 0) return DEFAULT_LOG_LINES;
  return Math.min(Math.floor(lines), MAX_LOG_LINES);
}

/**
 * Read one session's server-source log entries out of the durable store.
 *
 * Reads ONLY the host-side `sessions/<id>/logs/agent.jsonl` (docs/192) — no
 * container, no runner, no worker round-trip — so a session whose container was
 * destroyed, idle-evicted, or lost with the orchestrator that ran it still
 * answers. That is the case the incident was in.
 */
export function queryHostSessionLogs(
  sessionManager: SessionManager,
  logStore: LogStoreReader,
  target: string,
  query: HostSessionLogQuery = {},
): HostSessionLogResult {
  const session = resolveTarget(sessionManager, target);
  const nowMs = query.nowMs ?? Date.now();
  const sinceMs = query.since !== undefined ? parseTimeBound(query.since, "--since", nowMs) : undefined;
  const untilMs = query.until !== undefined ? parseTimeBound(query.until, "--until", nowMs) : undefined;
  if (sinceMs !== undefined && untilMs !== undefined && sinceMs > untilMs) {
    throw new ServiceError(400, "--since is after --until: the window is empty.");
  }
  const lines = normalizeLines(query.lines);

  const matched: HostSessionLogEntry[] = [];
  for (const entry of logStore.snapshotEntries(session.id, AGENT_CHANNEL, MAX_SCAN_ENTRIES)) {
    // THE boundary. Everything else in this channel belongs to the session's own
    // user — see the module docstring.
    if (!SERVER_LOG_SOURCES.has(entry.source)) continue;
    if (sinceMs !== undefined || untilMs !== undefined) {
      const ts = Date.parse(entry.ts);
      // An unparseable timestamp cannot be placed in the window. Drop it rather
      // than pass it through, so a bounded read never returns a line the caller
      // cannot date.
      if (Number.isNaN(ts)) continue;
      if (sinceMs !== undefined && ts < sinceMs) continue;
      if (untilMs !== undefined && ts > untilMs) continue;
    }
    matched.push({ ts: entry.ts, source: entry.source, text: redactStage1(entry.text).text });
  }

  const page = matched.length > lines ? matched.slice(matched.length - lines) : matched;
  const result: HostSessionLogResult = {
    sessionId: session.id,
    title: session.title,
    containerName: containerNameForSession(session.id),
    diskTier: session.diskTier ?? "hot",
    entries: page,
    total: matched.length,
    truncated: page.length < matched.length,
    logsRetained: logStore.hasChannel(session.id, AGENT_CHANNEL),
  };
  if (session.userArchived) result.archived = true;
  return result;
}
