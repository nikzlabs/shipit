/**
 * docs/264 — unit tests for the Ops server-log read.
 *
 * The load-bearing test in this file is "never returns a non-server source": it
 * is the executable form of the boundary in `/shipit-docs/ops-session.md`, and
 * it is written as a sweep over EVERY `LogSource` rather than a spot check of
 * stdout, so adding a source to the union without deciding about it fails here.
 */

import { describe, it, expect } from "vitest";
import { DatabaseManager } from "../../shared/database.js";
import { SessionManager } from "../sessions.js";
import { ServiceError } from "./types.js";
import {
  queryHostSessionLogs,
  parseTimeBound,
  DEFAULT_LOG_LINES,
  MAX_LOG_LINES,
  type LogStoreReader,
} from "./host-session-logs.js";

/** Every `LogSource` in the union, so a new one can't slip past the allowlist. */
const ALL_SOURCES = ["stderr", "stdout", "server", "preview", "install"] as const;

const SUBJECT = "7bc72326-c1ad-48fd-ac95-12149a000000";

function createSessionManager(): { sessionManager: SessionManager; close: () => void } {
  const db = new DatabaseManager(":memory:");
  const sessionManager = new SessionManager(db);
  return { sessionManager, close: () => db.close() };
}

/** A fake durable store holding exactly the entries a test seeds. */
function fakeStore(
  entries: { ts: string; source: string; text: string }[],
  opts: { retained?: boolean } = {},
): LogStoreReader {
  return {
    snapshotEntries: () => entries,
    hasChannel: () => opts.retained ?? entries.length > 0,
  };
}

