import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DatabaseManager } from "../shared/database.js";
import {
  SessionManager,
  filterVisibleInSidebar,
  reopenedAfterMerge,
  MAX_MERGED_SESSIONS_PER_REPO,
} from "./sessions.js";
import type { SessionInfo } from "../shared/types.js";
import { ChatHistoryManager } from "./chat-history.js";
import { UsageManager } from "./usage.js";
import { deleteSession } from "./services/session.js";

describe("SessionManager", () => {
  let dbManager: DatabaseManager;

  beforeEach(() => {
    dbManager = new DatabaseManager(":memory:");
  });

  afterEach(() => {
    dbManager.close();
  });

  it("starts with an empty list when no sessions exist", () => {
    const mgr = new SessionManager(dbManager);
    expect(mgr.list()).toEqual([]);
  });

  it("tracks a new session", () => {
    const mgr = new SessionManager(dbManager);
    const session = mgr.track("sess-1", "My first session");

    expect(session.id).toBe("sess-1");
    expect(session.title).toBe("My first session");
    expect(session.createdAt).toBeTruthy();
    expect(session.lastUsedAt).toBeTruthy();
  });

  it("updates lastUsedAt and title when tracking an existing session", () => {
    const mgr = new SessionManager(dbManager);
    const original = mgr.track("sess-1", "Original title");

    const updated = mgr.track("sess-1", "Updated title");
    expect(updated.id).toBe("sess-1");
    expect(updated.title).toBe("Updated title");
    expect(updated.createdAt).toBe(original.createdAt);
    expect(updated.lastUsedAt).toBeTruthy();
  });

  it("uses default title when none provided", () => {
    const mgr = new SessionManager(dbManager);
    const session = mgr.track("sess-1");
    expect(session.title).toBe("New session");
  });

  it("does not overwrite title with undefined on re-track", () => {
    const mgr = new SessionManager(dbManager);
    mgr.track("sess-1", "Keep this title");
    const updated = mgr.track("sess-1");
    expect(updated.title).toBe("Keep this title");
  });

  it("lists sessions sorted by lastUsedAt (most recent first)", () => {
    const mgr = new SessionManager(dbManager);
    mgr.track("old", "Old session");
    mgr.track("new", "New session");

    const list = mgr.list();
    expect(list).toHaveLength(2);
    expect(list[0].id).toBe("new");
    expect(list[1].id).toBe("old");
  });

  it("deletes a session by id", () => {
    const mgr = new SessionManager(dbManager);
    mgr.track("sess-1", "To delete");
    mgr.track("sess-2", "To keep");

    const deleted = mgr.delete("sess-1");
    expect(deleted).toBe(true);
    expect(mgr.list()).toHaveLength(1);
    expect(mgr.list()[0].id).toBe("sess-2");
  });

  it("returns false when deleting a non-existent session", () => {
    const mgr = new SessionManager(dbManager);
    expect(mgr.delete("nonexistent")).toBe(false);
  });

  it("docs/138: agentPinned defaults to false and is set by setAgentPinned", () => {
    const mgr = new SessionManager(dbManager);
    mgr.track("sess-1", "Pin me");
    expect(mgr.get("sess-1")!.agentPinned).toBeUndefined();

    mgr.setAgentId("sess-1", "claude");
    mgr.setAgentPinned("sess-1");

    const reloaded = new SessionManager(dbManager).get("sess-1")!;
    expect(reloaded.agentId).toBe("claude");
    expect(reloaded.agentPinned).toBe(true);
  });

  it("docs/150: persists provider route kind and id", () => {
    const mgr = new SessionManager(dbManager);
    mgr.track("sess-1", "Route me");

    mgr.setProviderRoute("sess-1", "account", "claude-default");

    const reloaded = new SessionManager(dbManager).get("sess-1")!;
    expect(reloaded.providerRouteKind).toBe("account");
    expect(reloaded.providerRouteId).toBe("claude-default");
  });

  it("persists sessions across manager instances", () => {
    const mgr1 = new SessionManager(dbManager);
    mgr1.track("sess-1", "Persisted");

    const mgr2 = new SessionManager(dbManager);
    const list = mgr2.list();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe("sess-1");
    expect(list[0].title).toBe("Persisted");
  });

  it("renames a session by id", () => {
    const mgr = new SessionManager(dbManager);
    mgr.track("sess-1", "Original");
    const renamed = mgr.rename("sess-1", "Renamed");
    expect(renamed).not.toBeNull();
    expect(renamed!.id).toBe("sess-1");
    expect(renamed!.title).toBe("Renamed");

    const mgr2 = new SessionManager(dbManager);
    expect(mgr2.list()[0].title).toBe("Renamed");
  });

  it("returns null when renaming a non-existent session", () => {
    const mgr = new SessionManager(dbManager);
    expect(mgr.rename("nonexistent", "New name")).toBeNull();
  });

  it("list() returns independent copies", () => {
    const mgr = new SessionManager(dbManager);
    mgr.track("sess-1");
    const list = mgr.list();
    list.push({ id: "fake", title: "fake", createdAt: "", lastUsedAt: "", remoteUrl: "" });
    expect(mgr.list()).toHaveLength(1);
  });

  describe("markStarted", () => {
    it("resets createdAt to the current time", async () => {
      const mgr = new SessionManager(dbManager);
      const original = mgr.track("sess-1", "Warm session");
      // Wait long enough to guarantee a different ISO timestamp.
      await new Promise((r) => setTimeout(r, 5));
      mgr.markStarted("sess-1");
      const updated = mgr.get("sess-1")!;
      expect(updated.createdAt > original.createdAt).toBe(true);
      expect(updated.lastUsedAt > original.lastUsedAt).toBe(true);
    });

    it("is a no-op for unknown ids", () => {
      const mgr = new SessionManager(dbManager);
      // Should not throw or insert anything.
      mgr.markStarted("nonexistent");
      expect(mgr.list()).toEqual([]);
    });
  });

  describe("findUngraduatedWarm", () => {
    it("finds a warm session by remote URL", () => {
      const mgr = new SessionManager(dbManager);
      mgr.track("warm-1", "Warm session");
      mgr.setWarm("warm-1", true);
      mgr.setRemoteUrl("warm-1", "https://github.com/user/repo.git");

      const found = mgr.findUngraduatedWarm("https://github.com/user/repo.git");
      expect(found).toBeDefined();
      expect(found!.id).toBe("warm-1");
      expect(found!.warm).toBe(true);
    });

    it("returns undefined when no warm session matches", () => {
      const mgr = new SessionManager(dbManager);
      mgr.track("normal-1", "Normal");
      mgr.setRemoteUrl("normal-1", "https://github.com/user/repo.git");

      expect(mgr.findUngraduatedWarm("https://github.com/user/repo.git")).toBeUndefined();
    });

    it("excludes the specified session ID", () => {
      const mgr = new SessionManager(dbManager);
      mgr.track("warm-1", "Warm 1");
      mgr.setWarm("warm-1", true);
      mgr.setRemoteUrl("warm-1", "https://github.com/user/repo.git");

      expect(mgr.findUngraduatedWarm("https://github.com/user/repo.git", "warm-1")).toBeUndefined();
    });

    it("does not match warm sessions for a different repo", () => {
      const mgr = new SessionManager(dbManager);
      mgr.track("warm-1", "Warm 1");
      mgr.setWarm("warm-1", true);
      mgr.setRemoteUrl("warm-1", "https://github.com/user/other.git");

      expect(mgr.findUngraduatedWarm("https://github.com/user/repo.git")).toBeUndefined();
    });
  });

  describe("PR status snapshot", () => {
    function makeStatus(overrides: Partial<{
      sessionId: string;
      prNumber: number;
      prState: "open" | "merged" | "closed";
    }> = {}) {
      return {
        sessionId: overrides.sessionId ?? "sess-1",
        prNumber: overrides.prNumber ?? 42,
        prUrl: "https://github.com/o/r/pull/42",
        prTitle: "Add thing",
        prBody: "",
        prState: overrides.prState ?? "open",
        baseBranch: "main",
        headBranch: "shipit/feature",
        insertions: 10,
        deletions: 2,
        checks: { state: "success" as const, total: 1, passed: 1, failed: 0, pending: 0 },
        mergeable: "mergeable" as const,
        reviewDecision: "none" as const,
        autoMergeEnabled: false,
      };
    }

    it("persists and retrieves a PR status snapshot", () => {
      const mgr = new SessionManager(dbManager);
      mgr.track("sess-1", "Test");
      mgr.setPrStatus("sess-1", makeStatus());

      const all = mgr.getAllPrStatuses();
      expect(all).toHaveLength(1);
      expect(all[0]).toMatchObject({ sessionId: "sess-1", prNumber: 42, prState: "open" });
    });

    it("retains the snapshot after archiving", () => {
      const mgr = new SessionManager(dbManager);
      mgr.track("sess-1", "Test");
      mgr.setPrStatus("sess-1", makeStatus({ prState: "merged" }));

      mgr.archive("sess-1");

      // Active list excludes archived sessions, but the snapshot survives
      expect(mgr.list()).toHaveLength(0);
      const all = mgr.getAllPrStatuses();
      expect(all).toHaveLength(1);
      expect(all[0]).toMatchObject({ sessionId: "sess-1", prState: "merged" });
    });

    it("clears the snapshot when set to null", () => {
      const mgr = new SessionManager(dbManager);
      mgr.track("sess-1", "Test");
      mgr.setPrStatus("sess-1", makeStatus());
      mgr.setPrStatus("sess-1", null);

      expect(mgr.getAllPrStatuses()).toEqual([]);
    });

    it("survives a manager restart (DB round-trip)", () => {
      const mgr = new SessionManager(dbManager);
      mgr.track("sess-1", "Test");
      mgr.setPrStatus("sess-1", makeStatus({ prState: "merged" }));

      const mgr2 = new SessionManager(dbManager);
      const all = mgr2.getAllPrStatuses();
      expect(all).toHaveLength(1);
      expect(all[0]).toMatchObject({ sessionId: "sess-1", prState: "merged" });
    });

    it("ignores corrupt JSON without crashing", () => {
      const mgr = new SessionManager(dbManager);
      mgr.track("sess-1", "Test");
      // Bypass the typed setter to inject malformed JSON
      dbManager.db.prepare("UPDATE sessions SET pr_status = ? WHERE id = ?").run("{not-json", "sess-1");
      expect(() => mgr.getAllPrStatuses()).not.toThrow();
      expect(mgr.getAllPrStatuses()).toEqual([]);
    });
  });

  describe("session deletion cascade", () => {
    it("deleteSession cascades to chat history and usage", () => {
      const sessions = new SessionManager(dbManager);
      const chat = new ChatHistoryManager(dbManager);
      const usage = new UsageManager(dbManager);

      sessions.track("sess-1", "Test");
      chat.append("sess-1", { role: "user", text: "Hello" });
      usage.record("sess-1", 0.05, 3000);

      const deleted = deleteSession(sessions, "sess-1", chat, usage);

      expect(deleted).toBe(true);
      expect(sessions.get("sess-1")).toBeUndefined();
      expect(chat.load("sess-1")).toEqual([]);
      expect(usage.getSessionUsage("sess-1")).toBeUndefined();
    });

    it("deleteSession returns false for nonexistent session without touching stores", () => {
      const sessions = new SessionManager(dbManager);
      const chat = new ChatHistoryManager(dbManager);
      const usage = new UsageManager(dbManager);

      // Add data for a different session
      sessions.track("sess-2", "Keep");
      chat.append("sess-2", { role: "user", text: "Kept" });
      usage.record("sess-2", 0.10, 5000);

      const deleted = deleteSession(sessions, "nonexistent", chat, usage);

      expect(deleted).toBe(false);
      // Other session data untouched
      expect(chat.load("sess-2")).toHaveLength(1);
      expect(usage.getSessionUsage("sess-2")).toBeDefined();
    });
  });

  describe("docs/161: disk tier + archival columns", () => {
    it("defaults a fresh session to hot tier and not user-archived", () => {
      const mgr = new SessionManager(dbManager);
      mgr.track("sess-1", "Fresh");
      const s = mgr.get("sess-1")!;
      expect(s.diskTier).toBe("hot");
      expect(s.userArchived).toBeUndefined();
      expect(s.archived).toBeUndefined();
    });

    it("archive() sets user_archived and evicts the disk tier", () => {
      const mgr = new SessionManager(dbManager);
      mgr.track("sess-1", "Hide me");
      mgr.archive("sess-1");
      const s = mgr.get("sess-1")!;
      expect(s.userArchived).toBe(true);
      expect(s.archived).toBe(true); // back-compat alias
      expect(s.diskTier).toBe("evicted");
      expect(mgr.list()).toHaveLength(0);
    });

    it("unarchive() clears user_archived and restores the disk tier to hot", () => {
      const mgr = new SessionManager(dbManager);
      mgr.track("sess-1", "Restore me");
      mgr.archive("sess-1");
      const restored = mgr.unarchive("sess-1");
      expect(restored).toBe(true);
      const s = mgr.get("sess-1")!;
      expect(s.userArchived).toBeUndefined();
      expect(s.diskTier).toBe("hot");
      expect(mgr.list()).toHaveLength(1);
    });

    it("listArchived() returns evicted sessions; listAll() includes them", () => {
      const mgr = new SessionManager(dbManager);
      mgr.track("active", "Active");
      mgr.track("hidden", "Hidden");
      mgr.archive("hidden");

      expect(mgr.listArchived().map((s) => s.id)).toEqual(["hidden"]);
      expect(mgr.listAll().map((s) => s.id).sort()).toEqual(["active", "hidden"]);
      expect(mgr.list().map((s) => s.id)).toEqual(["active"]);
    });
  });

  describe("docs/161: reopenedAfterMerge predicate", () => {
    function make(overrides: Partial<SessionInfo>): SessionInfo {
      return {
        id: "x",
        title: "t",
        createdAt: "2024-01-01T00:00:00.000Z",
        lastUsedAt: "2024-01-01T00:00:00.000Z",
        remoteUrl: "https://github.com/o/r.git",
        ...overrides,
      };
    }

    it("is false for a never-merged session", () => {
      expect(reopenedAfterMerge(make({}))).toBe(false);
    });

    it("is false when the branch last advanced before the merge", () => {
      // merged_at and last_branch_commit_at use SQLite datetime() format; the
      // predicate parses both via parseTimestampMs rather than comparing lexically.
      expect(reopenedAfterMerge(make({
        mergedAt: "2024-06-01 12:00:00",
        lastBranchCommitAt: "2024-05-01 00:00:00",
      }))).toBe(false);
    });

    it("is true when the branch advanced after the merge despite mixed timestamp formats", () => {
      expect(reopenedAfterMerge(make({
        mergedAt: "2024-06-01 12:00:00",
        lastBranchCommitAt: "2024-06-02T00:00:00.000Z",
      }))).toBe(true);
    });

    it("is false when a no-op turn bumped lastUsedAt past the merge but the branch did not advance", () => {
      // The core docs/161 fix: answering a question or spawning a child session
      // bumps lastUsedAt without committing. That must NOT count as a reopen, or
      // the merged session (and its merged children) wrongly float back to Active.
      expect(reopenedAfterMerge(make({
        mergedAt: "2024-06-01 12:00:00",
        lastUsedAt: "2024-06-05T00:00:00.000Z", // worked in after merge…
        // …but no lastBranchCommitAt after the merge → not a genuine reopen.
        lastBranchCommitAt: "2024-05-31 09:00:00",
      }))).toBe(false);
    });

    it("is false for a merged session that never recorded a branch commit (legacy rows)", () => {
      expect(reopenedAfterMerge(make({
        mergedAt: "2024-06-01 12:00:00",
        lastUsedAt: "2024-06-05T00:00:00.000Z",
      }))).toBe(false);
    });

    it("is false when the merge follows the last branch commit by seconds (the typical merge flow)", () => {
      // Regression: the last commit lands moments before the PR merges. Both
      // timestamps are UTC, but `merged_at` is the suffix-less SQLite form and a
      // commit time may be ISO. A naive `Date.parse` reads `merged_at` as LOCAL
      // time, so in a UTC+ timezone it lands *before* the commit and the session
      // is wrongly treated as reopened. UTC-normalized parsing keeps it correctly
      // demoted regardless of host timezone.
      expect(reopenedAfterMerge(make({
        lastBranchCommitAt: "2024-06-01T11:59:55.000Z",
        mergedAt: "2024-06-01 12:00:00",
      }))).toBe(false);
    });
  });

  describe("docs/161: filterVisibleInSidebar predicate", () => {
    function merged(id: string, mergedAt: string, lastUsedAt = mergedAt, remoteUrl = "https://github.com/o/r.git"): SessionInfo {
      return {
        id,
        title: id,
        createdAt: "2024-01-01T00:00:00.000Z",
        lastUsedAt,
        remoteUrl,
        mergedAt,
      };
    }
    function active(id: string, remoteUrl = "https://github.com/o/r.git"): SessionInfo {
      return {
        id,
        title: id,
        createdAt: "2024-01-01T00:00:00.000Z",
        lastUsedAt: "2024-01-01T00:00:00.000Z",
        remoteUrl,
      };
    }

    it("always keeps active (never-merged) sessions", () => {
      const sessions = [active("a"), active("b")];
      expect(filterVisibleInSidebar(sessions).map((s) => s.id)).toEqual(["a", "b"]);
    });

    it("keeps only the top-N most-recently-merged per repo", () => {
      const sessions = [
        merged("m1", "2024-01-01 09:00:00"),
        merged("m2", "2024-01-02 09:00:00"),
        merged("m3", "2024-01-03 09:00:00"),
        merged("m4", "2024-01-04 09:00:00"),
      ];
      const visible = filterVisibleInSidebar(sessions, 3).map((s) => s.id).sort();
      // The three newest merges survive; the oldest (m1) drops off.
      expect(visible).toEqual(["m2", "m3", "m4"]);
    });

    it("applies the cap per-repo independently", () => {
      const repoA = "https://github.com/o/a.git";
      const repoB = "https://github.com/o/b.git";
      const sessions = [
        merged("a1", "2024-01-01 09:00:00", "2024-01-01 09:00:00", repoA),
        merged("a2", "2024-01-02 09:00:00", "2024-01-02 09:00:00", repoA),
        merged("b1", "2024-01-01 09:00:00", "2024-01-01 09:00:00", repoB),
        merged("b2", "2024-01-02 09:00:00", "2024-01-02 09:00:00", repoB),
      ];
      // Cap of 1 per repo keeps the newest in each.
      expect(filterVisibleInSidebar(sessions, 1).map((s) => s.id).sort()).toEqual(["a2", "b2"]);
    });

    it("keeps a merged session that was reopened even when it is beyond the cap", () => {
      const sessions = [
        // Oldest merge, but the branch advanced after the merge → genuine reopen.
        { ...merged("reopened", "2024-01-01 09:00:00"), lastBranchCommitAt: "2024-12-01T00:00:00.000Z" },
        merged("m2", "2024-01-02 09:00:00"),
        merged("m3", "2024-01-03 09:00:00"),
        merged("m4", "2024-01-04 09:00:00"),
      ];
      const visible = filterVisibleInSidebar(sessions, 3).map((s) => s.id);
      // `reopened` has the oldest merge time but post-merge branch work → never pruned.
      expect(visible).toContain("reopened");
    });

    it("defaults the cap to MAX_MERGED_SESSIONS_PER_REPO", () => {
      const sessions = Array.from({ length: MAX_MERGED_SESSIONS_PER_REPO + 2 }, (_, i) =>
        merged(`m${i}`, `2024-01-0${i + 1} 09:00:00`),
      );
      expect(filterVisibleInSidebar(sessions)).toHaveLength(MAX_MERGED_SESSIONS_PER_REPO);
    });

    it("excludes user-archived sessions from the result", () => {
      const sessions = [active("a"), { ...active("b"), userArchived: true }];
      expect(filterVisibleInSidebar(sessions).map((s) => s.id)).toEqual(["a"]);
    });

    it("archiving a visible merged session does not promote a demoted one", () => {
      // m4,m3,m2 are within the cap of 3; m1 is demoted (oldest merge).
      const sessions = [
        merged("m1", "2024-01-01 09:00:00"),
        merged("m2", "2024-01-02 09:00:00"),
        merged("m3", "2024-01-03 09:00:00"),
        merged("m4", "2024-01-04 09:00:00"),
      ];
      // Archive m3 (one of the three visible). It keeps its ranking slot, so the
      // freed view goes to N-1 rather than pulling m1 back up.
      const withArchive = sessions.map((s) => (s.id === "m3" ? { ...s, userArchived: true } : s));
      const visible = filterVisibleInSidebar(withArchive, 3).map((s) => s.id).sort();
      expect(visible).toEqual(["m2", "m4"]);
    });

    it("releases the slot once newer merges push the archived session past the cap", () => {
      // m1 archived but newest; two newer merges (m2, m3) arrive after it. With a
      // cap of 2, m1's slot is consumed by the newer m3/m2, so m1 stops holding it.
      const sessions = [
        { ...merged("m1", "2024-01-03 09:00:00"), userArchived: true },
        merged("m2", "2024-01-02 09:00:00"),
        merged("m3", "2024-01-04 09:00:00"),
        merged("m4", "2024-01-01 09:00:00"),
      ];
      // Ranking incl. archived: m3, m1(archived), m2, m4. Cap 2 → top = m3, m1.
      // m1 is archived → hidden; only m3 shows. m2/m4 stay demoted.
      expect(filterVisibleInSidebar(sessions, 2).map((s) => s.id)).toEqual(["m3"]);
    });

    // docs/117 — the merged view cap is automatic archiving, and spawned
    // parent/child clusters are exempt from it (they leave only via a manual
    // archive that cascades parent → children).
    describe("parent/child exemption from the merged cap", () => {
      it("never demotes a merged parent that still has a live child", () => {
        // parent would be the oldest merge → past a cap of 1, but its live child
        // pins it in the sidebar.
        const sessions = [
          merged("parent", "2024-01-01 09:00:00"),
          merged("other", "2024-01-02 09:00:00"),
          { ...active("child"), parentSessionId: "parent" },
        ];
        const visible = filterVisibleInSidebar(sessions, 1).map((s) => s.id).sort();
        expect(visible).toEqual(["child", "other", "parent"]);
      });

      it("never demotes a merged child while its parent is still live", () => {
        // child is the oldest merge → past a cap of 1, but its live parent keeps it.
        const sessions = [
          active("parent"),
          merged("other", "2024-01-02 09:00:00"),
          { ...merged("child", "2024-01-01 09:00:00"), parentSessionId: "parent" },
        ];
        const visible = filterVisibleInSidebar(sessions, 1).map((s) => s.id).sort();
        expect(visible).toEqual(["child", "other", "parent"]);
      });

      it("does not pin a parent open via a user-archived child", () => {
        // The only child is user-archived → it shouldn't rescue the parent from
        // the cap, and it is itself excluded from the result.
        const sessions = [
          merged("parent", "2024-01-01 09:00:00"),
          merged("other", "2024-01-02 09:00:00"),
          { ...active("child"), parentSessionId: "parent", userArchived: true },
        ];
        const visible = filterVisibleInSidebar(sessions, 1).map((s) => s.id).sort();
        expect(visible).toEqual(["other"]);
      });

      it("does not pin a child open once its parent is gone", () => {
        // Parent is user-archived (cascade would normally take the child too, but
        // if the child outlives it the cap should reclaim it normally).
        const sessions = [
          { ...merged("parent", "2024-01-03 09:00:00"), userArchived: true },
          merged("other", "2024-01-02 09:00:00"),
          { ...merged("child", "2024-01-01 09:00:00"), parentSessionId: "parent" },
        ];
        // Cap of 2: ranking incl. archived is parent, other, child → top-2 holds
        // parent (hidden, archived) + other. child falls past the cap and is no
        // longer pinned because its parent isn't live.
        const visible = filterVisibleInSidebar(sessions, 2).map((s) => s.id).sort();
        expect(visible).toEqual(["other"]);
      });
    });
  });

  // docs/161 — exercises the full visibility path through SessionManager.list()
  // (the SQL `user_archived = 0 AND warm = 0` filter + fromRow + the
  // filterVisibleInSidebar derivation), not just the predicate in isolation.
  describe("docs/161: a reopened merged session reappears in list()", () => {
    const repo = "https://github.com/o/r.git";

    /** Insert a merged session beyond the view cap via direct DB writes so the
     *  merged_at / last_used_at timestamps are deterministic (no same-second
     *  flakiness from datetime('now') vs toISOString()). */
    function seedMerged(mgr: SessionManager, id: string, mergedAt: string, lastUsedAt: string) {
      mgr.track(id, id);
      mgr.setRemoteUrl(id, repo);
      // merged_at is stored in SQLite datetime() format; last_used_at in ISO —
      // exactly the format mismatch reopenedAfterMerge normalizes with Date.parse.
      dbManager.db
        .prepare("UPDATE sessions SET merged_at = ?, last_used_at = ? WHERE id = ?")
        .run(mergedAt, lastUsedAt, id);
    }

    it("excludes an old merged session beyond the cap, then includes it once its branch advances", () => {
      const mgr = new SessionManager(dbManager);
      // 4 merged sessions in one repo, cap is 3. `target` has the oldest merge.
      seedMerged(mgr, "target", "2024-01-01 09:00:00", "2024-01-01 09:00:00");
      seedMerged(mgr, "m2", "2024-01-02 09:00:00", "2024-01-02 09:00:00");
      seedMerged(mgr, "m3", "2024-01-03 09:00:00", "2024-01-03 09:00:00");
      seedMerged(mgr, "m4", "2024-01-04 09:00:00", "2024-01-04 09:00:00");

      // Before reopening: target is beyond the top-N merged cap → not listed.
      expect(mgr.list().map((s) => s.id)).not.toContain("target");

      // docs/161 — a NO-OP turn (answering a question / spawning a child) bumps
      // last_used_at without committing. That must NOT reopen the session.
      dbManager.db
        .prepare("UPDATE sessions SET last_used_at = ? WHERE id = ?")
        .run("2024-06-01T00:00:00.000Z", "target");
      expect(mgr.list().map((s) => s.id)).not.toContain("target");

      // A turn that advances the branch (markBranchAdvanced) is a genuine reopen.
      dbManager.db
        .prepare("UPDATE sessions SET last_branch_commit_at = ? WHERE id = ?")
        .run("2024-06-02 00:00:00", "target");
      expect(mgr.list().map((s) => s.id)).toContain("target");
    });

    it("archiving a visible merged session lowers the count without surfacing a demoted one", () => {
      const mgr = new SessionManager(dbManager);
      // 4 merged in one repo, default cap is 3. m1 has the oldest merge → demoted.
      seedMerged(mgr, "m1", "2024-01-01 09:00:00", "2024-01-01 09:00:00");
      seedMerged(mgr, "m2", "2024-01-02 09:00:00", "2024-01-02 09:00:00");
      seedMerged(mgr, "m3", "2024-01-03 09:00:00", "2024-01-03 09:00:00");
      seedMerged(mgr, "m4", "2024-01-04 09:00:00", "2024-01-04 09:00:00");
      expect(mgr.list().map((s) => s.id).sort()).toEqual(["m2", "m3", "m4"]);

      // Archive a visible one → count drops to 2; m1 stays demoted (not promoted).
      mgr.archive("m3");
      expect(mgr.list().map((s) => s.id).sort()).toEqual(["m2", "m4"]);
    });
  });
});
