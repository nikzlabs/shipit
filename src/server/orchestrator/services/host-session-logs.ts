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
 * prompts, queued messages, assistant output, secrets, or workspace files.
 *
 * **A `source` allowlist is NOT sufficient to hold that line, and the first
 * version of this module was wrong to think so.** `"server"` labels the
 * PRODUCER, not the CONTENT, and several server-source producers interpolate
 * text they do not control. The concrete path that killed that design:
 *
 *   1. a project's own `docker-compose.yml` holds an invalid value;
 *   2. `compose-generator.ts` quotes that value VERBATIM in a
 *      `ComposeValidationError` (`device \`${shown}\``, `absolute path
 *      \`${file}\``, `entry \`${trimmed}\``);
 *   3. `service-manager-setup.ts:handleStackError` broadcasts
 *      `[compose] Stack error: ${err.message}` as source `"server"`.
 *
 * So a project could put arbitrary text — including a short secret — into a
 * compose value and have it read from another session. `compose-cli.ts` places
 * raw `docker compose` stderr in an `Error` the same way, and
 * `agent-listeners.ts` broadcasts a raw agent/provider `err.message`.
 *
 * The filter is therefore on the CONTENT: a line is returned only when its
 * WHOLE text matches one of {@link OPS_SAFE_TEMPLATES} — patterns ShipIt itself
 * authored, whose only variable parts are ShipIt-controlled tokens (a count, an
 * exit code, a duration). Free-text interpolation cannot match one, so a line
 * carrying workspace, agent, or user content is withheld by construction rather
 * than by an audit that has to stay correct forever.
 *
 * `source === "server"` is still required as a cheap first cut, so agent
 * stdout/stderr that happens to quote one of these strings can't match either.
 *
 * **The table fails closed and says so.** An unmatched server line is counted
 * and reported, so a producer whose wording drifts shows up as "N lines
 * withheld" instead of silently disappearing. Add a template only for a line
 * whose text is fully ShipIt-authored; when a producer needs to surface
 * interpolated detail, give it a structured field — or split the line in two, an
 * authored one and a detail one — rather than widening a pattern to `.*`.
 * `auto-push-scheduler.ts`'s failure branches are the worked example of the
 * split: the CLASS is ShipIt's own word and gets a template, git's message
 * follows on a `Git said:` line of its own and stays withheld.
 *
 * ## Why the withheld count is broken down, and what the breakdown may say
 *
 * A bare "384 withheld" is not actionable: it reads the same whether it is one
 * chatty producer or the one line an operator needed, drifted off its template.
 * So a withheld line is also matched against {@link WITHHELD_SHAPES} and counted
 * under that entry's LABEL.
 *
 * The labels are ShipIt's own constants and the counts are integers — nothing
 * emitted here is derived from a withheld line's own bytes, which is the
 * property that keeps this on the safe side of the boundary above. The pattern
 * READS the text (there is nothing else to read: the durable entry carries only
 * a timestamp, a source and a text), but every pattern is the ShipIt-authored
 * PREFIX of a producer's format string, so what a match reports is "a line of
 * this producer's shape was here" and never any part of the line. A line whose
 * shape ShipIt cannot name is counted as `withheldUnclassified` and nothing
 * more is said about it.
 *
 * ## Redaction
 *
 * Matched lines still go through `redactStage1` — defense in depth, not the
 * boundary. It only recognizes known shapes (token prefixes, URLs, long opaque
 * strings, absolute paths), so it could never have carried the load the source
 * allowlist put on it. The Stage-2 LLM pass is deliberately NOT run — this is a
 * synchronous read.
 */

import type { SessionInfo } from "../../shared/types.js";
import type { SessionManager } from "../sessions.js";
import { redactStage1 } from "./redaction.js";
import { containerNameForSession } from "./host-sessions.js";
import { MAX_RETAINED_CHANNEL_BYTES } from "../log-store.js";
import { ServiceError } from "./types.js";

