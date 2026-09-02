/**
 * docs/264 — unit tests for the Ops log read.
 *
 * The load-bearing tests here are the two halves of the boundary in
 * `/shipit-docs/ops-session.md`:
 *
 *  - the producer cut — a sweep over EVERY `LogSource`, derived from the union
 *    itself so adding a member without deciding about it fails to compile;
 *  - the CONTENT cut — the real one. The first version of this feature filtered
 *    on `source === "server"` alone, and an independent review showed that is
 *    not a content classification: workspace-controlled compose values reach a
 *    `"server"` line verbatim. `withholds a server line that quotes workspace
 *    content` is that exact path, and it must never be deleted.
 */

import { describe, it, expect } from "vitest";
import { DatabaseManager } from "../../shared/database.js";
import { SessionManager } from "../sessions.js";
import type { LogSource } from "../../shared/types.js";
import type { PushFailureClass } from "./git.js";
import { ServiceError } from "./types.js";
import {
  queryHostSessionLogs,
  parseTimeBound,
  isOpsSafeLine,
  OPS_SAFE_TEMPLATES,
  WITHHELD_SHAPES,
  DEFAULT_LOG_LINES,
  MAX_LOG_LINES,
  type LogStoreReader,
} from "./host-session-logs.js";

/**
 * Every `LogSource`, derived from the union rather than retyped.
 *
 * `Record<LogSource, true>` is exhaustive at COMPILE time — adding a member to
 * `LogSource` makes this object literal a type error until the new source is
 * listed here, which is what forces a decision about it. An earlier version
 * hard-coded the tuple and claimed the same protection while providing none.
 */
const ALL_SOURCES = Object.keys({
  stderr: true,
  stdout: true,
  server: true,
  preview: true,
  install: true,
} satisfies Record<LogSource, true>) as LogSource[];

/**
 * Every `PushFailureClass`, derived from the union rather than retyped — same
 * compile-time exhaustiveness as `ALL_SOURCES` above, and for the same reason:
 * the failure-class template ENUMERATES the classes, so a member added to the
 * union without a matching alternation would silently stop crossing the session
 * boundary. This makes that a red build instead.
 */
const PUSH_FAILURE_CLASSES = Object.keys({
  "non-fast-forward": true,
  "invalid-refspec": true,
  auth: true,
  lfs: true,
  "remote-rejected": true,
  network: true,
  unknown: true,
} satisfies Record<PushFailureClass, true>) as PushFailureClass[];

/** A line every ops-safe template test can rely on being returned. */
const SAFE_LINE = "Auto-push rejected: this session's branch and its remote have diverged. Measuring which side carries what.";

const SUBJECT = "7bc72326-c1ad-48fd-ac95-12149a000000";

function createSessionManager(): { sessionManager: SessionManager; close: () => void } {
  const db = new DatabaseManager(":memory:");
  const sessionManager = new SessionManager(db);
  return { sessionManager, close: () => db.close() };
}

/**
 * A fake durable store.
 *
 * `rotated` models the store's SECOND retained generation: `snapshotEntries`
 * returns it only when the caller asks for the full retained window. The real
 * `LogStore` defaults to one generation, so a reader that forgets to widen the
 * byte cap silently loses these — which is exactly the bug an earlier version
 * of this service shipped.
 */
function fakeStore(
  entries: { ts: string; source: string; text: string }[],
  opts: { retained?: boolean; rotated?: { ts: string; source: string; text: string }[] } = {},
): LogStoreReader {
  return {
    snapshotEntries: (_id, _channel, _maxLines, maxBytes) =>
      maxBytes !== undefined && maxBytes > 1_000_000 && opts.rotated
        ? [...opts.rotated, ...entries]
        : entries,
    hasChannel: () => opts.retained ?? entries.length > 0,
  };
}


/** Shorthand for a seeded entry. */
function entry(ts: string, source: string, text: string): { ts: string; source: string; text: string } {
  return { ts, source, text };
}

