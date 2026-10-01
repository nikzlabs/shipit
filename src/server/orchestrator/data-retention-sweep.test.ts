import { describe, it, expect, afterEach, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { DatabaseManager } from "../shared/database.js";
import type { DataRetentionConfig } from "../shared/session-retention.js";
import { SessionManager } from "./sessions.js";
import { ChatHistoryManager, type PersistedMessage } from "./chat-history.js";
import { sweepRetainedSessionData, type DataRetentionSweepDeps } from "./data-retention-sweep.js";

const NOW = Date.parse("2026-10-01T00:00:00.000Z");
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();
const KB = 1024;
// Small enough that a test file crosses it, so the two periods are both reachable.
const CONFIG: DataRetentionConfig = { days: 60, largeDays: 14, largeBytes: 512 * KB };

describe("sweepRetainedSessionData", () => {
  let tmpDir: string;
  let dbManager: DatabaseManager;
  let sessionManager: SessionManager;
  let notices: { sessionId: string; message: PersistedMessage }[];
  let live: Set<string>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "data-retention-"));
    dbManager = new DatabaseManager(path.join(tmpDir, "test.db"));
    sessionManager = new SessionManager(dbManager, { dataRetention: CONFIG });
    notices = [];
    live = new Set();
  });

  afterEach(() => {
    dbManager.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  interface Seed {
    id: string;
    archivedAt?: string;
    lastUsedAt?: string;
    lastViewedAt?: string;
    mergedAt?: string;
    pinnedAt?: string;
    kind?: "sandbox";
    remoteUrl?: string | null;
    floorAt?: string;
    persistBytes?: number;
    uploadBytes?: number;
    flatLayout?: boolean;
    diskTier?: "hot" | "light" | "evicted";
    closedAt?: string;
    /** A size from an earlier measurement, which the files no longer have. */
    storedBytes?: number;
  }

  function seed(row: Seed): { root: string; workspace: string; persist: string; uploads: string } {
    const root = path.join(tmpDir, "sessions", row.id);
    const workspace = row.flatLayout ? root : path.join(root, "workspace");
    const persist = path.join(root, "scratch");
    const uploads = path.join(root, "uploads");
    for (const dir of [workspace, persist, uploads]) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(workspace, "code.txt"), "work");
    if (row.persistBytes) {
      fs.mkdirSync(path.join(persist, "nested"), { recursive: true });
      fs.writeFileSync(path.join(persist, "nested", "artifact.bin"), Buffer.alloc(row.persistBytes, 1));
    }
    if (row.uploadBytes) fs.writeFileSync(path.join(uploads, "photo.png"), Buffer.alloc(row.uploadBytes, 1));
    dbManager.db.prepare(
      `INSERT INTO sessions
         (id, title, created_at, last_used_at, last_viewed_at, workspace_dir, remote_url, kind,
          merged_at, pinned_at, user_archived, archived_at, retention_floor_at, disk_tier,
          closed_at, retained_data_bytes, retained_data_measured_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.id,
      row.id,
      daysAgo(400),
      row.lastUsedAt ?? daysAgo(300),
      row.lastViewedAt ?? null,
      workspace,
      row.remoteUrl === undefined ? "https://github.com/example/repo.git" : row.remoteUrl,
      row.kind ?? null,
      row.mergedAt ?? null,
      row.pinnedAt ?? null,
      row.archivedAt ? 1 : 0,
      row.archivedAt ?? null,
      row.floorAt ?? null,
      row.diskTier ?? (row.archivedAt ? "evicted" : "hot"),
      row.closedAt ?? null,
      row.storedBytes ?? null,
      row.storedBytes === undefined ? null : new Date(NOW).toISOString(),
    );
    return { root, workspace, persist, uploads };
  }

  function deps(now = NOW): DataRetentionSweepDeps {
    return {
      sessionManager,
      chatHistory: { append: (sessionId, message) => { notices.push({ sessionId, message }); } },
      sessionsRoot: path.join(tmpDir, "sessions"),
      isSessionLive: (id) => live.has(id),
      now: () => now,
    };
  }

  const listed = (id: string) => sessionManager.listAll().find((s) => s.id === id)!;

  it("measures an archived session and puts the deletion date on the list (req 7)", async () => {
    seed({ id: "a", archivedAt: daysAgo(10), persistBytes: 8 * KB, uploadBytes: 8 * KB });

    const result = await sweepRetainedSessionData(deps());

    expect(result).toMatchObject({ measured: 1, sessionsDeleted: 0 });
    expect(listed("a").retainedDataBytes).toBeGreaterThanOrEqual(16 * KB);
    expect(listed("a").dataDeletesAt).toBe(daysAgo(10 - 60));
  });

  it("measures a session once", async () => {
    seed({ id: "a", archivedAt: daysAgo(10), persistBytes: 8 * KB });

    await sweepRetainedSessionData(deps());
    const second = await sweepRetainedSessionData(deps());

    expect(second.measured).toBe(0);
  });

  it("keeps the files until the period ends, then deletes them (req 1, req 3)", async () => {
    const dirs = seed({ id: "a", archivedAt: daysAgo(59), persistBytes: 8 * KB, uploadBytes: 8 * KB });

    await sweepRetainedSessionData(deps());
    expect(fs.existsSync(path.join(dirs.persist, "nested", "artifact.bin"))).toBe(true);
    expect(notices).toEqual([]);

    const result = await sweepRetainedSessionData(deps(NOW + 2 * 86_400_000));

    expect(result.sessionsDeleted).toBe(1);
    expect(fs.readdirSync(dirs.persist)).toEqual([]);
    expect(fs.readdirSync(dirs.uploads)).toEqual([]);
    expect(fs.readFileSync(path.join(dirs.workspace, "code.txt"), "utf8")).toBe("work");
    expect(listed("a").retainedDataBytes).toBe(0);
    expect(listed("a").dataDeletesAt).toBeUndefined();
  });

  it("deletes a large session after the short period (req 13)", async () => {
    const large = seed({ id: "large", archivedAt: daysAgo(15), persistBytes: 600 * KB });
    const small = seed({ id: "small", archivedAt: daysAgo(15), persistBytes: 8 * KB });

    await sweepRetainedSessionData(deps());

    expect(fs.readdirSync(large.persist)).toEqual([]);
    expect(fs.readdirSync(small.persist)).toEqual(["nested"]);
  });

  it("writes the notice and tells the agent once (req 9)", async () => {
    seed({ id: "a", archivedAt: daysAgo(61), persistBytes: 8 * KB, uploadBytes: 8 * KB });

    await sweepRetainedSessionData(deps());
    await sweepRetainedSessionData(deps());

    expect(notices).toHaveLength(1);
    expect(notices[0].sessionId).toBe("a");
    expect(notices[0].message).toMatchObject({ role: "assistant", notice: true });
    expect(notices[0].message.text).toContain("`/persist` files and uploads on 2026-10-01");
    expect(notices[0].message.text).toContain("archived for 60 days");
    expect(sessionManager.get("a")?.pendingAgentNotice).toContain("/persist");
  });

  it("names only what it deleted", async () => {
    seed({ id: "a", archivedAt: daysAgo(61), uploadBytes: 8 * KB });

    await sweepRetainedSessionData(deps());

    expect(notices[0].message.text).toContain("this session's uploads on");
    expect(notices[0].message.text).not.toContain("/persist");
  });

  it("writes no notice for a session that has no files", async () => {
    seed({ id: "a", archivedAt: daysAgo(100) });

    const result = await sweepRetainedSessionData(deps());

    expect(result.sessionsDeleted).toBe(0);
    expect(notices).toEqual([]);
    expect(listed("a").dataDeletesAt).toBeUndefined();
  });

  it("does not touch a session that is not archived and not done (req 2)", async () => {
    const dirs = seed({ id: "a", lastUsedAt: daysAgo(300), persistBytes: 8 * KB });

    const result = await sweepRetainedSessionData(deps());

    expect(result.measured).toBe(0);
    expect(fs.readdirSync(dirs.persist)).toEqual(["nested"]);
  });

  it("deletes the files of a done session after the period (req 11, req 12)", async () => {
    const done = seed({ id: "done", mergedAt: daysAgo(61), lastUsedAt: daysAgo(70), persistBytes: 8 * KB });
    const recent = seed({ id: "recent", mergedAt: daysAgo(20), lastUsedAt: daysAgo(70), persistBytes: 8 * KB });

    await sweepRetainedSessionData(deps());

    expect(fs.readdirSync(done.persist)).toEqual([]);
    expect(notices.map((n) => n.sessionId)).toEqual(["done"]);
    expect(notices[0].message.text).toContain("finished and not used for 60 days");
    expect(fs.readdirSync(recent.persist)).toEqual(["nested"]);
    expect(listed("recent").dataDeletesAt).toBe(daysAgo(20 - 60));
  });

  it("starts a new period when the user opens a done session", async () => {
    const dirs = seed({
      id: "a", mergedAt: daysAgo(90), lastUsedAt: daysAgo(100), lastViewedAt: daysAgo(3), persistBytes: 8 * KB,
    });

    await sweepRetainedSessionData(deps());

    expect(fs.readdirSync(dirs.persist)).toEqual(["nested"]);
    expect(listed("a").dataDeletesAt).toBe(daysAgo(3 - 60));
  });

  it("keeps the files of a pinned session, which is not done (req 11)", async () => {
    const dirs = seed({
      id: "a", mergedAt: daysAgo(90), lastUsedAt: daysAgo(100), pinnedAt: daysAgo(95), persistBytes: 8 * KB,
    });

    const result = await sweepRetainedSessionData(deps());

    expect(result.measured).toBe(0);
    expect(fs.readdirSync(dirs.persist)).toEqual(["nested"]);
  });

  it("starts no period before the floor of an older session (req 5, req 12)", async () => {
    const archived = seed({ id: "arch", archivedAt: daysAgo(5), floorAt: daysAgo(5), lastUsedAt: daysAgo(300), persistBytes: 8 * KB });
    const done = seed({ id: "done", mergedAt: daysAgo(200), lastUsedAt: daysAgo(210), floorAt: daysAgo(5), persistBytes: 8 * KB });

    await sweepRetainedSessionData(deps());

    expect(fs.readdirSync(archived.persist)).toEqual(["nested"]);
    expect(fs.readdirSync(done.persist)).toEqual(["nested"]);
    expect(listed("done").dataDeletesAt).toBe(daysAgo(5 - 60));
  });

  it("does not delete while the session is live", async () => {
    const dirs = seed({ id: "a", archivedAt: daysAgo(61), persistBytes: 8 * KB });
    live.add("a");

    await sweepRetainedSessionData(deps());
    expect(fs.readdirSync(dirs.persist)).toEqual(["nested"]);
    expect(notices).toEqual([]);

    live.clear();
    await sweepRetainedSessionData(deps());
    expect(fs.readdirSync(dirs.persist)).toEqual([]);
  });

  it("does not measure while the session is live, because its files can still change", async () => {
    seed({ id: "a", mergedAt: daysAgo(1), lastUsedAt: daysAgo(2), persistBytes: 8 * KB });
    live.add("a");

    expect((await sweepRetainedSessionData(deps())).measured).toBe(0);
    expect(listed("a").retainedDataBytes).toBeUndefined();

    live.clear();
    expect((await sweepRetainedSessionData(deps())).measured).toBe(1);
  });

  it("deletes the checkout of an archived sandbox session that has no remote (req 10)", async () => {
    const dirs = seed({ id: "a", archivedAt: daysAgo(61), kind: "sandbox", remoteUrl: null });

    await sweepRetainedSessionData(deps());

    expect(fs.existsSync(dirs.workspace)).toBe(false);
    expect(notices[0].message.text).toContain("this session's checkout on");
    expect(notices[0].message.text).toContain("the workspace is now empty");
    expect(sessionManager.get("a")?.pendingAgentNotice).toContain("/workspace");
  });

  it("keeps the checkout of an archived session that has a remote", async () => {
    const dirs = seed({ id: "a", archivedAt: daysAgo(61), kind: "sandbox", persistBytes: 8 * KB });

    await sweepRetainedSessionData(deps());

    expect(fs.readdirSync(dirs.persist)).toEqual([]);
    expect(fs.existsSync(path.join(dirs.workspace, "code.txt"))).toBe(true);
  });

  it("keeps the checkout of a sandbox session that is not archived", async () => {
    const dirs = seed({ id: "a", kind: "sandbox", remoteUrl: null, lastUsedAt: daysAgo(300) });

    await sweepRetainedSessionData(deps());

    expect(fs.existsSync(path.join(dirs.workspace, "code.txt"))).toBe(true);
  });

  it("does nothing for a session whose workspace is not at <session>/workspace", async () => {
    const dirs = seed({ id: "a", archivedAt: daysAgo(100), persistBytes: 8 * KB, flatLayout: true });

    const result = await sweepRetainedSessionData(deps());

    expect(result.measured).toBe(0);
    expect(fs.readdirSync(dirs.persist)).toEqual(["nested"]);
  });

  it("does nothing when the period is 0, also for a large session (req 6)", async () => {
    sessionManager = new SessionManager(dbManager, { dataRetention: { ...CONFIG, days: 0 } });
    const dirs = seed({ id: "a", archivedAt: daysAgo(400), persistBytes: 600 * KB });

    const result = await sweepRetainedSessionData(deps());

    expect(result.measured).toBe(0);
    expect(fs.readdirSync(dirs.persist)).toEqual(["nested"]);
  });

  it("does not touch a session whose checkout ShipIt reclaimed but which is not done (req 2)", async () => {
    const dirs = seed({ id: "a", lastUsedAt: daysAgo(300), diskTier: "evicted", persistBytes: 8 * KB });

    await sweepRetainedSessionData(deps());

    expect(fs.readdirSync(dirs.persist)).toEqual(["nested"]);
  });

  it("deletes the files of a done session whose pull request closed (req 11)", async () => {
    const dirs = seed({ id: "a", closedAt: daysAgo(61), lastUsedAt: daysAgo(70), persistBytes: 8 * KB });

    await sweepRetainedSessionData(deps());

    expect(fs.readdirSync(dirs.persist)).toEqual([]);
  });

  it("adds /persist and uploads to decide if a session is large (req 13)", async () => {
    const dirs = seed({ id: "a", archivedAt: daysAgo(15), persistBytes: 300 * KB, uploadBytes: 300 * KB });

    await sweepRetainedSessionData(deps());

    expect(fs.readdirSync(dirs.persist)).toEqual([]);
    expect(fs.readdirSync(dirs.uploads)).toEqual([]);
  });

  it("uses the size on disk, not an earlier one, to decide the period", async () => {
    const dirs = seed({ id: "a", archivedAt: daysAgo(20), persistBytes: 8 * KB, storedBytes: 600 * KB });

    await sweepRetainedSessionData(deps());

    expect(fs.readdirSync(dirs.persist)).toEqual(["nested"]);
    expect(listed("a").retainedDataBytes).toBeLessThan(CONFIG.largeBytes);
    expect(listed("a").dataDeletesAt).toBe(daysAgo(20 - 60));
  });

  it("deletes an empty file too", async () => {
    const dirs = seed({ id: "a", archivedAt: daysAgo(61) });
    fs.writeFileSync(path.join(dirs.persist, "empty.txt"), "");

    await sweepRetainedSessionData(deps());

    expect(fs.readdirSync(dirs.persist)).toEqual([]);
    expect(notices).toHaveLength(1);
  });

  it("does not delete when the session became live after the first check", async () => {
    const dirs = seed({ id: "a", archivedAt: daysAgo(61), persistBytes: 8 * KB });

    await sweepRetainedSessionData({
      ...deps(),
      stopComposeStack: async (id) => { live.add(id); },
    });

    expect(fs.readdirSync(dirs.persist)).toEqual(["nested"]);
    expect(notices).toEqual([]);
  });

  it("does not delete when the user restored the session during the pass", async () => {
    const dirs = seed({ id: "a", archivedAt: daysAgo(61), persistBytes: 8 * KB });

    await sweepRetainedSessionData({
      ...deps(),
      stopComposeStack: async (id) => { sessionManager.unarchive(id); },
    });

    expect(fs.readdirSync(dirs.persist)).toEqual(["nested"]);
  });

  it("does not delete when the Compose stack cannot be stopped", async () => {
    const dirs = seed({ id: "a", archivedAt: daysAgo(61), persistBytes: 8 * KB });

    await sweepRetainedSessionData({
      ...deps(),
      stopComposeStack: async () => { throw new Error("docker is not reachable"); },
    });

    expect(fs.readdirSync(dirs.persist)).toEqual(["nested"]);
    expect(notices).toEqual([]);
  });

  it("does nothing for a workspace named 'workspace' that is not in the session's own directory", async () => {
    const dirs = seed({ id: "a", archivedAt: daysAgo(100), persistBytes: 8 * KB });
    const elsewhere = path.join(tmpDir, "other", "workspace");
    fs.mkdirSync(path.join(tmpDir, "other", "scratch"), { recursive: true });
    fs.mkdirSync(elsewhere, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "other", "scratch", "keep.txt"), "not this session's");
    dbManager.db.prepare("UPDATE sessions SET workspace_dir = ? WHERE id = 'a'").run(elsewhere);

    const result = await sweepRetainedSessionData(deps());

    expect(result.measured).toBe(0);
    expect(fs.existsSync(path.join(tmpDir, "other", "scratch", "keep.txt"))).toBe(true);
    expect(fs.readdirSync(dirs.persist)).toEqual(["nested"]);
  });

  it("does not follow a symlink that replaced the /persist directory", async () => {
    const dirs = seed({ id: "a", archivedAt: daysAgo(100) });
    const outside = path.join(tmpDir, "outside");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "keep.txt"), "x".repeat(8 * KB));
    fs.rmdirSync(dirs.persist);
    fs.symlinkSync(outside, dirs.persist);

    await sweepRetainedSessionData(deps());

    expect(fs.readdirSync(outside)).toEqual(["keep.txt"]);
    expect(notices).toEqual([]);
  });

  // Root ignores directory permissions, so this failure cannot be made as root.
  it.skipIf(process.getuid?.() === 0)("reports what it deleted when a part fails, and the rest later", async () => {
    const dirs = seed({ id: "a", archivedAt: daysAgo(61), persistBytes: 8 * KB, uploadBytes: 8 * KB });
    fs.chmodSync(dirs.uploads, 0o555);
    try {
      await sweepRetainedSessionData(deps());
    } finally {
      fs.chmodSync(dirs.uploads, 0o755);
    }

    expect(fs.readdirSync(dirs.persist)).toEqual([]);
    expect(fs.readdirSync(dirs.uploads)).toEqual(["photo.png"]);
    expect(notices).toHaveLength(1);
    expect(notices[0].message.text).toContain("this session's `/persist` files on");
    expect(listed("a").retainedDataBytes).toBeGreaterThan(0);

    await sweepRetainedSessionData(deps());

    expect(fs.readdirSync(dirs.uploads)).toEqual([]);
    expect(notices).toHaveLength(2);
    expect(notices[1].message.text).toContain("this session's uploads on");
  });

  it("still tells the agent when the transcript notice cannot be written", async () => {
    seed({ id: "a", archivedAt: daysAgo(61), persistBytes: 8 * KB });

    await sweepRetainedSessionData({
      ...deps(),
      chatHistory: { append: () => { throw new Error("database is locked"); } },
    });

    expect(sessionManager.get("a")?.pendingAgentNotice).toContain("/persist");
  });

  it("puts the notice in the history that a restored session loads (req 9)", async () => {
    seed({ id: "a", archivedAt: daysAgo(61), persistBytes: 8 * KB });
    const chatHistory = new ChatHistoryManager(dbManager);

    await sweepRetainedSessionData({ ...deps(), chatHistory });

    const history = chatHistory.load("a");
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ role: "assistant", notice: true });
    expect(history[0].text).toContain("ShipIt deleted this session's `/persist` files");
  });

  it("starts a new period when the user restores the session and archives it again (req 4)", async () => {
    const dirs = seed({ id: "a", archivedAt: daysAgo(59), persistBytes: 8 * KB });
    await sweepRetainedSessionData(deps());
    expect(listed("a").dataDeletesAt).toBe(daysAgo(59 - 60));

    sessionManager.unarchive("a");
    sessionManager.archive("a");
    const archivedAgain = Date.parse(sessionManager.get("a")!.archivedAt!);
    await sweepRetainedSessionData(deps(archivedAgain + 59 * 86_400_000));

    expect(fs.readdirSync(dirs.persist)).toEqual(["nested"]);
    expect(Date.parse(listed("a").dataDeletesAt!)).toBe(archivedAgain + 60 * 86_400_000);
  });

  it("tells the caller when a list changed", async () => {
    seed({ id: "a", archivedAt: daysAgo(10), persistBytes: 8 * KB });
    let changed = 0;

    await sweepRetainedSessionData({ ...deps(), onSessionsChanged: () => { changed += 1; } });
    await sweepRetainedSessionData({ ...deps(), onSessionsChanged: () => { changed += 1; } });

    expect(changed).toBe(1);
  });
});

describe("the archive time (req 4)", () => {
  let dbManager: DatabaseManager;
  let sessionManager: SessionManager;

  beforeEach(() => {
    dbManager = new DatabaseManager(":memory:");
    sessionManager = new SessionManager(dbManager);
    sessionManager.track("a", "a", "/sessions/a/workspace");
  });

  afterEach(() => dbManager.close());

  it("is set by archive and cleared by unarchive", () => {
    const before = Date.now();
    sessionManager.archive("a");
    const archivedAt = Date.parse(sessionManager.get("a")!.archivedAt!);
    expect(archivedAt).toBeGreaterThanOrEqual(before);

    sessionManager.unarchive("a");
    expect(sessionManager.get("a")!.archivedAt).toBeUndefined();
  });

  it("a new archive drops the size of the earlier one", () => {
    sessionManager.archive("a");
    sessionManager.setRetainedData("a", 1234, new Date().toISOString());
    sessionManager.unarchive("a");
    sessionManager.archive("a");

    expect(sessionManager.get("a")!.retainedDataBytes).toBeUndefined();
  });
});