describe("queryHostSessionLogs (docs/264)", () => {
  it("returns server-source entries and NEVER any other source", () => {
    const { sessionManager, close } = createSessionManager();
    try {
      sessionManager.track(SUBJECT, "Subject session");
      const store = fakeStore(
        ALL_SOURCES.map((source, i) => ({
          ts: `2026-08-15T10:0${i}:00.000Z`,
          source,
          text: `line from ${source}`,
        })),
      );

      const result = queryHostSessionLogs(sessionManager, store, SUBJECT);

      expect(result.entries.map((e) => e.source)).toEqual(["server"]);
      expect(result.entries[0].text).toBe("line from server");
      // Every other source's text is absent from the whole serialized payload —
      // not merely absent from `entries`.
      const serialized = JSON.stringify(result);
      for (const source of ALL_SOURCES) {
        if (source === "server") continue;
        expect(serialized).not.toContain(`line from ${source}`);
      }
    } finally {
      close();
    }
  });

  it("withholds an entry whose source is missing, empty, or unknown", () => {
    const { sessionManager, close } = createSessionManager();
    try {
      sessionManager.track(SUBJECT, "Subject session");
      const store = fakeStore([
        { ts: "2026-08-15T10:00:00.000Z", source: "", text: "no source" },
        { ts: "2026-08-15T10:01:00.000Z", source: "future-source", text: "added later" },
        { ts: "2026-08-15T10:02:00.000Z", source: "SERVER", text: "wrong case" },
        { ts: "2026-08-15T10:03:00.000Z", source: "server", text: "kept" },
      ]);

      const result = queryHostSessionLogs(sessionManager, store, SUBJECT);
      expect(result.entries.map((e) => e.text)).toEqual(["kept"]);
    } finally {
      close();
    }
  });

  it("reads a session whose container is gone — store only, no runner", () => {
    const { sessionManager, close } = createSessionManager();
    try {
      // The incident's shape: the session is disk-evicted and long finished, but
      // the durable `logs/` dir is still on the host.
      sessionManager.track(SUBJECT, "Shipkit multi-repo game tooling");
      sessionManager.setDiskTier(SUBJECT, "evicted");
      const store = fakeStore([
        {
          ts: "2026-08-14T22:11:03.000Z",
          source: "server",
          text: "Auto-push rejected: branch has diverged from remote. Rebase needed to update.",
        },
      ]);

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

  it("redacts a credential-bearing URL out of a git error line", () => {
    const { sessionManager, close } = createSessionManager();
    try {
      sessionManager.track(SUBJECT, "Subject session");
      // `Auto-push failed: ${errMsg}` carries git's own stderr, which is where a
      // credentialed remote shows up. Generic `u:pw@` on purpose — a PAT-shaped
      // fixture trips the repo's secret scanner on every commit.
      const store = fakeStore([
        {
          ts: "2026-08-15T10:00:00.000Z",
          source: "server",
          text: "Auto-push failed: fatal: unable to access 'https://u:pw@github.com/o/r.git/'",
        },
      ]);

      const result = queryHostSessionLogs(sessionManager, store, SUBJECT);
      expect(result.entries[0].text).not.toContain("u:pw@");
      expect(result.entries[0].text).toContain("[REDACTED]");
    } finally {
      close();
    }
  });

  it("filters to a --since / --until window and drops undateable entries", () => {
    const { sessionManager, close } = createSessionManager();
    try {
      sessionManager.track(SUBJECT, "Subject session");
      const store = fakeStore([
        { ts: "2026-08-15T08:00:00.000Z", source: "server", text: "too old" },
        { ts: "2026-08-15T10:00:00.000Z", source: "server", text: "in window" },
        { ts: "not-a-timestamp", source: "server", text: "undateable" },
        { ts: "2026-08-15T12:00:00.000Z", source: "server", text: "too new" },
      ]);

      const result = queryHostSessionLogs(sessionManager, store, SUBJECT, {
        since: "2026-08-15T09:00:00Z",
        until: "2026-08-15T11:00:00Z",
      });
      expect(result.entries.map((e) => e.text)).toEqual(["in window"]);
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
        { ts: "2026-08-15T09:30:00.000Z", source: "server", text: "2.5h ago" },
        { ts: "2026-08-15T11:30:00.000Z", source: "server", text: "30m ago" },
      ]);

      const result = queryHostSessionLogs(sessionManager, store, SUBJECT, { since: "2h", nowMs });
      expect(result.entries.map((e) => e.text)).toEqual(["30m ago"]);
    } finally {
      close();
    }
  });

  it("tails to --lines and reports what was dropped", () => {
    const { sessionManager, close } = createSessionManager();
    try {
      sessionManager.track(SUBJECT, "Subject session");
      const store = fakeStore(
        Array.from({ length: 5 }, (_, i) => ({
          ts: `2026-08-15T10:0${i}:00.000Z`,
          source: "server",
          text: `line ${i}`,
        })),
      );

      const result = queryHostSessionLogs(sessionManager, store, SUBJECT, { lines: 2 });
      expect(result.entries.map((e) => e.text)).toEqual(["line 3", "line 4"]);
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
      const store = fakeStore([{ ts: "2026-08-15T10:00:00.000Z", source: "server", text: "hi" }]);

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
      const store = fakeStore([]);
      try {
        queryHostSessionLogs(sessionManager, store, "deadbeef");
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

  it("parses an ISO-8601 instant", () => {
    expect(parseTimeBound("2026-08-15T09:00:00Z", "--since", nowMs)).toBe(
      Date.parse("2026-08-15T09:00:00Z"),
    );
  });

  it("rejects an unparseable bound instead of ignoring it", () => {
    // A silently-dropped bound returns the whole history dressed as the window
    // the operator asked for — the one failure mode that misleads a triage.
    expect(() => parseTimeBound("1 hour ago", "--since", nowMs)).toThrow(ServiceError);
    expect(() => parseTimeBound("2hours", "--until", nowMs)).toThrow(/Invalid --until/);
  });
});

describe("line caps", () => {
  it("defaults and clamps", () => {
    const { sessionManager, close } = createSessionManager();
    try {
      sessionManager.track(SUBJECT, "Subject session");
      const store = fakeStore(
        Array.from({ length: MAX_LOG_LINES + DEFAULT_LOG_LINES + 10 }, (_, i) => ({
          ts: new Date(Date.parse("2026-08-15T00:00:00.000Z") + i * 1000).toISOString(),
          source: "server",
          text: `line ${i}`,
        })),
      );

      expect(queryHostSessionLogs(sessionManager, store, SUBJECT).entries).toHaveLength(
        DEFAULT_LOG_LINES,
      );
      expect(
        queryHostSessionLogs(sessionManager, store, SUBJECT, { lines: 99_999 }).entries,
      ).toHaveLength(MAX_LOG_LINES);
      expect(
        queryHostSessionLogs(sessionManager, store, SUBJECT, { lines: -5 }).entries,
      ).toHaveLength(DEFAULT_LOG_LINES);
    } finally {
      close();
    }
  });
});
