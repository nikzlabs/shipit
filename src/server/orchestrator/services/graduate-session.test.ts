import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { SessionManager } from "../sessions.js";
import type { SessionRunnerRegistry } from "../session-runner.js";
import type { RepoStore } from "../repo-store.js";
import type { PrStatusPoller } from "../pr-status-poller.js";
import type { GitManager } from "../../shared/git.js";
import type { SessionInfo, WsServerMessage } from "../../shared/types.js";

// Drain microtasks until `predicate()` is true, or fail after `maxTicks`.
async function flush(predicate: () => boolean, maxTicks = 50): Promise<void> {
  for (let i = 0; i < maxTicks; i++) {
    if (predicate()) return;
    await new Promise((r) => setImmediate(r));
  }
  throw new Error("graduate-session: predicate never resolved");
}

interface FakeSessionState {
  id: string;
  title: string;
  branch?: string;
  workspaceDir?: string;
  remoteUrl?: string;
  warm?: boolean;
  branchRenamed?: boolean;
  mergedAt?: string;
  model?: string;
  parentSessionId?: string;
  spawnedByTurn?: string;
}

function buildDeps(initial: FakeSessionState) {
  const state: FakeSessionState = { ...initial };
  const emitMessage = vi.fn();
  const renameBranch = vi.fn();
  const touchSpy = vi.fn();
  const trackSpy = vi.fn();
  const setWarmSpy = vi.fn((id: string, w: boolean) => { if (id === state.id) state.warm = w; });
  const setModelSpy = vi.fn((id: string, m: string) => { if (id === state.id) state.model = m; });
  const setParentSpy = vi.fn((id: string, p: string, t?: string) => {
    if (id === state.id) { state.parentSessionId = p; state.spawnedByTurn = t; }
  });

  const sessionManager = {
    get: vi.fn((id: string): SessionInfo | undefined => {
      if (id !== state.id) return undefined;
      return { ...state } as unknown as SessionInfo;
    }),
    list: vi.fn(() => [state as unknown as SessionInfo]),
    rename: vi.fn((id: string, title: string) => { if (id === state.id) state.title = title; }),
    setBranch: vi.fn((id: string, branch: string) => { if (id === state.id) state.branch = branch; }),
    setBranchRenamed: vi.fn((id: string, renamed: boolean) => { if (id === state.id) state.branchRenamed = renamed; }),
    setWarm: setWarmSpy,
    setModel: setModelSpy,
    setParentSession: setParentSpy,
    track: trackSpy,
  } as unknown as SessionManager;

  const runnerRegistry = {
    get: vi.fn(() => ({ emitMessage })),
  } as unknown as SessionRunnerRegistry;

  const repoStore = { touch: touchSpy } as unknown as RepoStore;

  const prStatusPoller = {
    getStatus: vi.fn(() => undefined),
  } as unknown as PrStatusPoller;

  const createGitManager = vi.fn(() => ({
    renameBranch,
    getCurrentBranch: vi.fn(async () => state.branch ?? ""),
    diffStatVsBranch: vi.fn(async () => ({ insertions: 3, deletions: 1 })),
  } as unknown as GitManager));

  const sseBroadcast = vi.fn();

  return {
    deps: { sessionManager, runnerRegistry, repoStore, createGitManager, prStatusPoller, sseBroadcast },
    spies: { emitMessage, renameBranch, touchSpy, trackSpy, setWarmSpy, setModelSpy, setParentSpy, sseBroadcast },
    state,
  };
}