/**
 * The ONLY `LogSource` values an ops session may read across the session
 * boundary — the cheap first cut, NOT the boundary itself. See
 * {@link OPS_SAFE_TEMPLATES}, which is what actually holds it.
 */
export const SERVER_LOG_SOURCES: ReadonlySet<string> = new Set(["server"]);

/**
 * Full-line patterns for orchestrator log lines whose text is entirely
 * ShipIt-authored. A server-source line is returned ONLY if it matches one.
 *
 * Rules for adding an entry, in order of importance:
 *
 *  1. **No free-text placeholder.** Every variable part must be a
 *     ShipIt-controlled token — a count, an exit code, a duration. A `.*` or a
 *     `[\s\S]+` in one of these patterns re-opens the exact hole this table was
 *     written to close.
 *  2. **Anchored.** `^…$` both ends, so a longer line that merely starts with a
 *     safe prefix cannot match.
 *  3. **Name the producer** in the comment, so the next person can check the
 *     pattern against the source string it mirrors.
 *
 * Deliberately ABSENT, with the reason, because these are the tempting ones:
 *
 *  - `Git said: ${errMsg}` (auto-push-scheduler) — git's own stderr, on the
 *    line the split moved it to. The authored half that precedes it
 *    (`Auto-push failed (<class>).`) is listed instead, so an ops session can
 *    read WHICH class of failure happened without reading what git said about
 *    it.
 *  - `[compose] Stack error: …`, `[compose] Failed to start: …`,
 *    `[compose] Reconcile failed: …` — quote workspace compose values and raw
 *    `docker compose` stderr. This is the family that broke the first design.
 *  - `[compose] <service> exited with code N` — the service NAME comes from the
 *    project's compose file. An ops session reads service names from Docker
 *    directly, so nothing is lost by withholding it here.
 *  - `Session container exited unexpectedly: <error>` — the `: <error>` form
 *    carries raw Docker text. The `(exit N)` form is listed.
 *  - `Agent process error: …`, `Session workspace could not be restored: …` —
 *    raw agent/provider/git error text.
 */
