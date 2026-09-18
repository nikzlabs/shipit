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

const ALL_SOURCES = Object.keys({
  stderr: true,
  stdout: true,
  server: true,
  preview: true,
  install: true,
} satisfies Record<LogSource, true>) as LogSource[];

const PUSH_FAILURE_CLASSES = Object.keys({
  "non-fast-forward": true,
  "invalid-refspec": true,
  auth: true,
  lfs: true,
  "remote-rejected": true,
  network: true,
  unknown: true,
} satisfies Record<PushFailureClass, true>) as PushFailureClass[];

const SAFE_LINE = "Auto-push rejected: this session's branch and its remote have diverged. Measuring which side carries what.";

const SUBJECT = "7bc72326-c1ad-48fd-ac95-12149a000000";

function createSessionManager(): { sessionManager: SessionManager; close: () => void } {
  const db = new DatabaseManager(":memory:");
  const sessionManager = new SessionManager(db);
  return { sessionManager, close: () => db.close() };
}

// Match the store's default one-generation limit unless the caller widens the byte cap.
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


function entry(ts: string, source: string, text: string): { ts: string; source: string; text: string } {
  return { ts, source, text };
}

describe("the content boundary (the one that matters)", () => {
  it("withholds a server line that quotes workspace content, and counts it", () => {
    const { sessionManager, close } = createSessionManager();
    try {
      sessionManager.track(SUBJECT, "Subject session");
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
    for (const { producer, pattern } of OPS_SAFE_TEMPLATES) {
      const src = pattern.source;
      expect(src.startsWith("^"), `${producer} must be anchored at the start`).toBe(true);
      expect(src.endsWith("$"), `${producer} must be anchored at the end`).toBe(true);
      expect(src, `${producer} must not use a free-text wildcard`).not.toMatch(/\.\*|\.\+|\[\\s\\S\]/);
    }
  });

  it("keeps every withheld-shape pattern a ShipIt-authored prefix", () => {
    for (const { shape, pattern } of WITHHELD_SHAPES) {
      const src = pattern.source;
      expect(src.startsWith("^"), `${shape} must be anchored at the start`).toBe(true);
      expect(src, `${shape} must not use a free-text wildcard`).not.toMatch(/\.\*|\.\+|\[\\s\\S\]|\\S\*/);
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
      const store = fakeStore([
        entry("2026-08-15T10:00:00.000Z", "server", "Some future producer said UNNAMED-MARKER"),
        entry("2026-08-15T10:01:00.000Z", "server", "[compose] Stack error: bad value"),
        entry("2026-08-15T10:02:00.000Z", "server", "[compose] Stack error: another bad value"),
      ]);

      const result = queryHostSessionLogs(sessionManager, store, SUBJECT);
      expect(result.withheldTotal).toBe(3);
      expect(result.withheldUnclassified).toBe(1);
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
    expect(isOpsSafeLine(
      "Auto-push completed in 412ms: 3 commit(s) were ahead of the last known remote tip.",
    )).toBe(true);
    expect(isOpsSafeLine(
      "Auto-push completed in 0ms: 1 commit(s) was ahead of the last known remote tip.",
    )).toBe(true);
    expect(isOpsSafeLine(
      "Auto-push completed in 88ms: nothing was ahead of the last known remote tip.",
    )).toBe(true);
    expect(isOpsSafeLine(
      "Auto-push completed in 88ms: the commit count could not be measured.",
    )).toBe(true);
    expect(isOpsSafeLine(
      "Not pushed: this session's workspace has no `origin` remote. The commit stays in local history.",
    )).toBe(true);
    expect(isOpsSafeLine(
      "Not pushed: the workspace has no current branch (detached HEAD). The commit stays in local history.",
    )).toBe(true);
  });

  it("passes the authored half of a split failure and withholds git's own half", () => {
    expect(isOpsSafeLine(
      "Auto-push failed (lfs). The commit stays in this session's local history.",
    )).toBe(true);
    expect(isOpsSafeLine(
      "Auto-push failed (unknown). The commit stays in this session's local history.",
    )).toBe(true);
    expect(isOpsSafeLine("Git said: fatal: unable to access 'https://u:pw@github.com/o/r.git/'")).toBe(false);
    expect(isOpsSafeLine(
      "Auto-push failed (remote said 'secret path /workspace/x'). The commit stays in this session's local history.",
    )).toBe(false);
    expect(isOpsSafeLine(
      "Auto-push failed (secret-token). The commit stays in this session's local history.",
    )).toBe(false);
  });

  it("enumerates every PushFailureClass, so a new class cannot silently stop crossing", () => {
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
      const store = fakeStore(
        ALL_SOURCES.map((source, i) => entry(`2026-08-15T10:0${i}:00.000Z`, source, SAFE_LINE)),
      );

      const result = queryHostSessionLogs(sessionManager, store, SUBJECT);
      expect(result.entries.map((e) => e.source)).toEqual(["server"]);
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
    expect(() => parseTimeBound("1 hour ago", "--since", nowMs)).toThrow(ServiceError);
    expect(() => parseTimeBound("2hours", "--until", nowMs)).toThrow(/Invalid --until/);
  });

  it("rejects a non-ISO form Date.parse would otherwise accept", () => {
    expect(() => parseTimeBound("Aug 15 2026", "--since", nowMs)).toThrow(ServiceError);
    expect(() => parseTimeBound("2026/08/15", "--since", nowMs)).toThrow(ServiceError);
  });

  it("rejects a relative age that overflows", () => {
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
      expect(
        queryHostSessionLogs(sessionManager, store, SUBJECT, { lines: 99_999 }).entries,
      ).toHaveLength(MAX_LOG_LINES);
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