describe("the content boundary (the one that matters)", () => {
  it("withholds a server line that quotes workspace content, and counts it", () => {
    const { sessionManager, close } = createSessionManager();
    try {
      sessionManager.track(SUBJECT, "Subject session");
      // The exact chain an independent review found against the first design:
      // an invalid value in the project's own docker-compose.yml is quoted
      // VERBATIM by compose-generator.ts, raised as a ComposeValidationError,
      // and broadcast as source "server" by handleStackError. Filtering on the
      // source alone returned it — i.e. returned workspace content, which
      // requirement 4 forbids. If this test ever goes green with the marker
      // present, the boundary is broken again.
      const store = fakeStore([
        entry(
          "2026-08-15T10:00:00.000Z",
          "server",
          "[compose] Stack error: Service `web`: device `WORKSPACE-SECRET-MARKER` is not allowed. "
            + "ShipIt only permits the exact `/dev/kvm:/dev/kvm` mapping.",
        ),
        entry("2026-08-15T10:01:00.000Z", "server", SAFE_LINE),
      ]);

      const result = queryHostSessionLogs(sessionManager, store, SUBJECT);

      expect(JSON.stringify(result)).not.toContain("WORKSPACE-SECRET-MARKER");
      expect(result.entries.map((e) => e.text)).toEqual([SAFE_LINE]);
      // Withheld, never silently dropped — and named by ShipIt's own label for
      // the producer, which is the whole of what the breakdown may say about it.
      expect(result.withheldTotal).toBe(1);
      expect(result.withheldByShape).toEqual([{ shape: "compose: stack error", count: 1 }]);
      expect(result.withheldUnclassified).toBe(0);
    } finally {
      close();
    }
  });

  it("withholds the free-text error variants of otherwise-safe producers", () => {
    const { sessionManager, close } = createSessionManager();
    try {
      sessionManager.track(SUBJECT, "Subject session");
      // Each of these shares a prefix with a template but continues into text
      // ShipIt does not control (git stderr, Docker stderr, provider errors).
      // Anchoring is what stops the prefix from being enough.
      const store = fakeStore([
        entry("2026-08-15T10:00:00.000Z", "server", "Auto-push failed: fatal: unable to access 'https://u:pw@github.com/o/r.git/'"),
        entry("2026-08-15T10:01:00.000Z", "server", "Session container exited unexpectedly: OCI runtime error /workspace/x"),
        entry("2026-08-15T10:02:00.000Z", "server", "Agent process error: model refused prompt 'REDACT-ME'"),
        entry("2026-08-15T10:03:00.000Z", "server", "[compose] api-1 exited with code 1."),
        entry("2026-08-15T10:04:00.000Z", "server", "Session workspace could not be restored: /workspace/secret.env missing"),
      ]);

      const result = queryHostSessionLogs(sessionManager, store, SUBJECT);
      expect(result.entries).toEqual([]);
      expect(result.withheldTotal).toBe(5);
      // Every one of them is a shape ShipIt can name, so the operator learns
      // which producers those five were — and still not one byte of any line.
      expect(result.withheldByShape.map((s) => s.shape).sort()).toEqual([
        "agent: process error",
        "auto-push: other",
        "compose: service exited",
        "container: exit detail",
        "session: workspace not restored",
      ]);
      expect(result.withheldUnclassified).toBe(0);
      expect(JSON.stringify(result)).not.toContain("REDACT-ME");
      expect(JSON.stringify(result)).not.toContain("u:pw@");
      // The service name in `[compose] api-1 exited …` is the PROJECT's, and the
      // label must not carry it.
      expect(JSON.stringify(result.withheldByShape)).not.toContain("api-1");
    } finally {
      close();
    }
  });

  it("returns the fixed-template lines an incident actually needs", () => {
    const { sessionManager, close } = createSessionManager();
    try {
      sessionManager.track(SUBJECT, "Subject session");
      const store = fakeStore([
        entry("2026-08-15T10:00:00.000Z", "server", SAFE_LINE),
        entry("2026-08-15T10:01:00.000Z", "server", "Agent process started"),
        entry("2026-08-15T10:02:00.000Z", "server", "Agent process exited with code 137"),
        entry("2026-08-15T10:03:00.000Z", "server", "Session container exited unexpectedly (exit 137)."),
        entry("2026-08-15T10:04:00.000Z", "server", "Session container shut down after 900s idle (workspace preserved). Send a message to resume — a fresh container starts automatically."),
        entry("2026-08-15T10:05:00.000Z", "server", "Restarting reserved preview runtime (attempt 2/3)."),
      ]);

      const result = queryHostSessionLogs(sessionManager, store, SUBJECT);
      expect(result.entries).toHaveLength(6);
      expect(result.withheldUnclassified).toBe(0);
    } finally {
      close();
    }
  });

  it("keeps every template anchored and free of wildcards", () => {
    // A `.*` in one of these patterns silently re-opens the hole the table
    // exists to close, and would pass every other test in this file.
    for (const { producer, pattern } of OPS_SAFE_TEMPLATES) {
      const src = pattern.source;
      expect(src.startsWith("^"), `${producer} must be anchored at the start`).toBe(true);
      expect(src.endsWith("$"), `${producer} must be anchored at the end`).toBe(true);
      expect(src, `${producer} must not use a free-text wildcard`).not.toMatch(/\.\*|\.\+|\[\\s\\S\]/);
    }
  });

  it("keeps every withheld-shape pattern a ShipIt-authored prefix", () => {
    // These read the withheld text, so they get the same anchoring discipline as
    // the ops-safe table minus the end anchor (the rest of the line is the free
    // text nobody may read). A wildcard here would collapse the breakdown into
    // one label for everything, which is worse than no breakdown at all.
    for (const { shape, pattern } of WITHHELD_SHAPES) {
      const src = pattern.source;
      expect(src.startsWith("^"), `${shape} must be anchored at the start`).toBe(true);
      expect(src, `${shape} must not use a free-text wildcard`).not.toMatch(/\.\*|\.\+|\[\\s\\S\]|\\S\*/);
      // The stated exception, bounded: a pattern may bridge ONE interpolated
      // value with `\S+`, and only to reach more of ShipIt's own text on the
      // far side. Trailing, it would be a wildcard by another name — the whole
      // match would then be "prefix + anything", which is what the ban above is
      // for. Two of them is a pattern that has stopped being authored text.
      const bridges = src.match(/\\S\+/g) ?? [];
      expect(bridges.length, `${shape} may bridge at most one interpolated value`).toBeLessThanOrEqual(1);
      if (bridges.length === 1) {
        expect(src.endsWith("\\S+"), `${shape} must not end at its \\S+ bridge`).toBe(false);
      }
    }
  });

  it("counts a withheld line ShipIt cannot name as unclassified, and says nothing else about it", () => {
    const { sessionManager, close } = createSessionManager();
    try {
      sessionManager.track(SUBJECT, "Subject session");
      // A producer nobody has classified — the drift case. It must show up as
      // volume with no name attached, never absorbed into a neighbour's label.
      const store = fakeStore([
        entry("2026-08-15T10:00:00.000Z", "server", "Some future producer said UNNAMED-MARKER"),
        entry("2026-08-15T10:01:00.000Z", "server", "[compose] Stack error: bad value"),
        entry("2026-08-15T10:02:00.000Z", "server", "[compose] Stack error: another bad value"),
      ]);

      const result = queryHostSessionLogs(sessionManager, store, SUBJECT);
      expect(result.withheldTotal).toBe(3);
      expect(result.withheldUnclassified).toBe(1);
      // Largest first — the ordering that makes "one chatty producer" readable.
      expect(result.withheldByShape).toEqual([{ shape: "compose: stack error", count: 2 }]);
      expect(JSON.stringify(result)).not.toContain("UNNAMED-MARKER");
    } finally {
      close();
    }
  });

  it("isOpsSafeLine rejects a template with anything appended", () => {
    expect(isOpsSafeLine(SAFE_LINE)).toBe(true);
    expect(isOpsSafeLine(`${SAFE_LINE} extra text`)).toBe(false);
    expect(isOpsSafeLine(`prefix ${SAFE_LINE}`)).toBe(false);
  });

  it("passes the measured divergence shape — the line that says which side is at risk", () => {
    // The 2026-08-30 incident was diagnosed from the orchestrator's own log. The
    // counts are what distinguish "your commit is unpushed" from "your commit is
    // only on the remote", so an ops session that cannot read them cannot tell
    // the two apart — which is the mistake the notice itself used to make.
    expect(isOpsSafeLine(
      "Divergence shape: 0 commit(s) only in this session, 1 commit(s) only on the remote branch."
      + " A force-push would discard 1 commit(s) from the remote.",
    )).toBe(true);
    expect(isOpsSafeLine(
      "Divergence shape: 2 commit(s) only in this session, 0 commit(s) only on the remote branch.",
    )).toBe(true);
    expect(isOpsSafeLine(
      "Divergence shape (against a remote view that could not be refreshed): 1 commit(s) only in"
      + " this session, 1 commit(s) only on the remote branch; the two histories share no common"
      + " commit. A force-push would discard 1 commit(s) from the remote.",
    )).toBe(true);
  });

  it("passes a SUCCESSFUL auto-push — the line whose absence made silence unreadable", () => {
    // Before this, every auto-push template was a failure path, so a window
    // with no push line meant "pushed fine" OR "nothing to push" OR "failed
    // with no template" OR "aged out of the ring". An operator asking whether
    // the last five turns produced commits could not tell those apart.
    expect(isOpsSafeLine(
      "Auto-push completed in 412ms: 3 commit(s) were ahead of the last known remote tip.",
    )).toBe(true);
    expect(isOpsSafeLine(
      "Auto-push completed in 0ms: 1 commit(s) was ahead of the last known remote tip.",
    )).toBe(true);
    // The distinction that carries most of the value: a push with nothing to
    // send is not a push that failed.
    expect(isOpsSafeLine(
      "Auto-push completed in 88ms: nothing was ahead of the last known remote tip.",
    )).toBe(true);
    expect(isOpsSafeLine(
      "Auto-push completed in 88ms: the commit count could not be measured.",
    )).toBe(true);
    // Both skips, which mean the commit is still local.
    expect(isOpsSafeLine(
      "Not pushed: this session's workspace has no `origin` remote. The commit stays in local history.",
    )).toBe(true);
    expect(isOpsSafeLine(
      "Not pushed: the workspace has no current branch (detached HEAD). The commit stays in local history.",
    )).toBe(true);
  });

  it("passes the authored half of a split failure and withholds git's own half", () => {
    // The producer split (`auto-push-scheduler.ts`): ShipIt's classification on
    // one line, git's words on the next. The first is what an ops session needs
    // — WHICH kind of failure — and the second is what it must never see.
    expect(isOpsSafeLine(
      "Auto-push failed (lfs). The commit stays in this session's local history.",
    )).toBe(true);
    expect(isOpsSafeLine(
      "Auto-push failed (unknown). The commit stays in this session's local history.",
    )).toBe(true);
    expect(isOpsSafeLine("Git said: fatal: unable to access 'https://u:pw@github.com/o/r.git/'")).toBe(false);
    // The class is ENUMERATED, not a slug shape. A slug pattern would have
    // passed both of these — the second is the one that matters: it looks
    // exactly like a class and is not one.
    expect(isOpsSafeLine(
      "Auto-push failed (remote said 'secret path /workspace/x'). The commit stays in this session's local history.",
    )).toBe(false);
    expect(isOpsSafeLine(
      "Auto-push failed (secret-token). The commit stays in this session's local history.",
    )).toBe(false);
  });

  it("enumerates every PushFailureClass, so a new class cannot silently stop crossing", () => {
    // The other half of enumerating rather than slug-matching: the table has to
    // be updated when the union is, and this is what says so out loud.
    for (const cls of PUSH_FAILURE_CLASSES) {
      expect(
        isOpsSafeLine(`Auto-push failed (${cls}). The commit stays in this session's local history.`),
        `PushFailureClass "${cls}" is missing from OPS_SAFE_TEMPLATES`,
      ).toBe(true);
    }
  });

  it("passes the deferral and stuck-CLI lines, whose variable parts are all counts", () => {
    expect(isOpsSafeLine(
      "Push deferred — this session's branch is being rewritten (a rebase is in flight), so a push "
      + "now cannot land. Retrying in 30s (attempt 2 of 30).",
    )).toBe(true);
    expect(isOpsSafeLine(
      "A history rewrite has been in flight for 30 deferred pushes — no longer holding this push back.",
    )).toBe(true);
    expect(isOpsSafeLine(
      "Warning: No output from Claude CLI after 30 seconds. The process may be stuck.",
    )).toBe(true);
    expect(isOpsSafeLine(
      "Warning: no output from the Grok CLI for 60 seconds. It may be retrying an upstream error;"
      + " interrupting the turn is safe.",
    )).toBe(true);
    expect(isOpsSafeLine("Live steering write failed: stdin is not writable. Message dropped.")).toBe(true);
  });

  it("withholds the unmeasured shape, whose reason clause can carry git's own text", () => {
    expect(isOpsSafeLine(
      "Divergence shape: could not be measured — the two histories could not be compared"
      + " (fatal: ambiguous argument 'refs/remotes/origin/secret-branch-name')",
    )).toBe(false);
  });
});