export const OPS_SAFE_TEMPLATES: readonly { producer: string; pattern: RegExp }[] = [
  // services/auto-push-scheduler.ts — the incident that motivated docs/264.
  {
    // THE positive confirmation. Without it the ops surface reported only
    // FAILURES, so silence meant "pushed fine" or "nothing to push" or "failed
    // in a way with no template" or "aged out of the ring" — four states an
    // operator has to tell apart and could not. Every variable part is a
    // ShipIt-controlled number; the branch, the remote and git's own summary
    // are deliberately not in the line at all.
    //
    // The wording separates the FACT (the push completed) from the ESTIMATE
    // (the count, read from the local view of the remote before the push) —
    // see `auto-push-scheduler.ts` `countPendingCommits` for why the count is
    // not the network's answer.
    producer: "auto-push-scheduler: push completed",
    pattern: /^Auto-push completed in \d+ms: (?:\d+ commit\(s\) (?:was|were) ahead of the last known remote tip|nothing was ahead of the last known remote tip|the commit count could not be measured)\.$/,
  },
  {
    // The two skips, which are the other half of "did it push?": both are
    // fully-authored constants, and both mean the commit is still local.
    producer: "auto-push-scheduler: not pushed (no origin / detached HEAD)",
    pattern: /^Not pushed: (?:this session's workspace has no `origin` remote|the workspace has no current branch \(detached HEAD\))\. The commit stays in local history\.$/,
  },
  {
    producer: "auto-push-scheduler: non-fast-forward",
    pattern: /^Auto-push rejected: this session's branch and its remote have diverged\. Measuring which side carries what\.$/,
  },
  {
    // The measured shape, which is the line an ops session actually needs: it
    // says which SIDE carries work, and therefore whether a force-push would
    // destroy anything. Safe to list because it names no branch and no remote —
    // every variable part is a count. The "could not be measured" form is
    // excluded, since its reason clause can carry git's own error text.
    producer: "auto-push-scheduler: measured divergence shape",
    pattern: /^Divergence shape(?: \(against a remote view that could not be refreshed\))?: \d+ commit\(s\) only in this session, \d+ commit\(s\) only on the remote branch(?:; the two histories share no common commit)?\.(?: A force-push would discard \d+ commit\(s\) from the remote\.)?$/,
  },
  {
    producer: "auto-push-scheduler: invalid token",
    pattern: /^Auto-push failed: your GitHub token is invalid or expired\. Sign in again in Settings → GitHub\.$/,
  },
  {
    // The trailing URL is a CONSTANT in the producer, so match it literally
    // rather than as `\S+` — a placeholder that loose invites someone to reuse
    // the pattern for a line whose URL is interpolated.
    producer: "auto-push-scheduler: missing workflow scope",
    pattern: /^Auto-push failed: your GitHub token needs the `workflow` scope to push changes to GitHub Actions workflow files\. Update your token at https:\/\/github\.com\/settings\/tokens\.$/,
  },
  {
    // Fully authored only since the split moved `Git said: ${errMsg}` off the
    // end of it — the whole reason splitting a producer is the recommended fix
    // rather than widening a pattern.
    producer: "auto-push-scheduler: LFS objects not uploaded",
    pattern: /^Auto-push rejected: the remote refused the push because its Git LFS objects were not uploaded \(GH008\)\. The commit stays in this session's local history\. Run `git lfs push origin HEAD` in the terminal, then push again\.$/,
  },
  {
    // The authored half of the split failure report; git's own text is on the
    // `Git said:` line, which is withheld.
    //
    // The class is ENUMERATED rather than matched as a bounded slug. This table
    // is the boundary itself, not a statement about who produced a line, so
    // "the producer can only ever emit one of seven literals" is the wrong
    // question — `[a-z0-9-]{1,32}` would admit `secret-token` from any future
    // line that happened to fit the surrounding prose. `PushFailureClass`
    // (`services/git.ts`) is a closed union; adding a member means adding it
    // here, which is exactly the review that deserves.
    producer: "auto-push-scheduler: failure class",
    pattern: /^Auto-push failed \((?:non-fast-forward|invalid-refspec|auth|lfs|remote-rejected|network|unknown)\)\. The commit stays in this session's local history\.$/,
  },
  {
    // A push held back while ShipIt's own rebase is in flight — the commit is
    // not lost and a retry is armed, which is exactly what an operator reading
    // a gap between commits needs to know. Counts only.
    producer: "auto-push-scheduler: deferred for a rewrite",
    pattern: /^Push deferred — this session's branch is being rewritten \(a rebase is in flight\), so a push now cannot land\. Retrying in \d+s \(attempt \d+ of \d+\)\.$/,
  },
  {
    producer: "auto-push-scheduler: deferral budget spent",
    pattern: /^A history rewrite has been in flight for \d+ deferred pushes — no longer holding this push back\.$/,
  },
  // idle-enforcer.ts — why a container went away.
  {
    producer: "idle-enforcer: idle shutdown",
    pattern: /^Session container shut down after (?:\d+s|idle period) idle \(workspace preserved\)\. Send a message to resume — a fresh container starts automatically\.$/,
  },
  {
    producer: "idle-enforcer: memory pressure",
    pattern: /^Session container shut down to reclaim memory \(workspace preserved\)\. Send a message to resume\.$/,
  },
  // app-lifecycle.ts — orphan runner recovery.
  {
    producer: "app-lifecycle: container re-adopted",
    pattern: /^Recovered a session container that had lost its orchestrator tracking entry — no restart needed\.$/,
  },
  {
    // startup-tasks.ts `health_monitor_resumed`. Fully authored: `gapLabel` is
    // computed from `gapMs` as `Ns` or `Nms`, both ShipIt-controlled numbers.
    // Worth returning because it is the one line that explains a container
    // "vanishing" with no die event — an ops session chasing exactly that
    // otherwise has no way to know the events stream had a hole in it.
    producer: "startup-tasks: docker events gap",
    pattern: /^Docker events stream resumed after \d+m?s gap — die\/oom events during this window may have been missed\.$/,
  },
  // startup-tasks.ts — the exit-code form only; the `: <error>` form is excluded.
  {
    producer: "startup-tasks: container exited",
    pattern: /^Session container exited unexpectedly(?: \(exit -?\d+\))?\.$/,
  },
  // turn-executor.ts / ws-handlers — agent process lifecycle.
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
    // The interpolated value is an `AgentId` from the registry ("claude" /
    // "codex"), never user text. Matched as a bounded slug rather than a
    // hardcoded list so adding a backend doesn't silently drop the line — a
    // space or quote still fails the match.
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
  // The agent adapters, relayed from the session worker as source "server"
  // (`agent-listeners.ts` `agent.on("log", …)`). Fixed strings, one per CLI —
  // a stuck-process warning is what an operator is looking for when a session's
  // turns stop producing commits, and it is not otherwise visible from the host.
  {
    producer: "claude/process.ts: no CLI output watchdog",
    pattern: /^Warning: No output from Claude CLI after \d+ seconds\. The process may be stuck\.$/,
  },
  {
    producer: "grok/adapter.ts: no CLI output watchdog",
    pattern: /^Warning: no output from the Grok CLI for \d+ seconds\. It may be retrying an upstream error; interrupting the turn is safe\.$/,
  },
  {
    // The three fixed ways a live steer is dropped before it reaches the CLI.
    // No interpolation in any of them — the message TEXT is deliberately never
    // part of the line (the producer logs only its own diagnosis).
    producer: "claude adapter/process: live steer dropped",
    pattern: /^Live steering (?:failed: the agent process is not in streaming mode\. The message was not delivered to the CLI|write failed: (?:the streaming process is not running|stdin is not writable)\. Message dropped)\.$/,
  },
  // keep-preview-running.ts — reserved preview restarts.
  {
    producer: "keep-preview-running: restart attempt",
    pattern: /^Restarting reserved preview runtime \(attempt \d+\/\d+\)\.$/,
  },
  {
    producer: "keep-preview-running: gave up",
    pattern: /^Reserved preview runtime could not be restored after bounded retries\. The reservation remains enabled; check session and service logs\.$/,
  },
];

/** Whether a line's WHOLE text is one ShipIt authored. See the table above. */
export function isOpsSafeLine(text: string): boolean {
  return OPS_SAFE_TEMPLATES.some((t) => t.pattern.test(text));
}

/**
 * How a WITHHELD line is named in the breakdown — the producer's own
 * ShipIt-authored prefix, mapped to a label ShipIt owns.
 *
 * This table classifies; it never returns anything. Rules, which are narrower
 * than {@link OPS_SAFE_TEMPLATES}'s in one place and wider in another:
 *
 *  1. **The `shape` is a constant here, not a piece of the line.** It is the
 *     only thing that escapes, alongside a count. Never build a label out of a
 *     captured group.
 *  2. **The pattern is ShipIt-authored text**, anchored at the start.
 *     Unanchored at the end on purpose — the rest of the line is free text
 *     nobody may read. A `.*`/`.+`/`[\s\S]` is banned, so a pattern cannot
 *     drift into matching everything and reporting one label for the lot.
 *
 *     One pattern (`compose: service exited`) reaches PAST an interpolated
 *     value with a single `\S+`, to test the authored text on the far side of
 *     a service name. That is the deliberate exception, and it is stated here
 *     rather than left as a contradiction between this rule and the table: a
 *     `[compose] ` prefix alone cannot tell "a service died" from "a compose
 *     value was rejected", which is the distinction the breakdown exists to
 *     draw. The meta-test bounds it — at most one `\S+` per pattern, and never
 *     as the last thing in it, so the token can only ever be a bridge between
 *     two pieces of ShipIt's own text and never the match itself.
 *  3. **Most specific first** — the first match wins, so a family's catch-all
 *     (`[compose] `) sits after its named members.
 *
 * A line matching nothing here is counted as `withheldUnclassified`, which is
 * the honest answer and is what makes a NEW chatty producer visible: it shows up
 * as unclassified volume rather than being absorbed into a neighbour's label.
 */
export const WITHHELD_SHAPES: readonly { shape: string; pattern: RegExp }[] = [
  // service-manager-setup.ts / egress-handlers.ts — the family that broke the
  // first design. Every one of these quotes a compose value or docker's stderr.
  { shape: "compose: stack error", pattern: /^\[compose\] Stack error: / },
  { shape: "compose: failed to start", pattern: /^\[compose\] Failed to start: / },
  { shape: "compose: reconcile failed", pattern: /^\[compose\] Reconcile failed: / },
  // startup-tasks.ts — the service NAME is the project's, so the line is
  // withheld; that a service died N times is not.
  {
    shape: "compose: service exited",
    pattern: /^\[compose\] \S+ (?:exited with code -?\d+\.|was OOM-killed \(exit -?\d+\))/,
  },
  { shape: "compose: other", pattern: /^\[compose\] / },
  // ws-handlers/agent-listeners.ts — raw agent/provider error text.
  { shape: "agent: process error", pattern: /^Agent process error: / },
  // services/auto-push-scheduler.ts — the detail half of the split failure
  // report, and the two interpolated forms the templates deliberately exclude.
  { shape: "auto-push: git's own message", pattern: /^Git said: / },
  { shape: "auto-push: unmeasured divergence", pattern: /^Divergence shape: could not be measured/ },
  { shape: "auto-push: other", pattern: /^Auto-push /  },
  // startup-tasks.ts / route-registry.ts / idle-enforcer.ts — raw docker and
  // git text, each on a container-lifecycle path.
  { shape: "container: exit detail", pattern: /^Session container exited unexpectedly: / },
  { shape: "container: idle destroy failed", pattern: /^Failed to destroy idle container: / },
  { shape: "session: workspace not restored", pattern: /^Session workspace could not be restored: / },
  { shape: "session: memory breaker tripped", pattern: /^Session disabled — / },
];

/**
 * The label for a withheld line's shape, or null when ShipIt cannot name it.
 * Reads the text; returns only a constant from {@link WITHHELD_SHAPES}.
 */
export function classifyWithheldLine(text: string): string | null {
  return WITHHELD_SHAPES.find((s) => s.pattern.test(text))?.shape ?? null;
}

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
 * filter, and the channel is a mixed stream where a chatty agent's stdout can
 * outnumber the orchestrator's lines by orders of magnitude, so a small scan
 * window starves exactly the lines this surface exists to return. Paired with
 * `MAX_RETAINED_CHANNEL_BYTES` at the call below — the line cap alone is not
 * enough, because `snapshotEntries` defaults to reading only ONE generation and
 * would drop the rotated half of the retained window before this cap ever
 * applies. Bounded by construction: the store retains at most 2 MB per channel.
 */
const MAX_SCAN_ENTRIES = 200_000;

/** The subset of `LogStore` this service needs. Keeps the unit tests fake-able. */
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
   * Every server-source line in the window that matched no
   * {@link OPS_SAFE_TEMPLATES} entry and was therefore withheld.
   *
   * Reported rather than swallowed. Most of these are lines that legitimately
   * carry workspace or raw error text and will never be returned — but a
   * non-zero count is also the ONLY signal that a producer's wording drifted
   * away from its template, so a line an operator needs would otherwise just
   * stop appearing with nothing to notice.
   */
  withheldTotal: number;
  /**
   * The withheld total split by {@link WITHHELD_SHAPES} label, largest first,
   * and never including a shape with a count of zero.
   *
   * Turns "384 withheld" into something an operator can act on: one chatty
   * producer reads very differently from 384 lines spread across every shape
   * there is. Carries ShipIt's own labels and integer counts only — see the
   * module docstring for why that is not a hole in the content boundary.
   */
  withheldByShape: { shape: string; count: number }[];
  /**
   * Withheld lines whose shape ShipIt could not name — the residue of
   * {@link withheldTotal} after {@link withheldByShape}.
   *
   * The number to watch. A producer that drifts off its template, or a new one
   * nobody has classified, lands here rather than being absorbed into a
   * neighbour's label — so a rising unclassified count is the signal that this
   * file needs an entry, and it is the count a maintainer reads to decide which
   * template to write next.
   */
  withheldUnclassified: number;
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

/**
 * ISO-8601 date, or date + time with an optional zone. Anchored so a bound is
 * accepted only in the form the CLI documents.
 */
const ISO_8601 = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

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
    const bound = nowMs - Number(relative[1]) * RELATIVE_UNITS[relative[2]];
    // `999999999999d` overflows into -Infinity, which compares as "before
    // everything" and silently widens the window to the whole history.
    if (!Number.isFinite(bound)) {
      throw new ServiceError(400, `Invalid ${flag} value "${raw}": the age is out of range.`);
    }
    return bound;
  }
  // Strict ISO-8601 only. `Date.parse` also accepts implementation-defined
  // formats ("Aug 15 2026", "1 Jan"), so accepting whatever it likes would make
  // the contract the docs state differ from the one the code enforces.
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

