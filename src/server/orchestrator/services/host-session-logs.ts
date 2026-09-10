/** Server-source logs can contain user text. Cross-session reads require a content allowlist. */
import type { SessionInfo } from "../../shared/types.js";
import type { SessionManager } from "../sessions.js";
import { redactStage1 } from "./redaction.js";
import { containerNameForSession } from "./host-sessions.js";
import { MAX_RETAINED_CHANNEL_BYTES } from "../log-store.js";
import { ServiceError } from "./types.js";

export const SERVER_LOG_SOURCES: ReadonlySet<string> = new Set(["server"]);

/** Match full lines. Variable fields must be controlled tokens, never free text; keep producer references. */
export const OPS_SAFE_TEMPLATES: readonly { producer: string; pattern: RegExp }[] = [
  {
    producer: "auto-push-scheduler: push completed",
    pattern: /^Auto-push completed in \d+ms: (?:\d+ commit\(s\) (?:was|were) ahead of the last known remote tip|nothing was ahead of the last known remote tip|the commit count could not be measured)\.$/,
  },
  {
    producer: "auto-push-scheduler: not pushed (no origin / detached HEAD)",
    pattern: /^Not pushed: (?:this session's workspace has no `origin` remote|the workspace has no current branch \(detached HEAD\))\. The commit stays in local history\.$/,
  },
  {
    producer: "auto-push-scheduler: non-fast-forward",
    pattern: /^Auto-push rejected: this session's branch and its remote have diverged\. Measuring which side carries what\.$/,
  },
  {
    producer: "auto-push-scheduler: measured divergence shape",
    pattern: /^Divergence shape(?: \(against a remote view that could not be refreshed\))?: \d+ commit\(s\) only in this session, \d+ commit\(s\) only on the remote branch(?:; the two histories share no common commit)?\.(?: A force-push would discard \d+ commit\(s\) from the remote\.)?$/,
  },
  {
    producer: "auto-push-scheduler: invalid token",
    pattern: /^Auto-push failed: your GitHub token is invalid or expired\. Sign in again in Settings → GitHub\.$/,
  },
  {
    producer: "auto-push-scheduler: missing workflow scope",
    pattern: /^Auto-push failed: your GitHub token needs the `workflow` scope to push changes to GitHub Actions workflow files\. Update your token at https:\/\/github\.com\/settings\/tokens\.$/,
  },
  {
    producer: "auto-push-scheduler: LFS objects not uploaded",
    pattern: /^Auto-push rejected: the remote refused the push because its Git LFS objects were not uploaded \(GH008\)\. The commit stays in this session's local history\. Run `git lfs push origin HEAD` in the terminal, then push again\.$/,
  },
  {
    // Enumerate classes; a generic slug would also admit a secret embedded in this format.
    producer: "auto-push-scheduler: failure class",
    pattern: /^Auto-push failed \((?:non-fast-forward|invalid-refspec|auth|lfs|remote-rejected|network|unknown)\)\. The commit stays in this session's local history\.$/,
  },
  {
    producer: "auto-push-scheduler: deferred for a rewrite",
    pattern: /^Push deferred — this session's branch is being rewritten \(a rebase is in flight\), so a push now cannot land\. Retrying in \d+s \(attempt \d+ of \d+\)\.$/,
  },
  {
    producer: "auto-push-scheduler: deferral budget spent",
    pattern: /^A history rewrite has been in flight for \d+ deferred pushes — no longer holding this push back\.$/,
  },
  {
    producer: "idle-enforcer: idle shutdown",
    pattern: /^Session container shut down after (?:\d+s|idle period) idle \(workspace preserved\)\. Send a message to resume — a fresh container starts automatically\.$/,
  },
  {
    producer: "idle-enforcer: memory pressure",
    pattern: /^Session container shut down to reclaim memory \(workspace preserved\)\. Send a message to resume\.$/,
  },
  {
    producer: "app-lifecycle: container re-adopted",
    pattern: /^Recovered a session container that had lost its orchestrator tracking entry — no restart needed\.$/,
  },
  {
    producer: "startup-tasks: docker events gap",
    pattern: /^Docker events stream resumed after \d+m?s gap — die\/oom events during this window may have been missed\.$/,
  },
  {
    producer: "startup-tasks: container exited",
    pattern: /^Session container exited unexpectedly(?: \(exit -?\d+\))?\.$/,
  },
  {
    producer: "turn-executor: agent exit code",
    pattern: /^Agent process exited with code -?\d+$/,
  },
  { producer: "agent-listeners: agent started", pattern: /^Agent process started$/ },
  {
    producer: "misc-handlers: user interrupt",
    pattern: /^Agent process interrupted by user$/,
  },
  {
    producer: "agent-listeners: steer rejected",
    pattern: /^Live steer rejected by [a-z0-9-]{1,32} \(turn not steerable\) — re-queued for the next turn\.$/,
  },
  {
    producer: "agent-listeners: awaiting question",
    pattern: /^Agent interrupted: waiting for AskUserQuestion answer$/,
  },
  {
    producer: "agent-listeners: awaiting plan approval",
    pattern: /^Agent interrupted: waiting for plan approval$/,
  },
  {
    producer: "claude/process.ts: no CLI output watchdog",
    pattern: /^Warning: No output from Claude CLI after \d+ seconds\. The process may be stuck\.$/,
  },
  {
    producer: "grok/adapter.ts: no CLI output watchdog",
    pattern: /^Warning: no output from the Grok CLI for \d+ seconds\. It may be retrying an upstream error; interrupting the turn is safe\.$/,
  },
  {
    producer: "claude adapter/process: live steer dropped",
    pattern: /^Live steering (?:failed: the agent process is not in streaming mode\. The message was not delivered to the CLI|write failed: (?:the streaming process is not running|stdin is not writable)\. Message dropped)\.$/,
  },
  {
    producer: "keep-preview-running: restart attempt",
    pattern: /^Restarting reserved preview runtime \(attempt \d+\/\d+\)\.$/,
  },
  {
    producer: "service-manager-setup: dep-dir base publish failed",
    pattern: /^Dependency cache: \d+ of \d+ dependency directories could not be snapshotted as a shared base\. Later sessions of this repository reinstall instead of reusing it\.$/,
  },
  {
    producer: "keep-preview-running: gave up",
    pattern: /^Reserved preview runtime could not be restored after bounded retries\. The reservation remains enabled; check session and service logs\.$/,
  },
];

export function isOpsSafeLine(text: string): boolean {
  return OPS_SAFE_TEMPLATES.some((t) => t.pattern.test(text));
}

/**
 * Return constant labels only, never captured text. First match wins.
 * Prefix patterns may bridge one service-name token, but must not become catch-all matches.
 */
export const WITHHELD_SHAPES: readonly { shape: string; pattern: RegExp }[] = [
  { shape: "compose: stack error", pattern: /^\[compose\] Stack error: / },
  { shape: "compose: failed to start", pattern: /^\[compose\] Failed to start: / },
  { shape: "compose: reconcile failed", pattern: /^\[compose\] Reconcile failed: / },
  {
    shape: "compose: service exited",
    pattern: /^\[compose\] \S+ (?:exited with code -?\d+\.|was OOM-killed \(exit -?\d+\))/,
  },
  { shape: "compose: other", pattern: /^\[compose\] / },
  { shape: "agent: process error", pattern: /^Agent process error: / },
  { shape: "auto-push: git's own message", pattern: /^Git said: / },
  { shape: "auto-push: unmeasured divergence", pattern: /^Divergence shape: could not be measured/ },
  { shape: "auto-push: other", pattern: /^Auto-push /  },
  { shape: "container: exit detail", pattern: /^Session container exited unexpectedly: / },
  { shape: "container: idle destroy failed", pattern: /^Failed to destroy idle container: / },
  { shape: "session: workspace not restored", pattern: /^Session workspace could not be restored: / },
  { shape: "session: memory breaker tripped", pattern: /^Session disabled — / },
];

export function classifyWithheldLine(text: string): string | null {
  return WITHHELD_SHAPES.find((s) => s.pattern.test(text))?.shape ?? null;
}

const AGENT_CHANNEL = "agent";
export const DEFAULT_LOG_LINES = 200;
export const MAX_LOG_LINES = 2000;
// Filter before taking the tail; agent output can vastly outnumber server entries.
const MAX_SCAN_ENTRIES = 200_000;

export interface LogStoreReader {
  snapshotEntries(
    sessionId: string,
    channel: string,
    maxLines?: number,
    maxBytes?: number,
  ): { ts: string; source: string; text: string }[];
  hasChannel(sessionId: string, channel: string): boolean;
}

export interface HostSessionLogQuery {
  /** ISO timestamp or relative age, such as 30m. */
  since?: string;
  until?: string;
  lines?: number;
  nowMs?: number;
}

export interface HostSessionLogEntry {
  ts: string;
  source: string;
  text: string;
}

export interface HostSessionLogResult {
  sessionId: string;
  title: string;
  containerName: string;
  diskTier: "hot" | "light" | "evicted";
  archived?: boolean;
  entries: HostSessionLogEntry[];
  /** Matches before the tail limit. */
  total: number;
  truncated: boolean;
  withheldTotal: number;
  withheldByShape: { shape: string; count: number }[];
  withheldUnclassified: number;
  /** Distinguishes no matching entries from logs that have been pruned. */
  logsRetained: boolean;
}

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

const ISO_8601 = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

const RELATIVE_UNITS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

export function parseTimeBound(raw: string, flag: string, nowMs: number): number {
  const value = raw.trim();
  const relative = /^(\d+)([smhd])$/.exec(value);
  if (relative) {
    const bound = nowMs - Number(relative[1]) * RELATIVE_UNITS[relative[2]];
    if (!Number.isFinite(bound)) {
      throw new ServiceError(400, `Invalid ${flag} value "${raw}": the age is out of range.`);
    }
    return bound;
  }
  // Date.parse alone accepts undocumented, implementation-dependent formats.
  const parsed = ISO_8601.test(value) ? Date.parse(value) : Number.NaN;
  if (Number.isNaN(parsed)) {
    throw new ServiceError(
      400,
      `Invalid ${flag} value "${raw}": pass an ISO-8601 timestamp (2026-08-15T09:00:00Z) ` +
        "or a relative age (90s, 30m, 2h, 3d).",
    );
  }
  return parsed;
}

function normalizeLines(lines: number | undefined): number {
  if (lines === undefined) return DEFAULT_LOG_LINES;
  if (!Number.isFinite(lines) || !Number.isInteger(lines) || lines <= 0) {
    throw new ServiceError(
      400,
      `Invalid --lines value: must be a positive integer, got ${lines}.`,
    );
  }
  return Math.min(lines, MAX_LOG_LINES);
}

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
  let withheldTotal = 0;
  let withheldUnclassified = 0;
  const byShape = new Map<string, number>();
  // Include rotated logs; the default byte limit could hide retained server entries behind agent output.
  const scanned = logStore.snapshotEntries(
    session.id,
    AGENT_CHANNEL,
    MAX_SCAN_ENTRIES,
    MAX_RETAINED_CHANNEL_BYTES,
  );
  for (const entry of scanned) {
    if (!SERVER_LOG_SOURCES.has(entry.source)) continue;
    if (sinceMs !== undefined || untilMs !== undefined) {
      const ts = Date.parse(entry.ts);
      if (Number.isNaN(ts)) continue;
      if (sinceMs !== undefined && ts < sinceMs) continue;
      if (untilMs !== undefined && ts > untilMs) continue;
    }
    // Count withheld lines so new producers or changed formats remain visible without exposing their text.
    if (!isOpsSafeLine(entry.text)) {
      withheldTotal++;
      const shape = classifyWithheldLine(entry.text);
      if (shape === null) withheldUnclassified++;
      else byShape.set(shape, (byShape.get(shape) ?? 0) + 1);
      continue;
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
    withheldTotal,
    withheldByShape: [...byShape.entries()]
      .map(([shape, count]) => ({ shape, count }))
      .sort((a, b) => b.count - a.count || a.shape.localeCompare(b.shape)),
    withheldUnclassified,
    logsRetained: logStore.hasChannel(session.id, AGENT_CHANNEL),
  };
  if (session.userArchived) result.archived = true;
  return result;
}