describe("graduateSession", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock("../session-namer.js");
  });

  it("marks setWarm(false) and track() synchronously", async () => {
    vi.doMock("../session-namer.js", () => ({ generateSessionName: vi.fn(async () => null) }));
    const { graduateSession } = await import("./graduate-session.js");
    const { deps, spies, state } = buildDeps({
      id: "s1",
      title: "old",
      branch: "shipit/abc",
      workspaceDir: "/tmp/ws",
      remoteUrl: "https://github.com/x/y.git",
      warm: true,
    });

    graduateSession(deps, { sessionId: "s1", userText: "do a thing", agentId: "claude" });

    expect(spies.setWarmSpy).toHaveBeenCalledWith("s1", false);
    expect(state.warm).toBe(false);
    expect(spies.trackSpy).toHaveBeenCalledWith("s1");
  });

  it("renames title to the placeholder slice when no explicit title is supplied", async () => {
    vi.doMock("../session-namer.js", () => ({ generateSessionName: vi.fn(async () => null) }));
    const { graduateSession } = await import("./graduate-session.js");
    const { deps, state } = buildDeps({ id: "s1", title: "old", branch: "shipit/abc", workspaceDir: "/tmp/ws", remoteUrl: "x" });

    graduateSession(deps, { sessionId: "s1", userText: "Fix the flaky test", agentId: "claude" });

    expect(state.title).toBe("Fix the flaky test");
  });

  it("uses explicitTitle when supplied and skips AI naming", async () => {
    const generateSpy = vi.fn(async () => ({ slug: "should-not-run", title: "Should Not Run" }));
    vi.doMock("../session-namer.js", () => ({ generateSessionName: generateSpy }));
    const { graduateSession } = await import("./graduate-session.js");
    const { deps, spies, state } = buildDeps({ id: "s1", title: "old", branch: "shipit/abc", workspaceDir: "/tmp/ws", remoteUrl: "x" });

    graduateSession(deps, {
      sessionId: "s1",
      userText: "Fix the flaky test",
      agentId: "claude",
      explicitTitle: "My Custom Title",
    });

    expect(state.title).toBe("My Custom Title");
    expect(generateSpy).not.toHaveBeenCalled();
    expect(spies.renameBranch).not.toHaveBeenCalled();
    expect(state.branchRenamed).toBe(true);
  });

  it("skips AI naming when explicitBranch is supplied", async () => {
    const generateSpy = vi.fn(async () => ({ slug: "should-not-run", title: "Should Not Run" }));
    vi.doMock("../session-namer.js", () => ({ generateSessionName: generateSpy }));
    const { graduateSession } = await import("./graduate-session.js");
    const { deps, spies, state } = buildDeps({ id: "s1", title: "placeholder", branch: "user/feature", workspaceDir: "/tmp/ws", remoteUrl: "x" });

    graduateSession(deps, {
      sessionId: "s1",
      userText: "x",
      agentId: "claude",
      explicitBranch: "user/feature",
    });

    expect(generateSpy).not.toHaveBeenCalled();
    expect(spies.renameBranch).not.toHaveBeenCalled();
    expect(state.branchRenamed).toBe(true);
  });

  it("runs AI naming and renames branch + title when no explicit fields are supplied", async () => {
    vi.doMock("../session-namer.js", () => ({
      generateSessionName: vi.fn(async () => ({ slug: "fix-flaky", title: "Fix flaky test" })),
    }));
    const { graduateSession } = await import("./graduate-session.js");
    const { deps, spies, state } = buildDeps({
      id: "s1",
      title: "placeholder",
      branch: "shipit/abc123",
      workspaceDir: "/tmp/ws",
      remoteUrl: "https://github.com/x/y.git",
    });

    graduateSession(deps, { sessionId: "s1", userText: "Fix the flaky test", agentId: "claude" });

    await flush(() => state.branchRenamed === true);

    expect(spies.renameBranch).toHaveBeenCalledWith("shipit/abc123", "shipit/fix-flaky-abc123");
    expect(state.branch).toBe("shipit/fix-flaky-abc123");
    expect(state.title).toBe("Fix flaky test");
    const types = spies.sseBroadcast.mock.calls.map((c) => c[0] as string);
    expect(types).toContain("session_renamed");
  });

  it("with skipBranchRename: true, AI naming updates the title but leaves the branch alone", async () => {
    vi.doMock("../session-namer.js", () => ({
      generateSessionName: vi.fn(async () => ({ slug: "fix-flaky", title: "Fix flaky test" })),
    }));
    const { graduateSession } = await import("./graduate-session.js");
    const { deps, spies, state } = buildDeps({
      id: "s1",
      title: "placeholder",
      branch: "shipit/abc123",
      workspaceDir: "/tmp/ws",
      remoteUrl: "https://github.com/x/y.git",
    });

    graduateSession(deps, {
      sessionId: "s1",
      userText: "Fix the flaky test",
      agentId: "claude",
      skipBranchRename: true,
    });

    await flush(() => state.branchRenamed === true);

    expect(spies.renameBranch).not.toHaveBeenCalled();
    expect(state.branch).toBe("shipit/abc123");
    expect(state.title).toBe("Fix flaky test");
  });

  it("calls repoStore.touch when remoteUrl is present", async () => {
    vi.doMock("../session-namer.js", () => ({ generateSessionName: vi.fn(async () => null) }));
    const { graduateSession } = await import("./graduate-session.js");
    const { deps, spies } = buildDeps({
      id: "s1",
      title: "x",
      workspaceDir: "/tmp/ws",
      remoteUrl: "https://github.com/x/y.git",
    });

    graduateSession(deps, { sessionId: "s1", userText: "x", agentId: "claude" });

    expect(spies.touchSpy).toHaveBeenCalledWith("https://github.com/x/y.git");
  });

  it("does not call repoStore.touch when remoteUrl is empty", async () => {
    vi.doMock("../session-namer.js", () => ({ generateSessionName: vi.fn(async () => null) }));
    const { graduateSession } = await import("./graduate-session.js");
    const { deps, spies } = buildDeps({ id: "s1", title: "x", workspaceDir: "/tmp/ws" });

    graduateSession(deps, { sessionId: "s1", userText: "x", agentId: "claude" });

    expect(spies.touchSpy).not.toHaveBeenCalled();
  });

  it("broadcasts session_list once synchronously", async () => {
    vi.doMock("../session-namer.js", () => ({ generateSessionName: vi.fn(async () => null) }));
    const { graduateSession } = await import("./graduate-session.js");
    const { deps, spies } = buildDeps({ id: "s1", title: "x", remoteUrl: "x" });

    graduateSession(deps, { sessionId: "s1", userText: "x", agentId: "claude" });

    const listBroadcasts = spies.sseBroadcast.mock.calls.filter((c) => c[0] === "session_list");
    expect(listBroadcasts.length).toBe(1);
  });

  it("sets model + parentSession when supplied", async () => {
    vi.doMock("../session-namer.js", () => ({ generateSessionName: vi.fn(async () => null) }));
    const { graduateSession } = await import("./graduate-session.js");
    const { deps, spies, state } = buildDeps({ id: "s1", title: "x", remoteUrl: "x" });

    graduateSession(deps, {
      sessionId: "s1",
      userText: "x",
      agentId: "claude",
      model: "claude-opus-4-7",
      parentSessionId: "parent-1",
      spawnedByTurn: "turn-42",
    });

    expect(spies.setModelSpy).toHaveBeenCalledWith("s1", "claude-opus-4-7");
    expect(spies.setParentSpy).toHaveBeenCalledWith("s1", "parent-1", "turn-42");
    expect(state.model).toBe("claude-opus-4-7");
    expect(state.parentSessionId).toBe("parent-1");
  });

  it("falls through to finalize when AI naming throws", async () => {
    vi.doMock("../session-namer.js", () => ({
      generateSessionName: vi.fn(async () => { throw new Error("boom"); }),
    }));
    const { graduateSession } = await import("./graduate-session.js");
    const { deps, state } = buildDeps({ id: "s1", title: "x", branch: "shipit/abc", workspaceDir: "/tmp/ws" });

    graduateSession(deps, { sessionId: "s1", userText: "x", agentId: "claude" });

    await flush(() => state.branchRenamed === true);
    expect(state.branchRenamed).toBe(true);
  });

  it("skips the PR-ready card when a PR is already tracked", async () => {
    vi.doMock("../session-namer.js", () => ({
      generateSessionName: vi.fn(async () => ({ slug: "thing", title: "Thing" })),
    }));
    const { graduateSession } = await import("./graduate-session.js");
    const { deps, spies, state } = buildDeps({
      id: "s1",
      title: "placeholder",
      branch: "shipit/abc",
      workspaceDir: "/tmp/ws",
      remoteUrl: "https://github.com/x/y.git",
    });
    (deps.prStatusPoller.getStatus as ReturnType<typeof vi.fn>).mockReturnValue({ phase: "open" });

    graduateSession(deps, { sessionId: "s1", userText: "x", agentId: "claude" });

    await flush(() => state.branchRenamed === true);
    const messageTypes = spies.emitMessage.mock.calls.map((c) => (c[0] as WsServerMessage).type);
    expect(messageTypes).toContain("session_renamed");
    expect(messageTypes).not.toContain("pr_lifecycle_update");
  });

  it("skips AI naming when the session has no workspace directory", async () => {
    const generateSpy = vi.fn(async () => ({ slug: "x", title: "X" }));
    vi.doMock("../session-namer.js", () => ({ generateSessionName: generateSpy }));
    const { graduateSession } = await import("./graduate-session.js");
    const { deps, state } = buildDeps({ id: "s1", title: "x", remoteUrl: "x" });

    graduateSession(deps, { sessionId: "s1", userText: "x", agentId: "claude" });

    expect(generateSpy).not.toHaveBeenCalled();
    expect(state.branchRenamed).toBe(true);
  });
});