describe("queryHostSessionLogs (docs/264)", () => {
  it("returns server-source entries and NEVER any other source", () => {
    const { sessionManager, close } = createSessionManager();
    try {
      sessionManager.track(SUBJECT, "Subject session");
      // Every source carries the SAME ops-safe text, so the only thing that can
      // exclude the non-server ones is the producer cut.
      const store = fakeStore(
        ALL_SOURCES.map((source, i) => entry(`2026-08-15T10:0${i}:00.000Z`, source, SAFE_LINE)),
      );

      const result = queryHostSessionLogs(sessionManager, store, SUBJECT);
      expect(result.entries.map((e) => e.source)).toEqual(["server"]);
      // A non-server line is not "withheld" — it is not a candidate at all.
      expect(result.withheldUnclassified).toBe(0);
    } finally {
      close();
    }
  });

  it("withholds an entry whose source is missing, empty, or unknown", () => {
    const { sessionManager, close } = createSessionManager();
    try {
      sessionManager.track(SUBJECT, "Subject session");
      const store = fakeStore([
        entry("2026-08-15T10:00:00.000Z", "", SAFE_LINE),
        entry("2026-08-15T10:01:00.000Z", "future-source", SAFE_LINE),
        entry("2026-08-15T10:02:00.000Z", "SERVER", SAFE_LINE),
        entry("2026-08-15T10:03:00.000Z", "server", SAFE_LINE),
      ]);

      expect(queryHostSessionLogs(sessionManager, store, SUBJECT).entries).toHaveLength(1);
    } finally {
      close();
    }
  });

  it("scans the FULL retained window, not just the newest generation", () => {
    const { sessionManager, close } = createSessionManager();
    try {
      sessionManager.track(SUBJECT, "Subject session");
      // The rotated generation holds the server lines; the active one is all
      // agent stdout. Reading a single generation would return nothing at all,
      // while the evidence sat on disk — the failure mode that made the first
      // version's "no auto-push failures" answer untrustworthy.
      const store = fakeStore(
        Array.from({ length: 50 }, (_, i) =>
          entry(`2026-08-15T11:${String(i).padStart(2, "0")}:00.000Z`, "stdout", "chatty agent output"),
        ),
        {
          rotated: [entry("2026-08-15T09:00:00.000Z", "server", SAFE_LINE)],
        },
      );

      const result = queryHostSessionLogs(sessionManager, store, SUBJECT);
      expect(result.entries.map((e) => e.text)).toEqual([SAFE_LINE]);
    } finally {
      close();
    }
  });

  it("reads a session whose container is gone — store only, no runner", () => {
    const { sessionManager, close } = createSessionManager();
    try {
      sessionManager.track(SUBJECT, "Shipkit multi-repo game tooling");
      sessionManager.setDiskTier(SUBJECT, "evicted");
      const store = fakeStore([entry("2026-08-14T22:11:03.000Z", "server", SAFE_LINE)]);

      const result = queryHostSessionLogs(sessionManager, store, SUBJECT);
      expect(result.diskTier).toBe("evicted");
      expect(result.containerName).toBe("agent-7bc72326-c1a");
      expect(result.entries[0].text).toContain("Auto-push rejected");
      expect(result.logsRetained).toBe(true);
    } finally {
      close();
    }
  });

  it("reports logsRetained=false when the durable channel was pruned", () => {
    const { sessionManager, close } = createSessionManager();
    try {
      sessionManager.track(SUBJECT, "Archived session");
      const result = queryHostSessionLogs(sessionManager, fakeStore([], { retained: false }), SUBJECT);
      expect(result.entries).toEqual([]);
      expect(result.logsRetained).toBe(false);
    } finally {
      close();
    }
  });

  it("redacts a URL inside an otherwise ops-safe line", () => {
    const { sessionManager, close } = createSessionManager();
    try {
      sessionManager.track(SUBJECT, "Subject session");
      // Defense in depth, not the boundary: the template already guarantees the
      // text is ShipIt's own, and redaction still collapses the URL it embeds.
      const store = fakeStore([
        entry(
          "2026-08-15T10:00:00.000Z",
          "server",
          "Auto-push failed: your GitHub token needs the `workflow` scope to push changes to "
            + "GitHub Actions workflow files. Update your token at https://github.com/settings/tokens.",
        ),
      ]);

      const result = queryHostSessionLogs(sessionManager, store, SUBJECT);
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].text).toContain("[REDACTED]");
      expect(result.entries[0].text).not.toContain("github.com/settings");
    } finally {
      close();
    }
  });

  it("filters to a --since / --until window and drops undateable entries", () => {
    const { sessionManager, close } = createSessionManager();
    try {
      sessionManager.track(SUBJECT, "Subject session");
      const store = fakeStore([
        entry("2026-08-15T08:00:00.000Z", "server", "Agent process started"),
        entry("2026-08-15T10:00:00.000Z", "server", SAFE_LINE),
        entry("not-a-timestamp", "server", "Agent process interrupted by user"),
        entry("2026-08-15T12:00:00.000Z", "server", "Agent process exited with code 0"),
      ]);

      const result = queryHostSessionLogs(sessionManager, store, SUBJECT, {
        since: "2026-08-15T09:00:00Z",
        until: "2026-08-15T11:00:00Z",
      });
      expect(result.entries.map((e) => e.text)).toEqual([SAFE_LINE]);
    } finally {
      close();
    }
  });

  it("accepts a relative --since age against an injected clock", () => {
    const { sessionManager, close } = createSessionManager();
    try {
      sessionManager.track(SUBJECT, "Subject session");
      const nowMs = Date.parse("2026-08-15T12:00:00.000Z");
      const store = fakeStore([
        entry("2026-08-15T09:30:00.000Z", "server", "Agent process started"),
        entry("2026-08-15T11:30:00.000Z", "server", SAFE_LINE),
      ]);

      const result = queryHostSessionLogs(sessionManager, store, SUBJECT, { since: "2h", nowMs });
      expect(result.entries.map((e) => e.text)).toEqual([SAFE_LINE]);
    } finally {
      close();
    }
  });

  it("tails to --lines and reports what was dropped", () => {
    const { sessionManager, close } = createSessionManager();
    try {
      sessionManager.track(SUBJECT, "Subject session");
      const store = fakeStore(
        Array.from({ length: 5 }, (_, i) =>
          entry(`2026-08-15T10:0${i}:00.000Z`, "server", `Agent process exited with code ${i}`),
        ),
      );

      const result = queryHostSessionLogs(sessionManager, store, SUBJECT, { lines: 2 });
      expect(result.entries.map((e) => e.text)).toEqual([
        "Agent process exited with code 3",
        "Agent process exited with code 4",
      ]);
      expect(result.total).toBe(5);
      expect(result.truncated).toBe(true);
    } finally {
      close();
    }
  });

  it("resolves a truncated id prefix, and refuses an ambiguous one", () => {
    const { sessionManager, close } = createSessionManager();
    try {
      sessionManager.track("abcd1111-0000-0000-0000-000000000000", "A");
      const store = fakeStore([entry("2026-08-15T10:00:00.000Z", "server", SAFE_LINE)]);

      expect(queryHostSessionLogs(sessionManager, store, "abcd1111").sessionId).toBe(
        "abcd1111-0000-0000-0000-000000000000",
      );

      sessionManager.track("abcd1111-0000-0000-0000-999999999999", "B");
      expect(() => queryHostSessionLogs(sessionManager, store, "abcd1111")).toThrow(ServiceError);
    } finally {
      close();
    }
  });

  it("404s an id that matches no session on this host", () => {
    const { sessionManager, close } = createSessionManager();
    try {
      try {
        queryHostSessionLogs(sessionManager, fakeStore([]), "deadbeef");
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(ServiceError);
        expect((err as ServiceError).statusCode).toBe(404);
        expect((err as ServiceError).message).toContain("shipit session find");
      }
    } finally {
      close();
    }
  });

  it("rejects an inverted window rather than silently returning nothing", () => {
    const { sessionManager, close } = createSessionManager();
    try {
      sessionManager.track(SUBJECT, "Subject session");
      expect(() =>
        queryHostSessionLogs(sessionManager, fakeStore([]), SUBJECT, {
          since: "2026-08-15T12:00:00Z",
          until: "2026-08-15T10:00:00Z",
        }),
      ).toThrow(/since is after --until/);
    } finally {
      close();
    }
  });
});

