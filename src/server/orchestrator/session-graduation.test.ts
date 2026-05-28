import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { SessionManager } from "./sessions.js";
import type { SessionRunnerRegistry } from "./session-runner.js";
import type { PrStatusPoller } from "./pr-status-poller.js";
import type { GitManager } from "../shared/git.js";
import type { SessionInfo, WsServerMessage } from "../shared/types.js";

// Drain microtasks until `predicate()` returns true, or fail after `maxTicks`.
async function flush(predicate: () => boolean, maxTicks = 50): Promise<void> {
  for (let i = 0; i < maxTicks; i++) {
    if (predicate()) return;
    await new Promise((r) => setImmediate(r));
  }
  throw new Error("scheduleSessionNaming: predicate never resolved");
}

interface FakeSessionState {
  id: string;
  title: string;
  branch?: string;
  workspaceDir?: string;
  remoteUrl?: string;
  branchRenamed?: boolean;
  mergedAt?: string;
}

function buildDeps(state: FakeSessionState) {
  const session: FakeSessionState = { ...state };
  const emitMessage = vi.fn();
  const renameBranch = vi.fn();

  const sessionManager = {
    get: vi.fn((id: string): SessionInfo | null => {
      if (id !== session.id) return null;
      return { ...session } as unknown as SessionInfo;
    }),
    rename: vi.fn((id: string, title: string) => {
      if (id === session.id) session.title = title;
    }),
    setBranch: vi.fn((id: string, branch: string) => {
      if (id === session.id) session.branch = branch;
    }),
    setBranchRenamed: vi.fn((id: string, renamed: boolean) => {
      if (id === session.id) session.branchRenamed = renamed;
    }),
  } as unknown as SessionManager;

  const runnerRegistry = {
    get: vi.fn(() => ({ emitMessage })),
  } as unknown as SessionRunnerRegistry;

  const prStatusPoller = {
    getStatus: vi.fn(() => undefined),
  } as unknown as PrStatusPoller;

  const createGitManager = vi.fn(() => ({
    renameBranch,
    getCurrentBranch: vi.fn(async () => session.branch ?? ""),
    diffStatVsBranch: vi.fn(async () => ({ insertions: 3, deletions: 1 })),
  } as unknown as GitManager));

  const sseBroadcast = vi.fn();

  return {
    deps: { sessionManager, runnerRegistry, createGitManager, prStatusPoller, sseBroadcast },
    spies: { emitMessage, renameBranch, sseBroadcast },
    state: session,
  };
}

describe("scheduleSessionNaming", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock("./session-namer.js");
  });

  it("renames branch + title + broadcasts when the AI returns a name", async () => {
    vi.doMock("./session-namer.js", () => ({
      generateSessionName: vi.fn(async () => ({ slug: "fix-flaky-test", title: "Fix flaky test" })),
    }));
    const { scheduleSessionNaming } = await import("./session-graduation.js");

    const { deps, spies, state } = buildDeps({
      id: "s1",
      title: "Fix the flaky test",
      branch: "shipit/abc123",
      workspaceDir: "/tmp/ws",
      remoteUrl: "https://github.com/acme/app.git",
    });

    scheduleSessionNaming(deps, { sessionId: "s1", userText: "Fix the flaky test", agentId: "claude" });

    await flush(() => state.branchRenamed === true);

    expect(spies.renameBranch).toHaveBeenCalledWith("shipit/abc123", "shipit/fix-flaky-test-abc123");
    expect(state.branch).toBe("shipit/fix-flaky-test-abc123");
    expect(state.title).toBe("Fix flaky test");
    expect(state.branchRenamed).toBe(true);
    expect(spies.sseBroadcast).toHaveBeenCalledWith("session_renamed", expect.objectContaining({
      session: expect.objectContaining({ id: "s1", title: "Fix flaky test" }),
    }));
    // PR card emitted alongside session_renamed (one per runner.emitMessage call).
    const messageTypes = spies.emitMessage.mock.calls.map((c) => (c[0] as WsServerMessage).type);
    expect(messageTypes).toContain("session_renamed");
    expect(messageTypes).toContain("pr_lifecycle_update");
  });

  it("falls through to finalize when the AI returns null (no rename)", async () => {
    vi.doMock("./session-namer.js", () => ({
      generateSessionName: vi.fn(async () => null),
    }));
    const { scheduleSessionNaming } = await import("./session-graduation.js");

    const { deps, spies, state } = buildDeps({
      id: "s1",
      title: "placeholder",
      branch: "shipit/xyz789",
      workspaceDir: "/tmp/ws",
      remoteUrl: "https://github.com/acme/app.git",
    });

    scheduleSessionNaming(deps, { sessionId: "s1", userText: "do a thing", agentId: "codex" });

    await flush(() => state.branchRenamed === true);

    expect(spies.renameBranch).not.toHaveBeenCalled();
    expect(state.branch).toBe("shipit/xyz789");
    expect(state.title).toBe("placeholder");
    expect(state.branchRenamed).toBe(true);
    expect(spies.sseBroadcast).not.toHaveBeenCalled();
  });

  it("still finalizes when generateSessionName rejects", async () => {
    vi.doMock("./session-namer.js", () => ({
      generateSessionName: vi.fn(async () => { throw new Error("boom"); }),
    }));
    const { scheduleSessionNaming } = await import("./session-graduation.js");

    const { deps, state } = buildDeps({
      id: "s1",
      title: "placeholder",
      branch: "shipit/xyz789",
      workspaceDir: "/tmp/ws",
    });

    scheduleSessionNaming(deps, { sessionId: "s1", userText: "x", agentId: "claude" });

    await flush(() => state.branchRenamed === true);
    expect(state.branchRenamed).toBe(true);
  });

  it("skips the PR-ready card when a PR is already tracked for the session", async () => {
    vi.doMock("./session-namer.js", () => ({
      generateSessionName: vi.fn(async () => ({ slug: "thing", title: "Thing" })),
    }));
    const { scheduleSessionNaming } = await import("./session-graduation.js");

    const { deps, spies, state } = buildDeps({
      id: "s1",
      title: "placeholder",
      branch: "shipit/abc",
      workspaceDir: "/tmp/ws",
      remoteUrl: "https://github.com/acme/app.git",
    });
    // PR already exists — the ready card path should not fire.
    (deps.prStatusPoller.getStatus as ReturnType<typeof vi.fn>).mockReturnValue({ phase: "open" });

    scheduleSessionNaming(deps, { sessionId: "s1", userText: "x", agentId: "claude" });

    await flush(() => state.branchRenamed === true);

    const types = spies.emitMessage.mock.calls.map((c) => (c[0] as WsServerMessage).type);
    expect(types).toContain("session_renamed");
    expect(types).not.toContain("pr_lifecycle_update");
  });
});