/**
 * Clamp `lines` into `[1, MAX_LOG_LINES]`, REJECTING a value that isn't a
 * positive integer.
 *
 * Same reasoning as the time bounds: `--lines 0` / `--lines -1` /
 * `--lines garbage` silently becoming 200 tells the operator a bound was
 * applied that never was. Clamping DOWN from a too-large value is different and
 * stays silent — the response says `truncated` and reports `total`, so nothing
 * is hidden.
 */
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
  let withheldTotal = 0;
  let withheldUnclassified = 0;
  /** Label → count. Keyed by a constant from `WITHHELD_SHAPES`, never by text. */
  const byShape = new Map<string, number>();
  // MAX_RETAINED_CHANNEL_BYTES, not the default: this read FILTERS the stream,
  // so the default one-generation window would hide server lines that are still
  // on disk behind a megabyte of agent stdout.
  const scanned = logStore.snapshotEntries(
    session.id,
    AGENT_CHANNEL,
    MAX_SCAN_ENTRIES,
    MAX_RETAINED_CHANNEL_BYTES,
  );
  for (const entry of scanned) {
    // First cut: producer. Everything else in this channel belongs to the
    // session's own user.
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
    // THE boundary: content, not producer. A line whose whole text is not one
    // ShipIt authored is withheld — but COUNTED, so a drifted producer surfaces
    // as "N withheld" instead of vanishing.
    if (!isOpsSafeLine(entry.text)) {
      withheldTotal++;
      // Named by ShipIt's own table, or not named at all. Nothing derived from
      // the line's bytes leaves this branch either way.
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
    // Largest first, ties broken by label so the output is stable between two
    // reads of the same window — an operator comparing them should see a
    // difference only when the counts actually differ.
    withheldByShape: [...byShape.entries()]
      .map(([shape, count]) => ({ shape, count }))
      .sort((a, b) => b.count - a.count || a.shape.localeCompare(b.shape)),
    withheldUnclassified,
    logsRetained: logStore.hasChannel(session.id, AGENT_CHANNEL),
  };
  if (session.userArchived) result.archived = true;
  return result;
}
