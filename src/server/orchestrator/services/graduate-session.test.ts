import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { SessionManager } from "../sessions.js";
import type { SessionRunnerRegistry } from "../session-runner.js";
import type { RepoStore } from "../repo-store.js";
import type { PrStatusPoller } from "../pr-status-poller.js";
import type { GitManager } from "../../shared/git.js";
import type { SessionInfo, SessionTitleSource, WsServerMessage } from "../../shared/types.js";
import { TEST_CREDENTIALS_DIR } from "../credentials-test-helpers.js";

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
  titleSource?: SessionTitleSource;
  branch?: string;
  workspaceDir?: string;
  remoteUrl?: string;
  warm?: boolean;
  branchRenamed?: boolean;
  mergedAt?: string;
  model?: string;
  parentSessionId?: string;
  spawnedByTurn?: string;
  rootSessionId?: string;
}

function buildDeps(initial: FakeSessionState) {
  const state: FakeSessionState = { ...initial };
  const emitMessage = vi.fn();
  const renameBranch = vi.fn();
  const touchSpy = vi.fn();
  const trackSpy = vi.fn();
  const setWarmSpy = vi.fn((id: string, w: boolean) => { if (id === state.id) state.warm = w; });
  const setModelSpy = vi.fn((id: string, m: string) => { if (id === state.id) state.model = m; });
  const setParentSpy = vi.fn((id: string, p: string, t?: string, root?: string) => {
    if (id === state.id) { state.parentSessionId = p; state.spawnedByTurn = t; state.rootSessionId = root; }
  });

  const sessionManager = {
    get: vi.fn((id: string): SessionInfo | undefined => {
      if (id !== state.id) return undefined;
      return { ...state } as unknown as SessionInfo;
    }),
    list: vi.fn(() => [state as unknown as SessionInfo]),
    rename: vi.fn((id: string, title: string, source?: SessionTitleSource) => {
      if (id === state.id) { state.title = title; state.titleSource = source; }
    }),
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

/**
 * An Anthropic API key: the catalogue declares it directly callable, while the
 * same service's subscription is not (`catalogue/services.ts`).
 */
function directKeyStore() {
  return {
    getNonTurnModel: () => ({ serviceId: "anthropic", billingMode: "key", modelId: "haiku" }),
    listCredentialRoutes: () => [
      { id: "anthropic-key", serviceId: "anthropic", billingMode: "key", via: "string" },
    ],
    getCredentialSecret: () => "sk-direct",
    getSelectionMode: () => "ordered",
    getFailoverCutoffs: () => ({}),
  } as never;
}

// The direct clients always call fetch with a string URL and a string body.
function fakeFetch(
  respond: () => { status: number; body: string },
): { impl: typeof fetch; calls: { url: string; body: Record<string, unknown> }[] } {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const impl = (async (url: string, init: { body: string }) => {
    calls.push({ url, body: JSON.parse(init.body) as Record<string, unknown> });
    const { status, body } = respond();
    return new Response(body, { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const NAMED_OK = JSON.stringify({
  content: [{ type: "text", text: '{"slug":"add-login","title":"Add Login Page"}' }],
  usage: { input_tokens: 120, output_tokens: 18, cache_read_input_tokens: 4 },
});

// Keeps the real prompt builder and parser while spying on the CLI path.
async function mockCliNaming(generateSessionName: unknown): Promise<void> {
  vi.doMock("../session-namer.js", async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    generateSessionName,
  }));
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
    vi.doMock("../session-namer.js", () => ({ generateSessionName: vi.fn(async () => ({ name: null })) }));
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
    vi.doMock("../session-namer.js", () => ({ generateSessionName: vi.fn(async () => ({ name: null })) }));
    const { graduateSession } = await import("./graduate-session.js");
    const { deps, state } = buildDeps({ id: "s1", title: "old", branch: "shipit/abc", workspaceDir: "/tmp/ws", remoteUrl: "x" });

    graduateSession(deps, { sessionId: "s1", userText: "Fix the flaky test", agentId: "claude" });

    expect(state.title).toBe("Fix the flaky test");
  });

  it("uses explicitTitle when supplied and skips AI naming", async () => {
    const generateSpy = vi.fn(async () => ({ name: { slug: "should-not-run", title: "Should Not Run" } }));
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
    const generateSpy = vi.fn(async () => ({ name: { slug: "should-not-run", title: "Should Not Run" } }));
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
      generateSessionName: vi.fn(async () => ({ name: { slug: "fix-flaky", title: "Fix flaky test" } })),
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

  it("does not overwrite a title the user set by hand while naming was in flight", async () => {
    vi.doMock("../session-namer.js", () => ({
      generateSessionName: vi.fn(async () => ({ name: { slug: "fix-flaky", title: "Fix flaky test" } })),
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
    state.title = "My own name";
    state.titleSource = "user";

    await flush(() => state.branchRenamed === true);

    expect(state.title).toBe("My own name");
    expect(spies.renameBranch).toHaveBeenCalledWith("shipit/abc123", "shipit/fix-flaky-abc123");
    expect(spies.sseBroadcast.mock.calls.map((c) => c[0] as string)).not.toContain("session_renamed");
  });

  it("does not overwrite a title the agent set while naming was in flight", async () => {
    vi.doMock("../session-namer.js", () => ({
      generateSessionName: vi.fn(async () => ({ name: { slug: "fix-flaky", title: "Fix flaky test" } })),
    }));
    const { graduateSession } = await import("./graduate-session.js");
    const { deps, state } = buildDeps({
      id: "s1",
      title: "placeholder",
      branch: "shipit/abc123",
      workspaceDir: "/tmp/ws",
      remoteUrl: "https://github.com/x/y.git",
    });

    graduateSession(deps, { sessionId: "s1", userText: "Fix the flaky test", agentId: "claude" });
    state.title = "Agent's own name";
    state.titleSource = "agent";

    await flush(() => state.branchRenamed === true);

    expect(state.title).toBe("Agent's own name");
  });

  it("names on the account a turn would use, and heals that account", async () => {
    const generateSessionName = vi.fn(async () => ({ name: { slug: "s", title: "T" } }));
    vi.doMock("../session-namer.js", () => ({ generateSessionName }));
    const { graduateSession } = await import("./graduate-session.js");
    const { deps, state } = buildDeps({
      id: "s1", title: "placeholder", branch: "shipit/abc123", workspaceDir: "/tmp/ws",
    });
    const ensureAgentTokenFresh = vi.fn(async () => true);

    graduateSession(
      {
        ...deps,
        ensureAgentTokenFresh,
        credentialsDir: TEST_CREDENTIALS_DIR,
        providerAccountManager: {
          selectRouteForTurn: () => ({ kind: "account", id: "acct_work" }),
        } as never,
      },
      { sessionId: "s1", userText: "hi", agentId: "claude" },
    );

    await flush(() => state.branchRenamed === true);

    expect(ensureAgentTokenFresh).toHaveBeenCalledWith("claude", "acct_work");
    expect(generateSessionName).toHaveBeenCalledWith("hi", {
      harnessId: "claude",
      credentialRoot: `${TEST_CREDENTIALS_DIR}/provider-accounts/claude/acct_work`,
    });
  });

  it("leaves naming on the singleton root for a reserved (API-key) route", async () => {
    const generateSessionName = vi.fn(async () => ({ name: { slug: "s", title: "T" } }));
    vi.doMock("../session-namer.js", () => ({ generateSessionName }));
    const { graduateSession } = await import("./graduate-session.js");
    const { deps, state } = buildDeps({
      id: "s1", title: "placeholder", branch: "shipit/abc123", workspaceDir: "/tmp/ws",
    });

    graduateSession(
      {
        ...deps,
        credentialsDir: TEST_CREDENTIALS_DIR,
        providerAccountManager: {
          selectRouteForTurn: () => ({ kind: "reserved", id: "claude-api-key" }),
        } as never,
      },
      { sessionId: "s1", userText: "hi", agentId: "claude" },
    );

    await flush(() => state.branchRenamed === true);

    expect(generateSessionName).toHaveBeenCalledWith("hi", { harnessId: "claude" });
  });

  it("with skipBranchRename: true, AI naming updates the title but leaves the branch alone", async () => {
    vi.doMock("../session-namer.js", () => ({
      generateSessionName: vi.fn(async () => ({ name: { slug: "fix-flaky", title: "Fix flaky test" } })),
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
    vi.doMock("../session-namer.js", () => ({ generateSessionName: vi.fn(async () => ({ name: null })) }));
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
    vi.doMock("../session-namer.js", () => ({ generateSessionName: vi.fn(async () => ({ name: null })) }));
    const { graduateSession } = await import("./graduate-session.js");
    const { deps, spies } = buildDeps({ id: "s1", title: "x", workspaceDir: "/tmp/ws" });

    graduateSession(deps, { sessionId: "s1", userText: "x", agentId: "claude" });

    expect(spies.touchSpy).not.toHaveBeenCalled();
  });

  it("broadcasts session_list once synchronously", async () => {
    vi.doMock("../session-namer.js", () => ({ generateSessionName: vi.fn(async () => ({ name: null })) }));
    const { graduateSession } = await import("./graduate-session.js");
    const { deps, spies } = buildDeps({ id: "s1", title: "x", remoteUrl: "x" });

    graduateSession(deps, { sessionId: "s1", userText: "x", agentId: "claude" });

    const listBroadcasts = spies.sseBroadcast.mock.calls.filter((c) => c[0] === "session_list");
    expect(listBroadcasts.length).toBe(1);
  });

  it("sets model + parentSession when supplied", async () => {
    vi.doMock("../session-namer.js", () => ({ generateSessionName: vi.fn(async () => ({ name: null })) }));
    const { graduateSession } = await import("./graduate-session.js");
    const { deps, spies, state } = buildDeps({ id: "s1", title: "x", remoteUrl: "x" });

    graduateSession(deps, {
      sessionId: "s1",
      userText: "x",
      agentId: "claude",
      model: "claude-opus-4-7",
      parentSessionId: "parent-1",
      spawnedByTurn: "turn-42",
      rootSessionId: "root-1",
    });

    expect(spies.setModelSpy).toHaveBeenCalledWith("s1", "claude-opus-4-7", "anthropic");
    expect(spies.setParentSpy).toHaveBeenCalledWith("s1", "parent-1", "turn-42", "root-1");
    expect(state.model).toBe("claude-opus-4-7");
    expect(state.parentSessionId).toBe("parent-1");
    expect(state.rootSessionId).toBe("root-1");
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
      generateSessionName: vi.fn(async () => ({ name: { slug: "thing", title: "Thing" } })),
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
    const generateSpy = vi.fn(async () => ({ name: { slug: "x", title: "X" } }));
    vi.doMock("../session-namer.js", () => ({ generateSessionName: generateSpy }));
    const { graduateSession } = await import("./graduate-session.js");
    const { deps, state } = buildDeps({ id: "s1", title: "x", remoteUrl: "x" });

    graduateSession(deps, { sessionId: "s1", userText: "x", agentId: "claude" });

    expect(generateSpy).not.toHaveBeenCalled();
    expect(state.branchRenamed).toBe(true);
  });

  it("still names on the session's own harness when nothing is eligible", async () => {
    const generateSessionName = vi.fn(async () => ({ name: { slug: "s", title: "T" } }));
    vi.doMock("../session-namer.js", () => ({ generateSessionName }));
    const appended: unknown[] = [];
    const { graduateSession } = await import("./graduate-session.js");
    const { deps, state } = buildDeps({
      id: "s1", title: "placeholder", branch: "shipit/abc123", workspaceDir: "/tmp/ws",
    });

    graduateSession(
      {
        ...deps,
        credentialStore: {
          getNonTurnModel: () => undefined,
          listCredentialRoutes: () => [],
          getCredentialSecret: () => undefined,
        } as never,
        chatHistoryManager: {
          append: (_s: string, m: unknown) => appended.push(m),
          replaceInProgress: () => {},
          updateNonTurnFailureCard: () => true,
        } as never,
      },
      { sessionId: "s1", userText: "hi", agentId: "claude" },
    );

    await flush(() => state.branchRenamed === true);

    expect(generateSessionName).toHaveBeenCalledWith("hi", { harnessId: "claude" });
    expect(state.title).toBe("T");
    expect(appended).toHaveLength(0);
  });

  it("records an unattributed, unpriced usage row when nothing is eligible", async () => {
    const generateSessionName = vi.fn(async () => ({
      name: { slug: "s", title: "T" },
      usage: { durationMs: 900, inputTokens: 1200, outputTokens: 40, cacheReadTokens: 30, costUsd: 0.02 },
    }));
    vi.doMock("../session-namer.js", () => ({ generateSessionName }));
    const recorded: { sessionId: string; costUsd: number; extra?: Record<string, unknown> }[] = [];
    const { graduateSession } = await import("./graduate-session.js");
    const { deps } = buildDeps({
      id: "s1", title: "placeholder", branch: "shipit/abc123", workspaceDir: "/tmp/ws",
    });

    graduateSession(
      {
        ...deps,
        credentialStore: {
          getNonTurnModel: () => undefined,
          listCredentialRoutes: () => [],
          getCredentialSecret: () => undefined,
        } as never,
        usageManager: {
          record: (
            sessionId: string,
            costUsd: number,
            _d: number,
            _i?: number,
            _o?: number,
            extra?: Record<string, unknown>,
          ) => {
            recorded.push({ sessionId, costUsd, extra });
            return costUsd;
          },
        } as never,
      },
      { sessionId: "s1", userText: "hi", agentId: "claude" },
    );

    await flush(() => recorded.length > 0);

    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.sessionId).toBe("s1");
    expect(recorded[0]!.costUsd).toBe(0);
    expect(recorded[0]!.extra?.attribution).toBeUndefined();
    expect(recorded[0]!.extra?.model).toBeUndefined();
    expect(recorded[0]!.extra?.subAgentId).toBe("claude");
    expect(recorded[0]!.extra?.costSource).toBe("per-turn");
    expect(recorded[0]!.extra?.cacheRead).toBe(30);
  });

  it("records nothing when an unattributed naming run reports no tokens", async () => {
    const generateSessionName = vi.fn(async () => ({
      name: { slug: "s", title: "T" },
      usage: { durationMs: 900, costUsd: 0.02 },
    }));
    vi.doMock("../session-namer.js", () => ({ generateSessionName }));
    const recorded: unknown[] = [];
    const { graduateSession } = await import("./graduate-session.js");
    const { deps, state } = buildDeps({
      id: "s1", title: "placeholder", branch: "shipit/abc123", workspaceDir: "/tmp/ws",
    });

    graduateSession(
      {
        ...deps,
        credentialStore: {
          getNonTurnModel: () => undefined,
          listCredentialRoutes: () => [],
          getCredentialSecret: () => undefined,
        } as never,
        usageManager: { record: (...args: unknown[]) => { recorded.push(args); return 0; } } as never,
      },
      { sessionId: "s1", userText: "hi", agentId: "claude" },
    );

    await flush(() => state.branchRenamed === true);

    expect(recorded).toHaveLength(0);
  });

  // The shape that made naming fail before the direct path existed: the choice
  // is reachable ONLY as a direct call, so a harness-only search finds nothing
  // and reports a stale pin against a credential that is present and working.
  it("names on a direct-only choice, with no harness installed and no notice", async () => {
    const generateSessionName = vi.fn(async () => ({ name: null }));
    vi.doMock("../../shared/installed-harnesses.js", () => ({
      isHarnessInstalled: () => false,
      readInstalledHarnesses: () => [],
    }));
    await mockCliNaming(generateSessionName);
    const appended: unknown[] = [];
    const { graduateSession } = await import("./graduate-session.js");
    const { deps, state } = buildDeps({
      id: "s1", title: "placeholder", branch: "shipit/abc123", workspaceDir: "/tmp/ws",
    });
    const { impl, calls } = fakeFetch(() => ({ status: 200, body: NAMED_OK }));

    graduateSession(
      {
        ...deps,
        credentialStore: directKeyStore(),
        fetchImpl: impl,
        chatHistoryManager: {
          append: (_s: string, m: unknown) => appended.push(m),
          replaceInProgress: () => {},
          updateNonTurnFailureCard: () => true,
        } as never,
      },
      { sessionId: "s1", userText: "Add a login page", agentId: "claude" },
    );

    await flush(() => state.branchRenamed === true);

    expect(calls).toHaveLength(1);
    expect(generateSessionName).not.toHaveBeenCalled();
    expect(state.title).toBe("Add Login Page");
    expect(appended).toHaveLength(0);
    vi.doUnmock("../../shared/installed-harnesses.js");
  });

  // A direct call needs no container, so naming must not wait on one (req 4).
  it("names through a direct call with no runner for the session", async () => {
    await mockCliNaming(vi.fn(async () => ({ name: null })));
    const { graduateSession } = await import("./graduate-session.js");
    const { deps, state } = buildDeps({
      id: "s1", title: "placeholder", branch: "shipit/abc123", workspaceDir: "/tmp/ws",
    });
    const { impl } = fakeFetch(() => ({ status: 200, body: NAMED_OK }));

    graduateSession(
      {
        ...deps,
        credentialStore: directKeyStore(),
        fetchImpl: impl,
        runnerRegistry: { get: () => undefined } as never,
      },
      { sessionId: "s1", userText: "Add a login page", agentId: "claude" },
    );

    await flush(() => state.branchRenamed === true);

    expect(state.title).toBe("Add Login Page");
  });

  it("still names through the CLI when the choice is a harness-only credential", async () => {
    const generateSessionName = vi.fn(async (_m: string, _t: unknown) => ({
      name: { slug: "via-cli", title: "Via CLI" },
    }));
    await mockCliNaming(generateSessionName);
    const { graduateSession } = await import("./graduate-session.js");
    const { deps, state } = buildDeps({
      id: "s1", title: "placeholder", branch: "shipit/abc123", workspaceDir: "/tmp/ws",
    });
    const { impl, calls } = fakeFetch(() => ({ status: 200, body: NAMED_OK }));

    graduateSession(
      {
        ...deps,
        // Anthropic's subscription token is restricted to Claude Code, so the
        // catalogue declares no direct call for it (docs/299 reqs 1 and 3).
        credentialStore: {
          getNonTurnModel: () => ({ serviceId: "anthropic", billingMode: "sub", modelId: "haiku" }),
          listCredentialRoutes: () => [
            { id: "anthropic-sub", serviceId: "anthropic", billingMode: "sub", via: "string" },
          ],
          getCredentialRoute: (id: string) => ({ id, serviceId: "anthropic", billingMode: "sub", via: "string" }),
          getCredentialSecret: () => "tok-sub",
          getSelectionMode: () => "ordered",
          getFailoverCutoffs: () => ({}),
        } as never,
        fetchImpl: impl,
      },
      { sessionId: "s1", userText: "hi", agentId: "claude" },
    );

    await flush(() => state.branchRenamed === true);

    expect(calls).toHaveLength(0);
    expect(generateSessionName).toHaveBeenCalledTimes(1);
    expect(generateSessionName.mock.calls[0]![1]).toMatchObject({ harnessId: "claude", model: "haiku" });
    expect(state.title).toBe("Via CLI");
  });

  it("names through a direct provider call, with no harness and no CLI", async () => {
    const generateSessionName = vi.fn(async () => ({ name: { slug: "cli", title: "From the CLI" } }));
    await mockCliNaming(generateSessionName);
    const { graduateSession } = await import("./graduate-session.js");
    const { deps, spies, state } = buildDeps({
      id: "s1", title: "placeholder", branch: "shipit/abc123", workspaceDir: "/tmp/ws",
    });
    const { impl, calls } = fakeFetch(() => ({ status: 200, body: NAMED_OK }));

    graduateSession(
      { ...deps, credentialStore: directKeyStore(), fetchImpl: impl },
      { sessionId: "s1", userText: "Add a login page", agentId: "claude" },
    );

    await flush(() => state.branchRenamed === true);

    expect(generateSessionName).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.anthropic.com/v1/messages");
    // The catalogue row is Claude Code's alias; the Messages API takes the vendor id.
    expect(calls[0]!.body.model).toBe("claude-haiku-4-5");
    expect(JSON.stringify(calls[0]!.body.messages)).toContain("Add a login page");
    expect(state.title).toBe("Add Login Page");
    expect(spies.renameBranch).toHaveBeenCalledWith("shipit/abc123", "shipit/add-login-abc123");
  });

  it("records a direct naming run as background work billed to the selection", async () => {
    await mockCliNaming(vi.fn(async () => ({ name: null })));
    const recorded: { sessionId: string; extra?: Record<string, unknown> }[] = [];
    const { graduateSession } = await import("./graduate-session.js");
    const { deps, state } = buildDeps({
      id: "s1", title: "placeholder", branch: "shipit/abc123", workspaceDir: "/tmp/ws",
    });
    const { impl } = fakeFetch(() => ({ status: 200, body: NAMED_OK }));

    graduateSession(
      {
        ...deps,
        credentialStore: directKeyStore(),
        fetchImpl: impl,
        usageManager: {
          record: (sessionId: string, _c: number, _d: number, _i?: number, _o?: number, extra?: Record<string, unknown>) => {
            recorded.push({ sessionId, extra });
            return 0;
          },
        } as never,
      },
      { sessionId: "s1", userText: "hi", agentId: "claude" },
    );

    await flush(() => state.branchRenamed === true);

    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.sessionId).toBe("s1");
    // No harness ran it, so the row says background work in its own field.
    expect(recorded[0]!.extra?.subAgentId).toBeUndefined();
    expect(recorded[0]!.extra?.backgroundWork).toBe(true);
    expect(recorded[0]!.extra?.model).toBe("haiku");
    expect(recorded[0]!.extra?.attribution).toMatchObject({ serviceId: "anthropic", billingMode: "key" });
    expect(recorded[0]!.extra?.cacheRead).toBe(4);
  });

  it("persists exactly one notice when a direct naming call fails", async () => {
    await mockCliNaming(vi.fn(async () => ({ name: null })));
    const appended: { nonTurnFailure?: { serviceName?: string; purpose?: string } }[] = [];
    const { graduateSession } = await import("./graduate-session.js");
    const { deps, state } = buildDeps({
      id: "s1", title: "placeholder", branch: "shipit/abc123", workspaceDir: "/tmp/ws",
    });
    const { impl } = fakeFetch(() => ({ status: 500, body: '{"error":"overloaded"}' }));

    graduateSession(
      {
        ...deps,
        credentialStore: directKeyStore(),
        fetchImpl: impl,
        runnerRegistry: { get: () => undefined } as never,
        chatHistoryManager: {
          append: (_s: string, m: unknown) => appended.push(m as never),
          replaceInProgress: () => {},
          updateNonTurnFailureCard: () => true,
        } as never,
      },
      { sessionId: "s1", userText: "hi", agentId: "claude" },
    );

    await flush(() => state.branchRenamed === true);

    expect(appended).toHaveLength(1);
    expect(appended[0].nonTurnFailure?.purpose).toBe("session-naming");
    expect(appended[0].nonTurnFailure?.serviceName).toBe("Anthropic");
    expect(state.title).toBe("hi");
  });

  it("reports a direct answer that carries no usable title, and still bills it", async () => {
    await mockCliNaming(vi.fn(async () => ({ name: null })));
    const appended: { nonTurnFailure?: { detail?: string } }[] = [];
    const recorded: unknown[] = [];
    const { graduateSession } = await import("./graduate-session.js");
    const { deps, state } = buildDeps({
      id: "s1", title: "placeholder", branch: "shipit/abc123", workspaceDir: "/tmp/ws",
    });
    const { impl } = fakeFetch(() => ({
      status: 200,
      body: JSON.stringify({
        content: [{ type: "text", text: "Sorry, I cannot." }],
        usage: { input_tokens: 90, output_tokens: 6 },
      }),
    }));

    graduateSession(
      {
        ...deps,
        credentialStore: directKeyStore(),
        fetchImpl: impl,
        runnerRegistry: { get: () => undefined } as never,
        chatHistoryManager: {
          append: (_s: string, m: unknown) => appended.push(m as never),
          replaceInProgress: () => {},
          updateNonTurnFailureCard: () => true,
        } as never,
        usageManager: { record: (...args: unknown[]) => { recorded.push(args); return 0; } } as never,
      },
      { sessionId: "s1", userText: "hi", agentId: "claude" },
    );

    await flush(() => state.branchRenamed === true);

    expect(appended).toHaveLength(1);
    expect(appended[0].nonTurnFailure?.detail).toContain("no usable title");
    // The provider billed the run whether or not its answer was usable.
    expect(recorded).toHaveLength(1);
  });

  it("stops naming and persists a notice for a stale pin", async () => {
    const generateSessionName = vi.fn(async () => ({ name: { slug: "s", title: "T" } }));
    vi.doMock("../session-namer.js", () => ({ generateSessionName }));
    const appended: { nonTurnFailure?: { serviceName?: string; purpose?: string } }[] = [];
    const { graduateSession } = await import("./graduate-session.js");
    const { deps, state } = buildDeps({
      id: "s1", title: "placeholder", branch: "shipit/abc123", workspaceDir: "/tmp/ws",
    });

    graduateSession(
      {
        ...deps,
        credentialStore: {
          getNonTurnModel: () => ({ serviceId: "openai", billingMode: "key", modelId: "gpt-5.4-mini" }),
          listCredentialRoutes: () => [],
          getCredentialSecret: () => undefined,
        } as never,
        chatHistoryManager: {
          append: (_s: string, m: unknown) => appended.push(m as never),
          replaceInProgress: () => {},
          updateNonTurnFailureCard: () => true,
        } as never,
      },
      { sessionId: "s1", userText: "hi", agentId: "claude" },
    );

    await flush(() => state.branchRenamed === true);

    expect(generateSessionName).not.toHaveBeenCalled();
    expect(state.title).toBe("hi");
    expect(appended).toHaveLength(1);
    expect(appended[0].nonTurnFailure?.serviceName).toBe("OpenAI");
    expect(appended[0].nonTurnFailure?.purpose).toBe("session-naming");
  });
});