describe("parseTimeBound", () => {
  const nowMs = Date.parse("2026-08-15T12:00:00.000Z");

  it("parses relative ages", () => {
    expect(parseTimeBound("90s", "--since", nowMs)).toBe(nowMs - 90_000);
    expect(parseTimeBound("30m", "--since", nowMs)).toBe(nowMs - 1_800_000);
    expect(parseTimeBound("2h", "--since", nowMs)).toBe(nowMs - 7_200_000);
    expect(parseTimeBound("3d", "--since", nowMs)).toBe(nowMs - 259_200_000);
  });

  it("parses ISO-8601 instants and dates", () => {
    expect(parseTimeBound("2026-08-15T09:00:00Z", "--since", nowMs)).toBe(
      Date.parse("2026-08-15T09:00:00Z"),
    );
    expect(parseTimeBound("2026-08-15", "--since", nowMs)).toBe(Date.parse("2026-08-15"));
  });

  it("rejects an unparseable bound instead of ignoring it", () => {
    // A silently-dropped bound returns the whole history dressed as the window
    // the operator asked for — the one failure mode that misleads a triage.
    expect(() => parseTimeBound("1 hour ago", "--since", nowMs)).toThrow(ServiceError);
    expect(() => parseTimeBound("2hours", "--until", nowMs)).toThrow(/Invalid --until/);
  });

  it("rejects a non-ISO form Date.parse would otherwise accept", () => {
    // `Date.parse` takes implementation-defined formats, which would make the
    // enforced contract wider than the documented one.
    expect(() => parseTimeBound("Aug 15 2026", "--since", nowMs)).toThrow(ServiceError);
    expect(() => parseTimeBound("2026/08/15", "--since", nowMs)).toThrow(ServiceError);
  });

  it("rejects a relative age that overflows", () => {
    // Without the finite check this lands at -Infinity, which compares as
    // "before everything" and silently widens the window to the whole history.
    // The pattern accepts arbitrarily many digits, so this is reachable.
    expect(() => parseTimeBound(`${"9".repeat(320)}d`, "--since", nowMs)).toThrow(/out of range/);
  });
});

