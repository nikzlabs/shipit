import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import simpleGit from "simple-git";
import Database from "better-sqlite3";
import { DatabaseManager } from "../shared/database.js";
import { GitManager } from "../shared/git.js";
import { SessionManager, DEFAULT_DISK_LADDER, assertDiskLadderOrdering } from "./sessions.js";
import { escalateDiskTiers, type TierEscalationDeps } from "./tier-escalation.js";
import { resolveDiskWatermarks } from "./disk-utils.js";
import type { SessionRunnerRegistry } from "./session-runner.js";

// docs/161 Part 2 — disk-tier escalation ladder.
describe("escalateDiskTiers", () => {
  let tmpDir: string;
  let dbManager: DatabaseManager | null = null;
  let underlyingDb: Database.Database | null = null;

  function setup() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "disk-tier-"));
    dbManager = new DatabaseManager(path.join(tmpDir, "test.db"));
    underlyingDb = dbManager.db;
  }

  afterEach(() => {
    dbManager?.close();
    dbManager = null;
    underlyingDb = null;
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const NOW = Date.parse("2026-05-31T00:00:00.000Z");
  const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();
  const hoursAgo = (n: number) => new Date(NOW - n * 3_600_000).toISOString();

  function insertSession(row: {
    id: string;
    lastUsedAt: string;
    diskTier?: "hot" | "light" | "evicted";
    workspaceDir?: string;
    remoteUrl?: string;
    branch?: string;
    lastViewedAt?: string;
    mergedAt?: string;
  }) {
    underlyingDb!.prepare(
      `INSERT INTO sessions
         (id, title, created_at, last_used_at, last_viewed_at, workspace_dir, remote_url, branch, disk_tier, merged_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.id,
      row.id,
      row.lastUsedAt,
      row.lastUsedAt,
      row.lastViewedAt ?? null,
      row.workspaceDir ?? null,
      row.remoteUrl ?? "https://github.com/example/repo.git",
      row.branch ?? "shipit/feature",
      row.diskTier ?? "hot",
      row.mergedAt ?? null,
    );
  }

  /**
   * Minimal runner-registry fake: only `get` / `dispose` are exercised.
   *
   * `dispose` models the real runner's refusal, not just the call: both runner
   * classes DECLINE a non-forced dispose while they hold live work (a running
   * agent, an in-flight consult, a turn's post-turn sequence), and the ladder
   * has to honor that — it destroys the container and, at `evict`, wipes the
   * checkout. A fake that always disposed made the caller's decision
   * untestable.
   */
  function fakeRegistry(
    runners: Record<string, {
      running?: boolean;
      viewerCount?: number;
      /** docs/235 — outstanding agent-initiated background tasks. */
      backgroundTaskCount?: number;
      /** A turn's terminal sequence (commit / PR flow / settlement) is running. */
      postTurnWorkInFlight?: boolean;
    }> = {},
  ): { registry: SessionRunnerRegistry; disposed: string[] } {
    const disposed: string[] = [];
    const state = new Map<string, { disposed: boolean }>();
    const registry = {
      get: (id: string) => {
        const r = runners[id];
        if (!r) return undefined;
        const running = r.running ?? false;
        const backgroundTaskCount = r.backgroundTaskCount ?? 0;
        const postTurnWorkInFlight = r.postTurnWorkInFlight ?? false;
        let slot = state.get(id);
        if (!slot) { slot = { disposed: false }; state.set(id, slot); }
        return {
          running,
          viewerCount: r.viewerCount ?? 0,
          backgroundTaskCount,
          postTurnWorkInFlight,
          // Mirrors the real runner's derivation so the guard under test sees
          // the same union the production code does.
          agentBusy: running || backgroundTaskCount > 0 || postTurnWorkInFlight,
          get disposed() { return slot.disposed; },
        };
      },
      dispose: (id: string) => {
        disposed.push(id);
        const r = runners[id];
        if (!r) return;
        let slot = state.get(id);
        if (!slot) { slot = { disposed: false }; state.set(id, slot); }
        // Non-forced: the real runner refuses while it holds live work.
        if (r.running || r.postTurnWorkInFlight) return;
        slot.disposed = true;
      },
    } as unknown as SessionRunnerRegistry;
    return { registry, disposed };
  }

  const stubContainerManager = { destroy: () => Promise.resolve() };

  function baseDeps(sm: SessionManager, registry: SessionRunnerRegistry): TierEscalationDeps {
    return {
      sessionManager: sm,
      runnerRegistry: registry,
      serviceManagers: new Map(),
      containerManager: stubContainerManager,
      pruneVolumes: () => Promise.resolve(),
      now: () => NOW,
    };
  }

  /**
   * A session checkout on `main`. planning#296 — pushed to a bare `origin` by
   * default, because eviction now requires the tip to be recoverable from the
   * remote; `noRemote` produces the un-evictable "this checkout is the only
   * copy" shape.
   */
  async function initRepo(dir: string, opts: { dirty?: boolean; noRemote?: boolean } = {}) {
    fs.mkdirSync(dir, { recursive: true });
    const g = simpleGit(dir);
    await g.init(["--initial-branch=main"]);
    await g.addConfig("user.email", "test@example.com");
    await g.addConfig("user.name", "Test");
    fs.writeFileSync(path.join(dir, "a.txt"), "hello");
    await g.add(".");
    await g.commit("init");
    if (!opts.noRemote) {
      const remoteDir = `${dir}-remote.git`;
      await simpleGit().init(["--bare", "--initial-branch=main", remoteDir]);
      await g.addRemote("origin", remoteDir);
      await g.push("origin", "main", ["--set-upstream"]);
    }
    if (opts.dirty) fs.writeFileSync(path.join(dir, "b.txt"), "uncommitted");
  }

  it("escalates hot → light after IDLE_LIGHT, preserving the checkout", async () => {
    setup();
    const sm = new SessionManager(dbManager!);
    const wsDir = path.join(tmpDir, "ws-old");
    fs.mkdirSync(wsDir, { recursive: true });
    fs.writeFileSync(path.join(wsDir, "keep.txt"), "x");
    insertSession({
      id: "old-hot",
      lastUsedAt: daysAgo(DEFAULT_DISK_LADDER.lightAfterMs / 86_400_000 + 1),
      diskTier: "hot",
      workspaceDir: wsDir,
    });

    const { registry, disposed } = fakeRegistry();
    const result = await escalateDiskTiers(baseDeps(sm, registry));

    expect(result.toLight).toBe(1);
    expect(result.toEvicted).toBe(0);
    expect(sm.get("old-hot")?.diskTier).toBe("light");
    expect(disposed).toContain("old-hot");
    // light NEVER wipes the checkout.
    expect(fs.existsSync(path.join(wsDir, "keep.txt"))).toBe(true);
  });

  // docs/235 — `hot → light` destroys the container. A session whose agent is
  // waiting on (or was woken by) background work has `running === false`, so
  // the old `running`-only guard would tear it down mid-work.
  it("docs/235: never descends a session holding outstanding background tasks", async () => {
    setup();
    const sm = new SessionManager(dbManager!);
    const wsDir = path.join(tmpDir, "ws-bg");
    fs.mkdirSync(wsDir, { recursive: true });
    insertSession({
      id: "bg-old",
      lastUsedAt: daysAgo(DEFAULT_DISK_LADDER.lightAfterMs / 86_400_000 + 1),
      diskTier: "hot",
      workspaceDir: wsDir,
    });

    const { registry, disposed } = fakeRegistry({
      "bg-old": { running: false, backgroundTaskCount: 1 },
    });
    const result = await escalateDiskTiers(baseDeps(sm, registry));

    expect(result.toLight).toBe(0);
    expect(sm.get("bg-old")?.diskTier).toBe("hot");
    expect(disposed).not.toContain("bg-old");
  });

  it("docs/110: NEVER descends a pinned session, even when ancient and idle", async () => {
    setup();
    const sm = new SessionManager(dbManager!);
    const wsDir = path.join(tmpDir, "ws-pinned");
    fs.mkdirSync(wsDir, { recursive: true });
    fs.writeFileSync(path.join(wsDir, "keep.txt"), "x");
    // Old enough to be evicted on the gentle clock, let alone demoted to light.
    insertSession({
      id: "pinned-old",
      lastUsedAt: daysAgo(DEFAULT_DISK_LADDER.evictUnmergedAfterMs / 86_400_000 + 5),
      diskTier: "hot",
      workspaceDir: wsDir,
    });
    sm.setPinned("pinned-old", "2026-05-01T00:00:00.000Z");

    const { registry, disposed } = fakeRegistry();
    const result = await escalateDiskTiers(baseDeps(sm, registry));

    // The pin is the only thing protecting it: no descent, tier unchanged.
    expect(result.toLight).toBe(0);
    expect(result.toEvicted).toBe(0);
    expect(sm.get("pinned-old")?.diskTier).toBe("hot");
    expect(disposed).not.toContain("pinned-old");
    expect(fs.existsSync(path.join(wsDir, "keep.txt"))).toBe(true);

    // Control: unpinning the same session lets it descend (proves the guard,
    // not some other condition, is what kept it resident).
    sm.setPinned("pinned-old", null);
    const after = await escalateDiskTiers(baseDeps(sm, registry));
    expect(after.toLight + after.toEvicted).toBeGreaterThan(0);
    expect(sm.get("pinned-old")?.diskTier).not.toBe("hot");
  });

  // docs/256 — the reaper asymmetry. `idle-enforcer.ts` has always skipped a
  // reserved always-on preview; this ladder did not, so the `hot → light` rung
  // destroyed the very container docs/241 promises to keep up (and the
  // keep-preview restart supervisor then recreated it — a fight, not a
  // one-shot).
  it("docs/241: NEVER descends a session with an always-on preview reservation", async () => {
    setup();
    const sm = new SessionManager(dbManager!);
    const wsDir = path.join(tmpDir, "ws-reserved");
    fs.mkdirSync(wsDir, { recursive: true });
    fs.writeFileSync(path.join(wsDir, "keep.txt"), "x");
    // Old enough for the gentle eviction clock, let alone `hot → light`. A
    // reserved preview that nobody views and no turn touches is the normal
    // shape here: it is serving HTTP, which the idle age never sees.
    insertSession({
      id: "reserved-old",
      lastUsedAt: daysAgo(DEFAULT_DISK_LADDER.evictUnmergedAfterMs / 86_400_000 + 5),
      diskTier: "hot",
      workspaceDir: wsDir,
    });
    sm.setKeepPreviewRunning("reserved-old", true);

    const { registry, disposed } = fakeRegistry();
    const result = await escalateDiskTiers(baseDeps(sm, registry));

    expect(result.toLight).toBe(0);
    expect(result.toEvicted).toBe(0);
    expect(sm.get("reserved-old")?.diskTier).toBe("hot");
    expect(disposed).not.toContain("reserved-old");
    expect(fs.existsSync(path.join(wsDir, "keep.txt"))).toBe(true);

    // Control: releasing the reservation lets the same session descend, which
    // proves the reservation — not some unrelated condition — held it.
    sm.setKeepPreviewRunning("reserved-old", false);
    const after = await escalateDiskTiers(baseDeps(sm, registry));
    expect(after.toLight + after.toEvicted).toBeGreaterThan(0);
    expect(sm.get("reserved-old")?.diskTier).not.toBe("hot");
  });

  // planning#298's rule, applied to this ladder: a DECLINED dispose means "leave
  // this container alone". `canAutoDescend` runs BEFORE `sleep(paceMs)` and
  // before the git/network work, so a session can pick up live work in between
  // — and the destroy was unconditional, so the work died anyway and the
  // surviving runner was left pointed at a dead container. A turn's post-turn
  // sequence (commit / PR flow / settlement) is now one of the things that
  // declines, and a turn ending during the pace delay lands exactly here.
  it("does not destroy the container when the runner declines disposal mid-pass", async () => {
    setup();
    const sm = new SessionManager(dbManager!);
    const wsDir = path.join(tmpDir, "ws-toctou");
    fs.mkdirSync(wsDir, { recursive: true });
    insertSession({
      id: "toctou",
      lastUsedAt: daysAgo(DEFAULT_DISK_LADDER.lightAfterMs / 86_400_000 + 1),
      diskTier: "hot",
      workspaceDir: wsDir,
    });

    // Idle when the guard looks; a turn's terminal sequence has started by the
    // time the rung actually disposes.
    let busy = false;
    const disposed: string[] = [];
    const registry = {
      get: () => ({
        running: false,
        viewerCount: 0,
        backgroundTaskCount: 0,
        get agentBusy() { const answer = busy; busy = true; return answer; },
        get disposed() { return false; }, // declined — still holds live work
      }),
      dispose: (id: string) => { disposed.push(id); },
    } as unknown as SessionRunnerRegistry;

    const destroyed: string[] = [];
    const result = await escalateDiskTiers({
      ...baseDeps(sm, registry),
      containerManager: { destroy: (id: string) => { destroyed.push(id); return Promise.resolve(); } },
    } as TierEscalationDeps);

    expect(disposed).toContain("toctou");
    // The whole point: dispose was attempted and refused, so the container
    // survives and the tier does not move. The next pass retries.
    expect(destroyed).toEqual([]);
    expect(result.toLight).toBe(0);
    expect(sm.get("toctou")?.diskTier).toBe("hot");
  });

  it("paces age-based descents when paceMs is set", async () => {
    setup();
    const sm = new SessionManager(dbManager!);
    const wsDir = path.join(tmpDir, "ws-pace");
    fs.mkdirSync(wsDir, { recursive: true });
    insertSession({
      id: "old-hot",
      lastUsedAt: daysAgo(DEFAULT_DISK_LADDER.lightAfterMs / 86_400_000 + 1),
      diskTier: "hot",
      workspaceDir: wsDir,
    });

    const { registry } = fakeRegistry();
    const paceMs = 30;
    const startedAt = Date.now();
    const result = await escalateDiskTiers({ ...baseDeps(sm, registry), paceMs });
    const elapsed = Date.now() - startedAt;

    expect(result.toLight).toBe(1);
    // One reclaim → one `sleep(paceMs)`. setTimeout never fires early, so this
    // lower bound (minus a tiny scheduling epsilon) is not flaky.
    expect(elapsed).toBeGreaterThanOrEqual(paceMs - 5);
  });

  it("does NOT escalate a hot session younger than IDLE_LIGHT", async () => {
    setup();
    const sm = new SessionManager(dbManager!);
    insertSession({ id: "fresh", lastUsedAt: hoursAgo(2), diskTier: "hot" });

    const { registry } = fakeRegistry();
    const result = await escalateDiskTiers(baseDeps(sm, registry));

    expect(result.toLight).toBe(0);
    expect(sm.get("fresh")?.diskTier).toBe("hot");
  });

  it("uses max(lastUsedAt, lastViewedAt) — a recent view keeps a session warm", async () => {
    setup();
    const sm = new SessionManager(dbManager!);
    insertSession({
      id: "viewed",
      lastUsedAt: daysAgo(30), // turn activity is ancient…
      lastViewedAt: hoursAgo(2), // …but it was opened 2h ago
      diskTier: "hot",
    });

    const { registry } = fakeRegistry();
    const result = await escalateDiskTiers(baseDeps(sm, registry));

    expect(result.toLight).toBe(0);
    expect(sm.get("viewed")?.diskTier).toBe("hot");
  });

  it("guards: never escalates a running session", async () => {
    setup();
    const sm = new SessionManager(dbManager!);
    insertSession({ id: "busy", lastUsedAt: daysAgo(99), diskTier: "hot" });

    const { registry } = fakeRegistry({ busy: { running: true } });
    const result = await escalateDiskTiers(baseDeps(sm, registry));

    expect(result.toLight).toBe(0);
    expect(sm.get("busy")?.diskTier).toBe("hot");
  });

  it("guards: never escalates a session with an attached viewer", async () => {
    setup();
    const sm = new SessionManager(dbManager!);
    insertSession({ id: "open", lastUsedAt: daysAgo(99), diskTier: "hot" });

    const { registry } = fakeRegistry({ open: { viewerCount: 1 } });
    const result = await escalateDiskTiers(baseDeps(sm, registry));

    expect(result.toLight).toBe(0);
    expect(sm.get("open")?.diskTier).toBe("hot");
  });

  it("excludes the just-started session", async () => {
    setup();
    const sm = new SessionManager(dbManager!);
    insertSession({ id: "just-started", lastUsedAt: daysAgo(99), diskTier: "hot" });

    const { registry } = fakeRegistry();
    const result = await escalateDiskTiers(baseDeps(sm, registry), "just-started");

    expect(result.toLight).toBe(0);
    expect(sm.get("just-started")?.diskTier).toBe("hot");
  });

  it("escalates light → evicted after IDLE_EVICT when the tree is clean", async () => {
    setup();
    const sm = new SessionManager(dbManager!);
    const wsDir = path.join(tmpDir, "ws-clean");
    await initRepo(wsDir);
    insertSession({
      id: "old-light",
      lastUsedAt: daysAgo(DEFAULT_DISK_LADDER.evictUnmergedAfterMs / 86_400_000 + 1),
      diskTier: "light",
      workspaceDir: wsDir,
      branch: "main",
    });

    const { registry } = fakeRegistry();
    const result = await escalateDiskTiers({
      ...baseDeps(sm, registry),
      createGitManager: (dir) => new GitManager(dir),
    });

    expect(result.toEvicted).toBe(1);
    expect(result.evictBlockedByPush).toBe(0);
    expect(sm.get("old-light")?.diskTier).toBe("evicted");
    expect(fs.existsSync(wsDir)).toBe(false);
  });

  // docs/217 — eviction must remove `workspace/` ONLY and spare the sibling
  // `scratch/` (mounted at /persist). Scratch is an only-copy with no git backup,
  // so an evicting reclaim path that took the session root with it would be
  // irreversible data loss. This pins the structural guarantee the design relies
  // on (scratch is a sibling of workspace, never inside it; nothing rm's the root).
  it("light → evicted wipes workspace/ but spares the sibling scratch/ (docs/217)", async () => {
    setup();
    const sm = new SessionManager(dbManager!);
    const sessionRoot = path.join(tmpDir, "sess-evict-scratch");
    const wsDir = path.join(sessionRoot, "workspace");
    await initRepo(wsDir);
    // The persistent scratch the agent's /persist files live in.
    const scratchFile = path.join(sessionRoot, "scratch", "kept.txt");
    fs.mkdirSync(path.dirname(scratchFile), { recursive: true });
    fs.writeFileSync(scratchFile, "survives eviction");
    insertSession({
      id: "evict-scratch",
      lastUsedAt: daysAgo(DEFAULT_DISK_LADDER.evictUnmergedAfterMs / 86_400_000 + 1),
      diskTier: "light",
      workspaceDir: wsDir,
      branch: "main",
    });

    const { registry } = fakeRegistry();
    const result = await escalateDiskTiers({
      ...baseDeps(sm, registry),
      createGitManager: (dir) => new GitManager(dir),
    });

    expect(result.toEvicted).toBe(1);
    expect(fs.existsSync(wsDir)).toBe(false); // workspace/ wiped
    expect(fs.existsSync(scratchFile)).toBe(true); // sibling scratch/ spared
  });

  // planning#194 — eviction must ALSO reclaim the regenerable `overlay/` upper sibling
  // (the docs/183 install-delta cache), which the legacy reclaim orphaned —
  // ~60 GB of leaked uppers on prod. `uploads/` stays durable.
  it("light → evicted wipes workspace/ AND overlay/ but spares uploads/ (planning#194)", async () => {
    setup();
    const sm = new SessionManager(dbManager!);
    const sessionRoot = path.join(tmpDir, "sess-evict-overlay");
    const wsDir = path.join(sessionRoot, "workspace");
    await initRepo(wsDir);
    const overlayUpper = path.join(sessionRoot, "overlay", "deadbeef", "upper", "dep");
    fs.mkdirSync(path.dirname(overlayUpper), { recursive: true });
    fs.writeFileSync(overlayUpper, "install delta");
    const uploadFile = path.join(sessionRoot, "uploads", "photo.png");
    fs.mkdirSync(path.dirname(uploadFile), { recursive: true });
    fs.writeFileSync(uploadFile, "user upload");
    insertSession({
      id: "evict-overlay",
      lastUsedAt: daysAgo(DEFAULT_DISK_LADDER.evictUnmergedAfterMs / 86_400_000 + 1),
      diskTier: "light",
      workspaceDir: wsDir,
      branch: "main",
    });

    const { registry } = fakeRegistry();
    const result = await escalateDiskTiers({
      ...baseDeps(sm, registry),
      createGitManager: (dir) => new GitManager(dir),
    });

    expect(result.toEvicted).toBe(1);
    expect(fs.existsSync(wsDir)).toBe(false); // workspace/ wiped
    expect(fs.existsSync(path.join(sessionRoot, "overlay"))).toBe(false); // overlay/ reclaimed
    expect(fs.existsSync(uploadFile)).toBe(true); // uploads/ spared
  });

  it("blocks light → evicted when a dirty tree can't be pushed (keeps at light)", async () => {
    setup();
    const sm = new SessionManager(dbManager!);
    const wsDir = path.join(tmpDir, "ws-dirty");
    await initRepo(wsDir, { dirty: true, noRemote: true }); // no `origin` → push fails
    insertSession({
      id: "dirty-light",
      lastUsedAt: daysAgo(DEFAULT_DISK_LADDER.evictUnmergedAfterMs / 86_400_000 + 1),
      diskTier: "light",
      workspaceDir: wsDir,
      branch: "main",
    });

    const { registry } = fakeRegistry();
    const result = await escalateDiskTiers({
      ...baseDeps(sm, registry),
      createGitManager: (dir) => new GitManager(dir),
    });

    expect(result.toEvicted).toBe(0);
    expect(result.evictBlockedByPush).toBe(1);
    // Stays at light, checkout preserved — the local commit survives on disk.
    expect(sm.get("dirty-light")?.diskTier).toBe("light");
    expect(fs.existsSync(wsDir)).toBe(true);
  });

  // ---------------------------------------------------------------------
  // planning#296 — `autoCommit` returns a null hash from THREE paths, and only one
  // of them ("nothing to commit") is safe to wipe. The other two are normal
  // returns, not throws, so they used to fall past the `if (commitHash)` gate
  // straight into the wipe — destroying uncommitted work with no reflog entry.
  // Each cause is pinned separately because the correct behaviour differs.
  // ---------------------------------------------------------------------

  /** Chat-history double: records the persisted rows the ladder appends. */
  function fakeChatHistory() {
    const appended: { sessionId: string; text: string }[] = [];
    return {
      appended,
      chatHistory: {
        append: (sessionId: string, message: { text?: string }) => {
          appended.push({ sessionId, text: message.text ?? "" });
        },
      },
    };
  }

  // The literal would trip ShipIt's own secret scanner on THIS file's
  // auto-commit (it isn't on the scanner's path allowlist), so the fixture
  // token is assembled at runtime. The scan reads the staged diff, where the
  // two halves never appear adjacent.
  const FIXTURE_AWS_KEY = ["AKIA", "IOSFODNN7EXAMPLE"].join("");

  // docs/128 / docs/211 — an ops/sandbox session is never evicted at all, which
  // is also what keeps the disk janitor's commit-before-eviction (its only
  // `autoCommit` call) from firing for them.
  //
  // The `pushed` case is the one that matters and the one a "they have no remote
  // so they were never evictable" reading gets WRONG: the durability gate reads
  // the CHECKOUT's `refs/remotes/origin/<branch>`, not `session.remoteUrl`. A
  // sandbox that ran `git clone <url> .`, or an ops agent that added an origin
  // by hand, satisfies it with a session row that has no `remoteUrl` — so the
  // wipe used to succeed and `restoreSessionWorkspace` would then throw 410,
  // because restore re-clones from session METADATA. That is unrecoverable
  // deletion, so the refusal has to be by kind, not inferred from the tree.
  for (const kind of ["ops", "sandbox"] as const) {
    for (const shape of ["dirty, no origin", "clean, pushed to an origin"] as const) {
      it(`never evicts a ${kind} session (${shape}) and makes no commit`, async () => {
        setup();
        const sm = new SessionManager(dbManager!);
        const clean = shape === "clean, pushed to an origin";
        const wsDir = path.join(tmpDir, `ws-${kind}-${clean ? "clean" : "dirty"}`);
        // `clean` mirrors an agent-created origin: the checkout has one and its
        // tip is pushed, while the session row below records NO remoteUrl.
        await initRepo(wsDir, { dirty: !clean, noRemote: !clean });
        insertSession({
          id: `${kind}-light`,
          lastUsedAt: daysAgo(DEFAULT_DISK_LADDER.evictUnmergedAfterMs / 86_400_000 + 1),
          diskTier: "light",
          workspaceDir: wsDir,
          branch: "main",
        });
        sm.setKind(`${kind}-light`, kind);

        const { registry } = fakeRegistry();
        const { appended, chatHistory } = fakeChatHistory();
        const before = (await new GitManager(wsDir).log()).length;
        const result = await escalateDiskTiers({
          ...baseDeps(sm, registry),
          createGitManager: (dir) => new GitManager(dir),
          chatHistory,
          notifiedEvictBlocked: new Set<string>(),
        });

        // Not evicted, and the checkout is still on disk.
        expect(result.toEvicted).toBe(0);
        expect(sm.get(`${kind}-light`)?.diskTier).toBe("light");
        expect(fs.existsSync(wsDir)).toBe(true);
        // No commit was made — history is exactly as the agent left it.
        expect((await new GitManager(wsDir).log()).length).toBe(before);
        expect(await new GitManager(wsDir).isClean()).toBe(clean);
        if (!clean) expect(fs.existsSync(path.join(wsDir, "b.txt"))).toBe(true);
        // Reason-less refusal ⇒ no user-facing notice: nothing was refused that
        // the user could act on, and no commit was attempted.
        expect(appended).toHaveLength(0);
      });
    }
  }

  // The refusal must not widen: an ordinary session with the SAME clean+pushed
  // shape is still evicted, which is the whole point of the ladder.
  it("still evicts an ordinary session with the same clean, pushed shape", async () => {
    setup();
    const sm = new SessionManager(dbManager!);
    const wsDir = path.join(tmpDir, "ws-ordinary-clean");
    await initRepo(wsDir);
    insertSession({
      id: "ordinary-light",
      lastUsedAt: daysAgo(DEFAULT_DISK_LADDER.evictUnmergedAfterMs / 86_400_000 + 1),
      diskTier: "light",
      workspaceDir: wsDir,
      branch: "main",
    });

    const { registry } = fakeRegistry();
    const result = await escalateDiskTiers({
      ...baseDeps(sm, registry),
      createGitManager: (dir) => new GitManager(dir),
    });

    expect(result.toEvicted).toBe(1);
    expect(sm.get("ordinary-light")?.diskTier).toBe("evicted");
    expect(fs.existsSync(wsDir)).toBe(false);
  });

  it("planning#296: a secret-refused auto-commit blocks the wipe (keeps the checkout)", async () => {
    setup();
    const sm = new SessionManager(dbManager!);
    const sessionRoot = path.join(tmpDir, "sess-secret");
    const wsDir = path.join(sessionRoot, "workspace");
    await initRepo(wsDir);
    // Uncommitted work, one file of which trips the docs/213 scanner. The
    // commit is refused WHOLESALE, so every uncommitted edit here is at stake.
    fs.writeFileSync(path.join(wsDir, "notes.md"), "a week of uncommitted work");
    fs.writeFileSync(path.join(wsDir, ".env"), `AWS_ACCESS_KEY_ID=${FIXTURE_AWS_KEY}\n`);
    // Regenerable install-delta cache (docs/183) + a durable upload sibling.
    const overlayUpper = path.join(sessionRoot, "overlay", "deadbeef", "upper", "dep");
    fs.mkdirSync(path.dirname(overlayUpper), { recursive: true });
    fs.writeFileSync(overlayUpper, "install delta");
    const uploadFile = path.join(sessionRoot, "uploads", "photo.png");
    fs.mkdirSync(path.dirname(uploadFile), { recursive: true });
    fs.writeFileSync(uploadFile, "user upload");
    insertSession({
      id: "secret-light",
      lastUsedAt: daysAgo(DEFAULT_DISK_LADDER.evictUnmergedAfterMs / 86_400_000 + 1),
      diskTier: "light",
      workspaceDir: wsDir,
      branch: "main",
    });

    const { registry } = fakeRegistry();
    const { appended, chatHistory } = fakeChatHistory();
    const result = await escalateDiskTiers({
      ...baseDeps(sm, registry),
      createGitManager: (dir) => new GitManager(dir),
      chatHistory,
      notifiedEvictBlocked: new Set<string>(),
    });

    expect(result.toEvicted).toBe(0);
    expect(result.evictBlockedByDirty).toBe(1);
    expect(result.evictBlockedByPush).toBe(0);
    expect(sm.get("secret-light")?.diskTier).toBe("light");
    // The unrecoverable half survives…
    expect(fs.existsSync(path.join(wsDir, "notes.md"))).toBe(true);
    expect(fs.existsSync(path.join(wsDir, ".env"))).toBe(true);
    expect(fs.existsSync(uploadFile)).toBe(true);
    // …and nothing was committed behind the scanner's back.
    const log = await simpleGit(wsDir).log();
    expect(log.all.length).toBe(1);
    // …while the regenerable half is still reclaimed, so a session that may
    // stay pinned for weeks doesn't hoard the expensive part of its disk.
    expect(fs.existsSync(path.join(sessionRoot, "overlay"))).toBe(false);
    // The user is told, in their own transcript, why cleanup stopped.
    expect(appended).toHaveLength(1);
    expect(appended[0]!.sessionId).toBe("secret-light");
    expect(appended[0]!.text).toContain("Disk cleanup paused");
    expect(appended[0]!.text).toContain("AWS access key ID"); // the secret cause, named
    expect(appended[0]!.text).toContain(".env");
    // Redacted, never the token body (the notice is persisted to the DB).
    expect(appended[0]!.text).not.toContain(FIXTURE_AWS_KEY);
  });

  it("planning#296: an unresolved merge state blocks the wipe (keeps the checkout)", async () => {
    setup();
    const sm = new SessionManager(dbManager!);
    const wsDir = path.join(tmpDir, "ws-conflict");
    await initRepo(wsDir);
    // A genuine conflicted merge — the state a user can least reconstruct.
    const g = simpleGit(wsDir);
    await g.checkoutLocalBranch("other");
    fs.writeFileSync(path.join(wsDir, "a.txt"), "theirs");
    await g.add(".");
    await g.commit("theirs");
    await g.checkout("main");
    fs.writeFileSync(path.join(wsDir, "a.txt"), "mine");
    await g.add(".");
    await g.commit("mine");
    await g.merge(["other"]).catch(() => { /* expected conflict */ });
    insertSession({
      id: "conflict-light",
      lastUsedAt: daysAgo(DEFAULT_DISK_LADDER.evictUnmergedAfterMs / 86_400_000 + 1),
      diskTier: "light",
      workspaceDir: wsDir,
      branch: "main",
    });

    const { registry } = fakeRegistry();
    const { appended, chatHistory } = fakeChatHistory();
    const result = await escalateDiskTiers({
      ...baseDeps(sm, registry),
      createGitManager: (dir) => new GitManager(dir),
      chatHistory,
      notifiedEvictBlocked: new Set<string>(),
    });

    expect(result.toEvicted).toBe(0);
    expect(result.evictBlockedByDirty).toBe(1);
    expect(sm.get("conflict-light")?.diskTier).toBe("light");
    expect(fs.existsSync(wsDir)).toBe(true);
    expect(appended[0]!.text).toContain("unresolved merge state");
  });

  it("planning#296: still evicts when the null hash meant 'nothing to commit'", async () => {
    setup();
    const sm = new SessionManager(dbManager!);
    const wsDir = path.join(tmpDir, "ws-race");
    await initRepo(wsDir);
    insertSession({
      id: "race-light",
      lastUsedAt: daysAgo(DEFAULT_DISK_LADDER.evictUnmergedAfterMs / 86_400_000 + 1),
      diskTier: "light",
      workspaceDir: wsDir,
      branch: "main",
    });

    // Dirty on the pre-check, clean by the time the commit is attempted (the
    // benign race). Nothing to preserve, so the wipe must still proceed —
    // a blanket "null hash ⇒ blocked" guard would make this un-evictable.
    let cleanCalls = 0;
    const stubGit = {
      isClean: () => Promise.resolve(cleanCalls++ > 0),
      autoCommit: () => Promise.resolve({
        commitHash: null, conflictedFiles: [], rebaseInProgress: false, secretFindings: [],
      }),
      isRebaseInProgress: () => Promise.resolve(false),
      isMergeOrSequencerInProgress: () => Promise.resolve(false),
      currentBranchOrNull: () => Promise.resolve("main"),
      getHeadHash: () => Promise.resolve("abc"),
      getRefHash: () => Promise.resolve("abc"), // tip already on origin
      isAncestor: () => Promise.resolve(true),
      push: () => Promise.resolve(""),
    } as unknown as GitManager;

    const { registry } = fakeRegistry();
    const { appended, chatHistory } = fakeChatHistory();
    const result = await escalateDiskTiers({
      ...baseDeps(sm, registry),
      createGitManager: () => stubGit,
      chatHistory,
      notifiedEvictBlocked: new Set<string>(),
    });

    expect(result.toEvicted).toBe(1);
    expect(result.evictBlockedByDirty).toBe(0);
    expect(sm.get("race-light")?.diskTier).toBe("evicted");
    expect(fs.existsSync(wsDir)).toBe(false);
    expect(appended).toHaveLength(0);
  });

  // The clean-tree question is not the durability question. A commit this pass
  // made but could not push leaves the tree CLEAN, so the next pass sailed
  // straight through the remediation block and wiped a commit that exists
  // nowhere else. Two passes is the whole point of this test.
  it("planning#296: a commit that failed to push is not wiped by the NEXT pass", async () => {
    setup();
    const sm = new SessionManager(dbManager!);
    const wsDir = path.join(tmpDir, "ws-unpushed");
    await initRepo(wsDir, { dirty: true, noRemote: true });
    insertSession({
      id: "unpushed-light",
      lastUsedAt: daysAgo(DEFAULT_DISK_LADDER.evictUnmergedAfterMs / 86_400_000 + 1),
      diskTier: "light",
      workspaceDir: wsDir,
      branch: "main",
    });

    const { registry } = fakeRegistry();
    const deps = { ...baseDeps(sm, registry), createGitManager: (dir: string) => new GitManager(dir) };

    const first = await escalateDiskTiers(deps);
    expect(first.evictBlockedByPush).toBe(1);
    // The auto-commit landed locally, so the tree is clean from here on.
    expect(await new GitManager(wsDir).isClean()).toBe(true);

    const second = await escalateDiskTiers(deps);

    expect(second.toEvicted).toBe(0);
    expect(second.evictBlockedByPush).toBe(1);
    expect(sm.get("unpushed-light")?.diskTier).toBe("light");
    expect(fs.existsSync(path.join(wsDir, "b.txt"))).toBe(true);
  });

  // A clean tree is not a quiet repo: an interactive rebase stopped at an
  // `edit`/`exec` step has nothing uncommitted, so `autoCommit` is never even
  // called and its conflict branch never fires — but the in-flight commits and
  // recovery state live only in `.git`.
  it("planning#296: a CLEAN checkout with a rebase in progress blocks the wipe", async () => {
    setup();
    const sm = new SessionManager(dbManager!);
    const wsDir = path.join(tmpDir, "ws-rebasing");
    await initRepo(wsDir);
    expect(await new GitManager(wsDir).isClean()).toBe(true);
    // The sentinel git writes for an in-progress interactive rebase.
    fs.mkdirSync(path.join(wsDir, ".git", "rebase-merge"), { recursive: true });
    insertSession({
      id: "rebasing-light",
      lastUsedAt: daysAgo(DEFAULT_DISK_LADDER.evictUnmergedAfterMs / 86_400_000 + 1),
      diskTier: "light",
      workspaceDir: wsDir,
      branch: "main",
    });

    const { registry } = fakeRegistry();
    const { appended, chatHistory } = fakeChatHistory();
    const result = await escalateDiskTiers({
      ...baseDeps(sm, registry),
      createGitManager: (dir) => new GitManager(dir),
      chatHistory,
      notifiedEvictBlocked: new Set<string>(),
    });

    expect(result.toEvicted).toBe(0);
    expect(result.evictBlockedByDirty).toBe(1);
    expect(fs.existsSync(wsDir)).toBe(true);
    expect(appended[0]!.text).toContain("rebase is in progress");
  });

  // A repo-less session's checkout is the only copy there will ever be —
  // `restoreSessionWorkspace` returns a terminal 410 for it. `archiveSession`
  // already refuses to reclaim one; the automatic ladder now matches.
  it("planning#296: never evicts a session whose work has no remote to live on", async () => {
    setup();
    const sm = new SessionManager(dbManager!);
    const wsDir = path.join(tmpDir, "ws-standalone");
    await initRepo(wsDir, { noRemote: true }); // clean, committed, nowhere else
    insertSession({
      id: "standalone-light",
      lastUsedAt: daysAgo(DEFAULT_DISK_LADDER.evictUnmergedAfterMs / 86_400_000 + 1),
      diskTier: "light",
      workspaceDir: wsDir,
      branch: "main",
    });

    const { registry } = fakeRegistry();
    const result = await escalateDiskTiers({
      ...baseDeps(sm, registry),
      createGitManager: (dir) => new GitManager(dir),
    });

    expect(result.toEvicted).toBe(0);
    expect(result.evictBlockedByPush).toBe(1);
    expect(fs.existsSync(path.join(wsDir, "a.txt"))).toBe(true);
  });

  // `GitManager.push` pushes the NAMED LOCAL BRANCH, not HEAD. On a detached
  // HEAD, pushing `session.branch` succeeds with "Everything up-to-date" while
  // HEAD's commits stay local — a green push that proves nothing, followed by
  // a wipe.
  it("planning#296: a detached HEAD is never evicted (its commits belong to no branch)", async () => {
    setup();
    const sm = new SessionManager(dbManager!);
    const wsDir = path.join(tmpDir, "ws-detached");
    await initRepo(wsDir); // main pushed to origin
    const g = simpleGit(wsDir);
    await g.checkout(["--detach"]);
    fs.writeFileSync(path.join(wsDir, "detached-work.txt"), "only on this commit");
    await g.add(".");
    await g.commit("work on a detached HEAD");
    expect(await new GitManager(wsDir).isClean()).toBe(true);
    insertSession({
      id: "detached-light",
      lastUsedAt: daysAgo(DEFAULT_DISK_LADDER.evictUnmergedAfterMs / 86_400_000 + 1),
      diskTier: "light",
      workspaceDir: wsDir,
      branch: "main", // the row still says main; the checkout disagrees
    });

    const { registry } = fakeRegistry();
    const result = await escalateDiskTiers({
      ...baseDeps(sm, registry),
      createGitManager: (dir) => new GitManager(dir),
    });

    expect(result.toEvicted).toBe(0);
    expect(result.evictBlockedByPush).toBe(1);
    expect(fs.existsSync(path.join(wsDir, "detached-work.txt"))).toBe(true);
  });

  // The descend guards run before the pacing delay and seconds of git/network
  // work. A session the user opened in that window must not be wiped.
  it("planning#296: does not wipe a session that became active during remediation", async () => {
    setup();
    const sm = new SessionManager(dbManager!);
    const wsDir = path.join(tmpDir, "ws-activated");
    await initRepo(wsDir);
    insertSession({
      id: "activated-light",
      lastUsedAt: daysAgo(DEFAULT_DISK_LADDER.evictUnmergedAfterMs / 86_400_000 + 1),
      diskTier: "light",
      workspaceDir: wsDir,
      branch: "main",
    });

    // A viewer attaches after the initial guard pass — the registry reports no
    // runner on the first lookup and an attached one from then on.
    let lookups = 0;
    const registry = {
      get: () => (lookups++ === 0
        ? undefined
        : { running: false, agentBusy: false, viewerCount: 1 }),
      dispose: () => {},
    } as unknown as SessionRunnerRegistry;

    const result = await escalateDiskTiers({
      ...baseDeps(sm, registry),
      createGitManager: (dir) => new GitManager(dir),
    });

    expect(result.toEvicted).toBe(0);
    expect(sm.get("activated-light")?.diskTier).toBe("light");
    expect(fs.existsSync(wsDir)).toBe(true);
  });

  // A `light` row whose checkout is already gone was pinned forever ("git check
  // failed" → skipped), and activation's `light → hot` shortcut skips
  // `restoreSessionWorkspace` — so the container bind-mount 404s in a loop.
  // Recording the truth routes the next activation through restore.
  it("planning#296: records an already-missing workspace as evicted (restorable), not stuck at light", async () => {
    setup();
    const sm = new SessionManager(dbManager!);
    const wsDir = path.join(tmpDir, "ws-vanished", "workspace");
    insertSession({
      id: "vanished-light",
      lastUsedAt: daysAgo(DEFAULT_DISK_LADDER.evictUnmergedAfterMs / 86_400_000 + 1),
      diskTier: "light",
      workspaceDir: wsDir, // never created
      branch: "main",
    });

    const { registry } = fakeRegistry();
    const result = await escalateDiskTiers({
      ...baseDeps(sm, registry),
      createGitManager: (dir) => new GitManager(dir),
    });

    expect(result.toEvicted).toBe(1);
    expect(sm.get("vanished-light")?.diskTier).toBe("evicted");
  });

  // The same stuck-forever shape as the vanished workspace above, but with the
  // DIRECTORY still present and only `.git` gone. `workspaceGone` was false, so
  // every pass reached the durability block, threw "fatal: not a git
  // repository", and returned "skipped" — no state change, no backoff. One
  // production session repeated that pair 117 times in an hour for eight days.
  // An EMPTY remnant is the missing-workspace case with a directory inode left
  // over: nothing to protect, so it is recorded evicted and restore re-clones.
  it("evicts an empty remnant directory that is no longer a git repository", async () => {
    setup();
    const sm = new SessionManager(dbManager!);
    const wsDir = path.join(tmpDir, "ws-remnant");
    fs.mkdirSync(wsDir, { recursive: true }); // an interrupted rm -rf leaves this
    insertSession({
      id: "remnant-light",
      lastUsedAt: daysAgo(DEFAULT_DISK_LADDER.evictUnmergedAfterMs / 86_400_000 + 1),
      diskTier: "light",
      workspaceDir: wsDir,
      branch: "main",
    });

    const { registry } = fakeRegistry();
    const result = await escalateDiskTiers({
      ...baseDeps(sm, registry),
      createGitManager: (dir) => new GitManager(dir),
    });

    expect(result.toEvicted).toBe(1);
    expect(sm.get("remnant-light")?.diskTier).toBe("evicted");
  });

  // The other half of the split, and the one that must NOT wipe. Files in a
  // directory with no repository exist nowhere else — there is no branch or
  // commit that could ever carry them to origin — so the rung that promises
  // "everything it wipes is recoverable from origin" cannot delete them. It
  // blocks instead: reclaim the regenerable overlay, notify, keep the files.
  it("never wipes a non-repo workspace that still holds files — it blocks instead", async () => {
    setup();
    const sm = new SessionManager(dbManager!);
    const sessionRoot = path.join(tmpDir, "ws-derepoed");
    const wsDir = path.join(sessionRoot, "workspace");
    await initRepo(wsDir);
    fs.rmSync(path.join(wsDir, ".git"), { recursive: true, force: true });
    fs.writeFileSync(path.join(wsDir, "only-copy.txt"), "never pushed anywhere");
    // The regenerable dep overlay a block is allowed to reclaim (planning#194).
    const overlayDir = path.join(sessionRoot, "overlay");
    fs.mkdirSync(overlayDir, { recursive: true });
    insertSession({
      id: "derepoed-light",
      lastUsedAt: daysAgo(DEFAULT_DISK_LADDER.evictUnmergedAfterMs / 86_400_000 + 1),
      diskTier: "light",
      workspaceDir: wsDir,
      branch: "main",
    });

    const { registry } = fakeRegistry();
    const { appended, chatHistory } = fakeChatHistory();
    const deps = {
      ...baseDeps(sm, registry),
      createGitManager: (dir: string) => new GitManager(dir),
      chatHistory,
      notifiedEvictBlocked: new Set<string>(),
    };

    const first = await escalateDiskTiers(deps);
    const second = await escalateDiskTiers(deps);

    expect(first.toEvicted).toBe(0);
    expect(first.evictBlockedByPush).toBe(1);
    // Blocked every pass — the condition is still true — but never wiped.
    expect(second.evictBlockedByPush).toBe(1);
    expect(sm.get("derepoed-light")?.diskTier).toBe("light");
    expect(fs.existsSync(path.join(wsDir, "only-copy.txt"))).toBe(true);
    expect(fs.existsSync(path.join(wsDir, "a.txt"))).toBe(true);
    // The expensive, regenerable half IS reclaimed, and the user is told once.
    expect(fs.existsSync(overlayDir)).toBe(false);
    expect(appended).toHaveLength(1);
    expect(appended[0]!.text).toContain("no longer a git repository");
  });

  // Same empty-remnant shape, no remote: nothing could restore it, so recording
  // "evicted" would assert a lie. The refusal is unchanged — only the log is
  // throttled.
  it("refuses to evict an empty remnant when there is no remote to restore from", async () => {
    setup();
    const sm = new SessionManager(dbManager!);
    const wsDir = path.join(tmpDir, "ws-remnant-noremote");
    fs.mkdirSync(wsDir, { recursive: true });
    insertSession({
      id: "remnant-noremote",
      lastUsedAt: daysAgo(DEFAULT_DISK_LADDER.evictUnmergedAfterMs / 86_400_000 + 1),
      diskTier: "light",
      workspaceDir: wsDir,
      branch: "main",
      remoteUrl: "", // the session row has no remote either
    });

    const { registry } = fakeRegistry();
    const result = await escalateDiskTiers({
      ...baseDeps(sm, registry),
      createGitManager: (dir) => new GitManager(dir),
    });

    expect(result.toEvicted).toBe(0);
    expect(sm.get("remnant-noremote")?.diskTier).toBe("light");
    expect(fs.existsSync(wsDir)).toBe(true);
  });

  // `.git` as a FILE is what a worktree or submodule checkout looks like, and
  // as a symlink it is still a repository pointer. Neither is "no repository":
  // both must take the careful path, never the new one.
  it("treats a `.git` FILE as a repository — the careful path, never the wipe", async () => {
    setup();
    const sm = new SessionManager(dbManager!);
    const wsDir = path.join(tmpDir, "ws-gitfile");
    await initRepo(wsDir);
    fs.rmSync(path.join(wsDir, ".git"), { recursive: true, force: true });
    fs.writeFileSync(path.join(wsDir, ".git"), "gitdir: /elsewhere/.git/worktrees/w\n");
    insertSession({
      id: "gitfile-light",
      lastUsedAt: daysAgo(DEFAULT_DISK_LADDER.evictUnmergedAfterMs / 86_400_000 + 1),
      diskTier: "light",
      workspaceDir: wsDir,
      branch: "main",
    });

    const { registry } = fakeRegistry();
    const result = await escalateDiskTiers({
      ...baseDeps(sm, registry),
      createGitManager: (dir) => new GitManager(dir),
    });

    // The gitdir target doesn't exist, so git fails and the catch refuses —
    // which is the point: a repository pointer is never the empty-remnant case.
    expect(result.toEvicted).toBe(0);
    expect(result.evictBlockedByPush).toBe(0); // not the no-repository block
    expect(fs.existsSync(path.join(wsDir, "a.txt"))).toBe(true);
  });

  // A corrupt-but-present `.git` still takes the careful path (never wiped) —
  // but it must not narrate its unchanging failure on every hourly pass.
  it("reports a repeating git failure once, not once per pass", async () => {
    setup();
    const sm = new SessionManager(dbManager!);
    const wsDir = path.join(tmpDir, "ws-corrupt");
    await initRepo(wsDir);
    fs.rmSync(path.join(wsDir, ".git"), { recursive: true, force: true });
    // A `.git` FILE with an invalid gitfile format: present (so the "no
    // repository at all" fast path doesn't apply) and broken on every git call.
    fs.writeFileSync(path.join(wsDir, ".git"), "not a gitfile\n");
    insertSession({
      id: "corrupt-light",
      lastUsedAt: daysAgo(DEFAULT_DISK_LADDER.evictUnmergedAfterMs / 86_400_000 + 1),
      diskTier: "light",
      workspaceDir: wsDir,
      branch: "main",
    });

    const { registry } = fakeRegistry();
    const deps = {
      ...baseDeps(sm, registry),
      createGitManager: (dir: string) => new GitManager(dir),
      evictStuckLog: new Map<string, string>(),
    };

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let warnings: string[];
    try {
      await escalateDiskTiers(deps);
      await escalateDiskTiers(deps);
      await escalateDiskTiers(deps);
      // Read BEFORE the restore — `mockRestore` also clears `mock.calls`.
      warnings = warn.mock.calls.map((c) => String(c[0]));
    } finally {
      warn.mockRestore();
    }

    expect(warnings.filter((w) => w.includes("git check failed"))).toHaveLength(1);
    // Still refused: the checkout survives every pass.
    expect(sm.get("corrupt-light")?.diskTier).toBe("light");
    expect(fs.existsSync(path.join(wsDir, "a.txt"))).toBe(true);

    // The suppression is scoped to a session that is still stuck the same way.
    // Once the row leaves `light` — reopened, archived, deleted — the entry is
    // pruned, so a later failure is reported again instead of being swallowed
    // by a signature from a previous episode.
    expect(deps.evictStuckLog.size).toBe(1);
    sm.setDiskTier("corrupt-light", "evicted");
    await escalateDiskTiers(deps);
    expect(deps.evictStuckLog.size).toBe(0);
  });

  // The throttle keys on the CAUSE, not the session: a session that gets stuck
  // for a new reason must never be silenced by the signature of the old one.
  it("reports a DIFFERENT git failure even while an earlier one is throttled", async () => {
    setup();
    const sm = new SessionManager(dbManager!);
    const wsDir = path.join(tmpDir, "ws-changing");
    await initRepo(wsDir);
    fs.rmSync(path.join(wsDir, ".git"), { recursive: true, force: true });
    fs.writeFileSync(path.join(wsDir, ".git"), "not a gitfile\n");
    insertSession({
      id: "changing-light",
      lastUsedAt: daysAgo(DEFAULT_DISK_LADDER.evictUnmergedAfterMs / 86_400_000 + 1),
      diskTier: "light",
      workspaceDir: wsDir,
      branch: "main",
    });

    const { registry } = fakeRegistry();
    const deps = {
      ...baseDeps(sm, registry),
      createGitManager: (dir: string) => new GitManager(dir),
      evictStuckLog: new Map<string, string>(),
    };

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let warnings: string[];
    try {
      await escalateDiskTiers(deps);
      await escalateDiskTiers(deps);
      // A different breakage in the same slot → a different message.
      fs.writeFileSync(path.join(wsDir, ".git"), "gitdir: /nonexistent/git/dir\n");
      await escalateDiskTiers(deps);
      warnings = warn.mock.calls.map((c) => String(c[0]));
    } finally {
      warn.mockRestore();
    }

    expect(warnings.filter((w) => w.includes("git check failed"))).toHaveLength(2);
  });

  it("planning#296: warns once per session, not once per escalation pass", async () => {
    setup();
    const sm = new SessionManager(dbManager!);
    const wsDir = path.join(tmpDir, "ws-secret-repeat");
    await initRepo(wsDir);
    fs.writeFileSync(path.join(wsDir, ".env"), `AWS_ACCESS_KEY_ID=${FIXTURE_AWS_KEY}\n`);
    insertSession({
      id: "repeat-light",
      lastUsedAt: daysAgo(DEFAULT_DISK_LADDER.evictUnmergedAfterMs / 86_400_000 + 1),
      diskTier: "light",
      workspaceDir: wsDir,
      branch: "main",
    });

    const { registry } = fakeRegistry();
    const { appended, chatHistory } = fakeChatHistory();
    const notifiedEvictBlocked = new Set<string>();
    const deps = {
      ...baseDeps(sm, registry),
      createGitManager: (dir: string) => new GitManager(dir),
      chatHistory,
      notifiedEvictBlocked,
    };

    const first = await escalateDiskTiers(deps);
    const second = await escalateDiskTiers(deps);

    // Blocked every pass (the condition is still true) but warned only once —
    // the hourly timer must not append a transcript row every hour.
    expect(first.evictBlockedByDirty).toBe(1);
    expect(second.evictBlockedByDirty).toBe(1);
    expect(appended).toHaveLength(1);
  });

  it("disk-pressure: escalates LRU hot → light regardless of age until high mark", async () => {
    setup();
    const sm = new SessionManager(dbManager!);
    // Two fresh (below IDLE_LIGHT) hot sessions — age alone wouldn't touch them.
    const wsA = path.join(tmpDir, "ws-a");
    const wsB = path.join(tmpDir, "ws-b");
    fs.mkdirSync(wsA, { recursive: true });
    fs.mkdirSync(wsB, { recursive: true });
    insertSession({ id: "lru-old", lastUsedAt: hoursAgo(3), diskTier: "hot", workspaceDir: wsA });
    insertSession({ id: "lru-new", lastUsedAt: hoursAgo(1), diskTier: "hot", workspaceDir: wsB });

    // Free disk starts below low; after one escalation it crosses high.
    let free = 100;
    const { registry } = fakeRegistry();
    const result = await escalateDiskTiers({
      ...baseDeps(sm, registry),
      diskFreeLow: 1000,
      diskFreeHigh: 5000,
      getFreeDiskBytes: () => {
        const cur = free;
        free = 9999; // next probe reports recovered space
        return Promise.resolve(cur);
      },
    });

    // Only the least-recently-used one is escalated before free recovers.
    expect(result.toLight).toBe(1);
    expect(sm.get("lru-old")?.diskTier).toBe("light");
    expect(sm.get("lru-new")?.diskTier).toBe("hot");
  });

  it("disk-pressure no-ops when free space is above the low-water mark", async () => {
    setup();
    const sm = new SessionManager(dbManager!);
    insertSession({ id: "fresh", lastUsedAt: hoursAgo(2), diskTier: "hot" });

    const { registry } = fakeRegistry();
    const result = await escalateDiskTiers({
      ...baseDeps(sm, registry),
      diskFreeLow: 1000,
      diskFreeHigh: 5000,
      getFreeDiskBytes: () => Promise.resolve(8000),
    });

    expect(result.toLight).toBe(0);
    expect(sm.get("fresh")?.diskTier).toBe("hot");
  });

  // docs/161 — merge-aware eviction: a merged PR is a stronger "done" signal
  // than idle age, so merged sessions evict on the short merged clock (2d) while
  // unmerged WIP stays on the gentle unmerged clock (14d).
  const mergedThresholdDays = DEFAULT_DISK_LADDER.evictMergedAfterMs / 86_400_000;

  it("merge-aware: a merged session past the merged threshold evicts", async () => {
    setup();
    const sm = new SessionManager(dbManager!);
    const wsDir = path.join(tmpDir, "ws-merged");
    await initRepo(wsDir);
    insertSession({
      id: "merged-light",
      // Older than the 2d merged threshold but younger than the 14d default.
      lastUsedAt: daysAgo(mergedThresholdDays + 1),
      mergedAt: daysAgo(mergedThresholdDays + 1),
      diskTier: "light",
      workspaceDir: wsDir,
      branch: "main",
    });

    const { registry } = fakeRegistry();
    const result = await escalateDiskTiers({
      ...baseDeps(sm, registry),
      createGitManager: (dir) => new GitManager(dir),
    });

    expect(result.toEvicted).toBe(1);
    expect(sm.get("merged-light")?.diskTier).toBe("evicted");
    expect(fs.existsSync(wsDir)).toBe(false);
  });

  it("merge-aware: an unmerged session of the same age is NOT evicted", async () => {
    setup();
    const sm = new SessionManager(dbManager!);
    const wsDir = path.join(tmpDir, "ws-unmerged");
    await initRepo(wsDir);
    insertSession({
      id: "unmerged-light",
      // Past the merged threshold but well below the 14d unmerged clock.
      lastUsedAt: daysAgo(mergedThresholdDays + 1),
      diskTier: "light",
      workspaceDir: wsDir,
      branch: "main",
    });

    const { registry } = fakeRegistry();
    const result = await escalateDiskTiers({
      ...baseDeps(sm, registry),
      createGitManager: (dir) => new GitManager(dir),
    });

    expect(result.toEvicted).toBe(0);
    expect(sm.get("unmerged-light")?.diskTier).toBe("light");
    expect(fs.existsSync(wsDir)).toBe(true);
  });

  it("merge-aware: a merged session with a recent view is protected (idle age = max(used, viewed))", async () => {
    setup();
    const sm = new SessionManager(dbManager!);
    const wsDir = path.join(tmpDir, "ws-merged-viewed");
    await initRepo(wsDir);
    insertSession({
      id: "merged-viewed",
      lastUsedAt: daysAgo(30), // turn activity ancient
      mergedAt: daysAgo(30),
      lastViewedAt: hoursAgo(2), // …but reopened to look at 2h ago
      diskTier: "light",
      workspaceDir: wsDir,
      branch: "main",
    });

    const { registry } = fakeRegistry();
    const result = await escalateDiskTiers({
      ...baseDeps(sm, registry),
      createGitManager: (dir) => new GitManager(dir),
    });

    expect(result.toEvicted).toBe(0);
    expect(sm.get("merged-viewed")?.diskTier).toBe("light");
    expect(fs.existsSync(wsDir)).toBe(true);
  });

  it("merge-aware: a merged, still-dirty session is committed + pushed before wipe", async () => {
    setup();
    const sm = new SessionManager(dbManager!);
    // Bare remote that origin/main can be pushed to.
    const remoteDir = path.join(tmpDir, "remote.git");
    await simpleGit().init(["--bare", "--initial-branch=main", remoteDir]);

    const wsDir = path.join(tmpDir, "ws-merged-dirty");
    fs.mkdirSync(wsDir, { recursive: true });
    const g = simpleGit(wsDir);
    await g.init(["--initial-branch=main"]);
    await g.addConfig("user.email", "test@example.com");
    await g.addConfig("user.name", "Test");
    await g.addRemote("origin", remoteDir);
    fs.writeFileSync(path.join(wsDir, "a.txt"), "hello");
    await g.add(".");
    await g.commit("init");
    await g.push("origin", "main", ["--set-upstream"]);
    // Uncommitted edit at eviction time — must be committed + pushed, not lost.
    fs.writeFileSync(path.join(wsDir, "b.txt"), "uncommitted work");

    insertSession({
      id: "merged-dirty",
      lastUsedAt: daysAgo(mergedThresholdDays + 1),
      mergedAt: daysAgo(mergedThresholdDays + 1),
      diskTier: "light",
      workspaceDir: wsDir,
      branch: "main",
    });

    const { registry } = fakeRegistry();
    const result = await escalateDiskTiers({
      ...baseDeps(sm, registry),
      createGitManager: (dir) => new GitManager(dir),
    });

    expect(result.toEvicted).toBe(1);
    expect(result.evictBlockedByPush).toBe(0);
    expect(fs.existsSync(wsDir)).toBe(false);
    // The dirty edit reached the remote before the wipe (reclaim-only, no loss).
    const files = (await simpleGit(remoteDir).raw(["ls-tree", "--name-only", "main"]))
      .split("\n").filter(Boolean);
    expect(files).toContain("b.txt");
  });

  it("ignores already-evicted sessions", async () => {
    setup();
    const sm = new SessionManager(dbManager!);
    insertSession({ id: "gone", lastUsedAt: daysAgo(99), diskTier: "evicted" });

    const { registry, disposed } = fakeRegistry();
    const result = await escalateDiskTiers(baseDeps(sm, registry));

    expect(result.toLight).toBe(0);
    expect(result.toEvicted).toBe(0);
    expect(disposed).not.toContain("gone");
  });

  // planning#199 — a custom ladder threads through and overrides the defaults.
  it("honors a custom ladder threshold", async () => {
    setup();
    const sm = new SessionManager(dbManager!);
    // 12h idle: below the default 24h `hot → light`, but above a 6h custom one.
    insertSession({ id: "young", lastUsedAt: hoursAgo(12), diskTier: "hot" });

    const { registry } = fakeRegistry();
    const result = await escalateDiskTiers({
      ...baseDeps(sm, registry),
      ladder: { ...DEFAULT_DISK_LADDER, lightAfterMs: 6 * 3_600_000 },
    });

    expect(result.toLight).toBe(1);
    expect(sm.get("young")?.diskTier).toBe("light");
  });
});

// planning#199 — the ladder ordering invariant is asserted once at startup so an
// incoherent env override fails fast instead of misbehaving at runtime.
describe("assertDiskLadderOrdering", () => {
  it("accepts the default ladder", () => {
    expect(() => assertDiskLadderOrdering(DEFAULT_DISK_LADDER)).not.toThrow();
  });

  it("accepts equal thresholds (non-strict ordering)", () => {
    expect(() => assertDiskLadderOrdering({
      lightAfterMs: 1000, evictMergedAfterMs: 1000, evictUnmergedAfterMs: 1000,
    })).not.toThrow();
  });

  it("rejects a merged clock below the light clock", () => {
    expect(() => assertDiskLadderOrdering({
      lightAfterMs: 24 * 3_600_000,
      evictMergedAfterMs: 1 * 3_600_000, // merged evict before light — incoherent
      evictUnmergedAfterMs: 14 * 86_400_000,
    })).toThrow(/lightAfterMs ≤ evictMergedAfterMs/);
  });

  it("rejects an unmerged clock below the merged clock", () => {
    expect(() => assertDiskLadderOrdering({
      lightAfterMs: 24 * 3_600_000,
      evictMergedAfterMs: 14 * 86_400_000,
      evictUnmergedAfterMs: 2 * 86_400_000, // unmerged WIP evicts before merged
    })).toThrow(/evictMergedAfterMs ≤ evictUnmergedAfterMs/);
  });
});

// docs/161 — portable disk-pressure watermarks: fraction-of-disk *_PCT vars
// derive byte thresholds from the host's total disk size, while explicit
// *_BYTES vars still win for backward compat.
describe("resolveDiskWatermarks", () => {
  const TOTAL = 1_000_000_000; // 1 GB host

  it("explicit *_BYTES win over *_PCT", () => {
    const { diskFreeLow, diskFreeHigh } = resolveDiskWatermarks({
      lowBytes: 111,
      highBytes: 222,
      lowPct: 0.1,
      highPct: 0.2,
      totalBytes: TOTAL,
    });
    expect(diskFreeLow).toBe(111);
    expect(diskFreeHigh).toBe(222);
  });

  it("derives from *_PCT × total when bytes are absent", () => {
    const { diskFreeLow, diskFreeHigh } = resolveDiskWatermarks({
      lowPct: 0.1,
      highPct: 0.2,
      totalBytes: TOTAL,
    });
    expect(diskFreeLow).toBe(100_000_000);
    expect(diskFreeHigh).toBe(200_000_000);
  });

  it("resolves each watermark independently (bytes for one, pct for the other)", () => {
    const { diskFreeLow, diskFreeHigh } = resolveDiskWatermarks({
      lowBytes: 50,
      highPct: 0.2,
      totalBytes: TOTAL,
    });
    expect(diskFreeLow).toBe(50);
    expect(diskFreeHigh).toBe(200_000_000);
  });

  it("neither set → both undefined (override stays disabled)", () => {
    const { diskFreeLow, diskFreeHigh } = resolveDiskWatermarks({ totalBytes: TOTAL });
    expect(diskFreeLow).toBeUndefined();
    expect(diskFreeHigh).toBeUndefined();
  });

  it("*_PCT with unknown total → undefined (can't derive without statfs)", () => {
    const { diskFreeLow, diskFreeHigh } = resolveDiskWatermarks({
      lowPct: 0.1,
      highPct: 0.2,
      totalBytes: null,
    });
    expect(diskFreeLow).toBeUndefined();
    expect(diskFreeHigh).toBeUndefined();
  });
});