describe("line caps", () => {
  it("defaults, clamps down, and REJECTS a non-positive-integer value", () => {
    const { sessionManager, close } = createSessionManager();
    try {
      sessionManager.track(SUBJECT, "Subject session");
      const store = fakeStore(
        Array.from({ length: MAX_LOG_LINES + DEFAULT_LOG_LINES + 10 }, (_, i) =>
          entry(
            new Date(Date.parse("2026-08-15T00:00:00.000Z") + i * 1000).toISOString(),
            "server",
            `Agent process exited with code ${i}`,
          ),
        ),
      );

      expect(queryHostSessionLogs(sessionManager, store, SUBJECT).entries).toHaveLength(
        DEFAULT_LOG_LINES,
      );
      // Clamping DOWN stays silent: `truncated` + `total` already say so.
      expect(
        queryHostSessionLogs(sessionManager, store, SUBJECT, { lines: 99_999 }).entries,
      ).toHaveLength(MAX_LOG_LINES);
      // A bound that was never applied must not look like one that was.
      for (const lines of [0, -5, 2.5, Number.NaN]) {
        expect(() => queryHostSessionLogs(sessionManager, store, SUBJECT, { lines }), `lines=${lines}`)
          .toThrow(/must be a positive integer/);
      }
    } finally {
      close();
    }
  });
});

describe("template patterns vs the strings their producers actually build", () => {
  // Each case is the literal a producer composes, next to whether it may cross
  // the boundary. Written as one table so a pattern edit is checked against the
  // real string rather than against another regex.
  const CASES: { text: string; allowed: boolean; why: string }[] = [
    {
      text: "Session container exited unexpectedly (exit 137).",
      allowed: true,
      why: "startup-tasks.ts exit-code form — the code is ShipIt-observed",
    },
    {
      text: "Session container exited unexpectedly: OCI runtime create failed: /workspace/x.",
      allowed: false,
      why: "the `: <error>` form carries raw Docker text",
    },
    {
      text: "Session container exited unexpectedly.",
      allowed: true,
      why: "the no-detail form",
    },
    {
      text: "Live steer rejected by claude (turn not steerable) — re-queued for the next turn.",
      allowed: true,
      why: "the interpolated value is an AgentId from the registry",
    },
    {
      text: "Live steer rejected by evil name (turn not steerable) — re-queued for the next turn.",
      allowed: false,
      why: "a value with a space is not an AgentId",
    },
    {
      text: "Auto-push failed: your GitHub token needs the `workflow` scope to push changes to "
        + "GitHub Actions workflow files. Update your token at https://github.com/settings/tokens.",
      allowed: true,
      why: "the trailing URL is a constant in the producer",
    },
    {
      text: "Auto-push failed: your GitHub token needs the `workflow` scope to push changes to "
        + "GitHub Actions workflow files. Update your token at https://evil.example/steal",
      allowed: false,
      why: "matched literally, so a different URL cannot ride the pattern",
    },
    {
      text: "Session container shut down after 900s idle (workspace preserved). "
        + "Send a message to resume — a fresh container starts automatically.",
      allowed: true,
      why: "idle-enforcer.ts, duration is ShipIt-computed",
    },
    {
      text: "Agent process exited with code -1",
      allowed: true,
      why: "turn-executor.ts, a numeric exit code",
    },
    {
      text: "Agent process exited with code 1; stderr: cat /workspace/.env",
      allowed: false,
      why: "anchoring stops anything being appended to a safe prefix",
    },
    {
      text: "Restarting reserved preview runtime (attempt 2/3).",
      allowed: true,
      why: "keep-preview-running.ts, both parts are counters",
    },
  ];

  for (const { text, allowed, why } of CASES) {
    it(`${allowed ? "allows" : "withholds"}: ${why}`, () => {
      expect(isOpsSafeLine(text)).toBe(allowed);
    });
  }
});
