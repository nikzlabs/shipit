import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { CredentialRoute, NonTurnFailureCard, WsServerMessage } from "../../shared/types.js";
import type { PersistedMessage } from "../chat-history.js";
import type { SubAgentRunResult } from "../../shared/sub-agent-run.js";
import { TEST_CREDENTIALS_DIR } from "../credentials-test-helpers.js";

function keyRoute(serviceId: string): CredentialRoute {
  return {
    id: `${serviceId}-key`,
    serviceId,
    billingMode: "key",
    via: "string",
    status: "ready",
    priority: 0,
    isPrimary: true,
    label: "test",
    createdAt: 0,
    updatedAt: 0,
  };
}

interface Harness {
  emitted: WsServerMessage[];
  appended: PersistedMessage[];
  replaced: PersistedMessage[][];
  recorded: { sessionId: string; costUsd: number; extra?: Record<string, unknown> }[];
}

function buildDeps(opts: {
  routes?: CredentialRoute[];
  spawn?: (...args: never[]) => Promise<SubAgentRunResult>;
  noRunner?: boolean;
  running?: boolean;
}) {
  const h: Harness = { emitted: [], appended: [], replaced: [], recorded: [] };
  const runner = {
    emitMessage: (m: WsServerMessage) => h.emitted.push(m),
    running: opts.running ?? false,
    chatMessageGroups: [],
    recordedCards: [] as unknown[],
    steeredMessages: [],
    getTurnEventBuffer: () => [],
    lastPersistedBufferIndex: 0,
    spawnSubAgent: opts.spawn ?? (() => Promise.reject(new Error("no spawn configured"))),
  };
  const routes = opts.routes ?? [keyRoute("deepseek")];
  const deps = {
    credentialStore: {
      getNonTurnModel: () => undefined,
      listCredentialRoutes: (serviceId?: string, billingMode?: string) =>
        routes.filter(
          (r) =>
            (serviceId === undefined || r.serviceId === serviceId)
            && (billingMode === undefined || r.billingMode === billingMode),
        ),
      getCredentialSecret: () => "sk-test",
      getCredentialRoute: (id: string) => routes.find((r) => r.id === id),
    },
    getRunnerRegistry: () => ({ get: () => (opts.noRunner ? undefined : runner) }),
    chatHistoryManager: {
      append: (sessionId: string, m: PersistedMessage) => h.appended.push(m),
      replaceInProgress: (_sessionId: string, ms: PersistedMessage[]) => h.replaced.push(ms),
      updateNonTurnFailureCard: () => true,
    },
    usageManager: {
      record: (sessionId: string, costUsd: number, _d: number, _i?: number, _o?: number, extra?: Record<string, unknown>) => {
        h.recorded.push({ sessionId, costUsd, extra });
        return costUsd;
      },
    },
  };
  return { deps: deps as never, h };
}

const OK_RESULT: SubAgentRunResult = {
  status: "success",
  text: "## Summary\n\nDid a thing.",
  truncated: false,
  durationMs: 1200,
  costUsd: 0,
  inputTokens: 1000,
  outputTokens: 300,
};

describe("makeNonTurnGenerateText", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doMock("../../shared/installed-harnesses.js", () => ({
      isHarnessInstalled: () => true,
      readInstalledHarnesses: () => ["claude", "codex"],
    }));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock("../../shared/installed-harnesses.js");
  });

  it("delegates to the fallback when the caller names no session", async () => {
    const { makeNonTurnGenerateText } = await import("./non-turn-work.js");
    const { deps } = buildDeps({});
    const fallback = vi.fn(async () => "from the fallback");
    const generate = makeNonTurnGenerateText({ ...(deps as object), fallback } as never);

    expect(await generate("prompt", "/ws")).toBe("from the fallback");
    expect(fallback).toHaveBeenCalledOnce();
  });

  it("spawns the resolved model and returns its text", async () => {
    const { makeNonTurnGenerateText } = await import("./non-turn-work.js");
    const spawn = vi.fn(async () => OK_RESULT);
    const { deps } = buildDeps({ spawn });
    const generate = makeNonTurnGenerateText({
      ...(deps as object),
      fallback: async () => "unused",
    } as never);

    const text = await generate("prompt", "/ws", { sessionId: "s1", purpose: "pr-description" });

    expect(text).toBe(OK_RESULT.text);
    const req = (spawn.mock.calls as unknown as [{ agentId: string; model: string; serviceRouting?: unknown }][])[0][0];
    expect(req.agentId).toBe("claude");
    expect(req.model).toBe("deepseek-flash");
    expect(req.serviceRouting).toBeTruthy();
  });

  it("records a usage row with the run's own attribution", async () => {
    const { makeNonTurnGenerateText } = await import("./non-turn-work.js");
    const { deps, h } = buildDeps({ spawn: async () => OK_RESULT });
    const generate = makeNonTurnGenerateText({
      ...(deps as object),
      fallback: async () => "unused",
    } as never);

    await generate("prompt", "/ws", { sessionId: "s1", purpose: "pr-description" });

    expect(h.recorded).toHaveLength(1);
    const row = h.recorded[0];
    expect(row.sessionId).toBe("s1");
    expect(row.extra?.subAgentId).toBe("claude");
    expect(row.extra?.attribution).toMatchObject({ serviceId: "deepseek", billingMode: "key" });
    expect(row.costUsd).toBeGreaterThan(0);
    expect(row.extra?.costSource).toBe("per-turn");
  });

  it("records nothing when the harness reported no telemetry", async () => {
    const { makeNonTurnGenerateText } = await import("./non-turn-work.js");
    const { deps, h } = buildDeps({
      spawn: async () => ({ ...OK_RESULT, durationMs: 0, inputTokens: undefined, outputTokens: undefined }),
    });
    const generate = makeNonTurnGenerateText({
      ...(deps as object),
      fallback: async () => "unused",
    } as never);

    await generate("prompt", "/ws", { sessionId: "s1", purpose: "pr-description" });

    expect(h.recorded).toHaveLength(0);
  });

  it("returns empty and persists a notice when the run fails", async () => {
    const { makeNonTurnGenerateText } = await import("./non-turn-work.js");
    const { deps, h } = buildDeps({
      spawn: async () => ({ ...OK_RESULT, status: "error", text: "", error: "401 Unauthorized" }),
    });
    const generate = makeNonTurnGenerateText({
      ...(deps as object),
      fallback: async () => "unused",
    } as never);

    const text = await generate("prompt", "/ws", { sessionId: "s1", purpose: "pr-description" });

    expect(text).toBe("");
    expect(h.appended).toHaveLength(1);
    const card = h.appended[0].nonTurnFailure;
    expect(card?.purpose).toBe("pr-description");
    expect(card?.serviceName).toBe("DeepSeek");
    expect(card?.detail).toContain("401");
    expect(h.emitted.some((m) => m.type === "non_turn_failure_card")).toBe(true);
  });

  it("treats a blank generation as a failure", async () => {
    const { makeNonTurnGenerateText } = await import("./non-turn-work.js");
    const { deps, h } = buildDeps({ spawn: async () => ({ ...OK_RESULT, text: "   " }) });
    const generate = makeNonTurnGenerateText({
      ...(deps as object),
      fallback: async () => "unused",
    } as never);

    expect(await generate("prompt", "/ws", { sessionId: "s1" })).toBe("");
    expect(h.appended).toHaveLength(1);
  });

  it("reports a missing runner rather than booting a container", async () => {
    const { makeNonTurnGenerateText } = await import("./non-turn-work.js");
    const { deps, h } = buildDeps({ noRunner: true });
    const generate = makeNonTurnGenerateText({
      ...(deps as object),
      fallback: async () => "unused",
    } as never);

    expect(await generate("prompt", "/ws", { sessionId: "s1" })).toBe("");
    expect(h.appended).toHaveLength(1);
  });

  it("falls back to the pre-feature generator when nothing at all is eligible", async () => {
    const { makeNonTurnGenerateText } = await import("./non-turn-work.js");
    const { deps, h } = buildDeps({ routes: [] });
    const fallback = vi.fn(async () => "from the fallback");
    const generate = makeNonTurnGenerateText({ ...(deps as object), fallback } as never);

    expect(await generate("prompt", "/ws", { sessionId: "s1" })).toBe("from the fallback");
    expect(h.appended).toHaveLength(0);
    expect(h.emitted).toHaveLength(0);
  });

  it("stops and reports a stale pin rather than falling back", async () => {
    const { makeNonTurnGenerateText } = await import("./non-turn-work.js");
    const { deps, h } = buildDeps({ routes: [] });
    Object.assign((deps as { credentialStore: Record<string, unknown> }).credentialStore, {
      getNonTurnModel: () => ({ serviceId: "openai", billingMode: "key", modelId: "gpt-5.4-mini" }),
    });
    const fallback = vi.fn(async () => "from the fallback");
    const generate = makeNonTurnGenerateText({ ...(deps as object), fallback } as never);

    expect(await generate("prompt", "/ws", { sessionId: "s1" })).toBe("");
    expect(fallback).not.toHaveBeenCalled();
    expect(h.appended).toHaveLength(1);
    expect(h.appended[0].nonTurnFailure?.serviceName).toBe("OpenAI");
    expect(h.appended[0].nonTurnFailure?.pinned).toBe(true);
  });
});

// Own properties bypass real accessors while preserving instanceof for credential provisioning.
function fakeContainerRunner(
  ctor: new (...args: never[]) => unknown,
  over: Record<string, unknown>,
): unknown {
  const runner = Object.create(ctor.prototype) as object;
  const fields: Record<string, unknown> = {
    emitMessage: () => {},
    running: false,
    chatMessageGroups: [],
    recordedCards: [],
    steeredMessages: [],
    getTurnEventBuffer: () => [],
    lastPersistedBufferIndex: 0,
    ...over,
  };
  for (const [key, value] of Object.entries(fields)) {
    Object.defineProperty(runner, key, { value, writable: true, configurable: true });
  }
  return runner;
}

describe("makeNonTurnGenerateText — credential window", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doMock("../../shared/installed-harnesses.js", () => ({
      isHarnessInstalled: () => true,
      readInstalledHarnesses: () => ["claude", "codex"],
    }));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock("../../shared/installed-harnesses.js");
    vi.doUnmock("../session-credentials.js");
  });

  it("gives a same-harness run an isolated spawn home and never borrows the session subtree", async () => {
    const calls: string[] = [];
    vi.doMock("../session-credentials.js", () => ({
      provisionSubAgentCredentials: () => calls.push("provision"),
      releaseSubAgentCredentials: () => {
        calls.push("wipe");
        return "acct_marker";
      },
      provisionSubAgentSpawnHome: () => calls.push("provision-home"),
      releaseSubAgentSpawnHome: () => calls.push("release-home"),
      subAgentSpawnHomeContainerDir: (spawnId: string) => `/credentials/sub-agent-homes/${spawnId}`,
      syncAgentTokenBack: () => calls.push("sync"),
      syncProviderAccountTokenBack: () => calls.push("sync-account"),
      provisionProviderAccountCredentials: () => calls.push("restore"),
    }));
    const { ContainerSessionRunner } = await import("../container-session-runner.js");
    const { makeNonTurnGenerateText } = await import("./non-turn-work.js");
    let seenHomeDir: string | undefined;
    const runner = fakeContainerRunner(ContainerSessionRunner, {
      spawnSubAgent: async (req: { spawnId: string; homeDir?: string }) => {
        calls.push("spawn");
        seenHomeDir = req.homeDir;
        return OK_RESULT;
      },
    });
    const { deps } = buildDeps({});
    const generate = makeNonTurnGenerateText({
      ...(deps as object),
      getRunnerRegistry: () => ({ get: () => runner }),
      sessionManager: { get: () => ({ agentId: "claude" }) },
      credentialsDir: TEST_CREDENTIALS_DIR,
      fallback: async () => "unused",
    } as never);

    await generate("prompt", "/ws", { sessionId: "s1", purpose: "pr-description" });

    expect(calls).toEqual(["provision-home", "spawn", "release-home"]);
    expect(seenHomeDir).toMatch(/^\/credentials\/sub-agent-homes\//);
  });

  it("still borrows the session subtree for a cross-harness run, and restores on release", async () => {
    const calls: string[] = [];
    const restored: string[] = [];
    vi.doMock("../session-credentials.js", () => ({
      provisionSubAgentCredentials: () => calls.push("provision"),
      releaseSubAgentCredentials: () => {
        calls.push("wipe");
        return "acct_marker";
      },
      provisionSubAgentSpawnHome: () => calls.push("provision-home"),
      releaseSubAgentSpawnHome: () => calls.push("release-home"),
      subAgentSpawnHomeContainerDir: (spawnId: string) => `/credentials/sub-agent-homes/${spawnId}`,
      syncAgentTokenBack: () => calls.push("sync"),
      syncProviderAccountTokenBack: () => calls.push("sync-account"),
      provisionProviderAccountCredentials: (
        _dir: string, _sessionId: string, _agentId: string, accountId: string,
      ) => {
        calls.push("restore");
        restored.push(accountId);
      },
    }));
    const { ContainerSessionRunner } = await import("../container-session-runner.js");
    const { makeNonTurnGenerateText } = await import("./non-turn-work.js");
    const runner = fakeContainerRunner(ContainerSessionRunner, {
      spawnSubAgent: async () => {
        calls.push("spawn");
        return OK_RESULT;
      },
    });
    const { deps } = buildDeps({});
    // Model a session changing harness between capture and release.
    const agentIds = ["codex", "claude"];
    const generate = makeNonTurnGenerateText({
      ...(deps as object),
      getRunnerRegistry: () => ({ get: () => runner }),
      sessionManager: { get: () => ({ agentId: agentIds.length > 1 ? agentIds.shift() : agentIds[0] }) },
      credentialsDir: TEST_CREDENTIALS_DIR,
      fallback: async () => "unused",
    } as never);

    await generate("prompt", "/ws", { sessionId: "s1", purpose: "pr-description" });

    expect(calls).toEqual(["provision", "spawn", "sync", "wipe", "restore"]);
    expect(restored).toEqual(["acct_marker"]);
  });

  it("still wipes when the spawn throws", async () => {
    const calls: string[] = [];
    vi.doMock("../session-credentials.js", () => ({
      provisionSubAgentCredentials: () => calls.push("provision"),
      releaseSubAgentCredentials: () => {
        calls.push("wipe");
        return undefined;
      },
      provisionSubAgentSpawnHome: () => calls.push("provision-home"),
      releaseSubAgentSpawnHome: () => calls.push("release-home"),
      subAgentSpawnHomeContainerDir: (spawnId: string) => `/credentials/sub-agent-homes/${spawnId}`,
      syncAgentTokenBack: () => calls.push("sync"),
      syncProviderAccountTokenBack: () => calls.push("sync-account"),
      provisionProviderAccountCredentials: () => calls.push("restore"),
    }));
    const { ContainerSessionRunner } = await import("../container-session-runner.js");
    const { makeNonTurnGenerateText } = await import("./non-turn-work.js");
    const runner = fakeContainerRunner(ContainerSessionRunner, {
      spawnSubAgent: () => Promise.reject(new Error("worker gone")),
    });
    const { deps } = buildDeps({});
    const generate = makeNonTurnGenerateText({
      ...(deps as object),
      getRunnerRegistry: () => ({ get: () => runner }),
      credentialsDir: TEST_CREDENTIALS_DIR,
      fallback: async () => "unused",
    } as never);

    expect(await generate("prompt", "/ws", { sessionId: "s1" })).toBe("");
    expect(calls).toContain("wipe");
  });

  it("closes the credential window when provisioning itself throws", async () => {
    const calls: string[] = [];
    vi.doMock("../session-credentials.js", () => ({
      provisionSubAgentCredentials: () => calls.push("provision"),
      releaseSubAgentCredentials: () => {
        calls.push("wipe");
        return "acct_marker";
      },
      provisionSubAgentSpawnHome: () => {
        calls.push("provision-home");
        throw new Error("ENOSPC: no space left on device");
      },
      releaseSubAgentSpawnHome: () => calls.push("release-home"),
      subAgentSpawnHomeContainerDir: (spawnId: string) => `/credentials/sub-agent-homes/${spawnId}`,
      syncAgentTokenBack: () => calls.push("sync"),
      syncProviderAccountTokenBack: () => calls.push("sync-account"),
      provisionProviderAccountCredentials: () => calls.push("restore"),
    }));
    const { ContainerSessionRunner } = await import("../container-session-runner.js");
    const { makeNonTurnGenerateText } = await import("./non-turn-work.js");
    const runner = fakeContainerRunner(ContainerSessionRunner, {
      spawnSubAgent: async () => {
        calls.push("spawn");
        return OK_RESULT;
      },
    });
    const { deps } = buildDeps({});
    const generate = makeNonTurnGenerateText({
      ...(deps as object),
      getRunnerRegistry: () => ({ get: () => runner }),
      sessionManager: { get: () => ({ agentId: "claude" }) },
      credentialsDir: TEST_CREDENTIALS_DIR,
      fallback: async () => "unused",
    } as never);

    expect(await generate("prompt", "/ws", { sessionId: "s1" })).toBe("");
    expect(calls).toEqual(["provision-home", "release-home"]);
  });
});

describe("dismissNonTurnFailure", () => {
  it("patches the persisted row and broadcasts rather than deleting it", async () => {
    const { dismissNonTurnFailure } = await import("./non-turn-work.js");
    const emitted: WsServerMessage[] = [];
    const patches: { cardId: string; patch: Record<string, unknown> }[] = [];
    const ok = dismissNonTurnFailure(
      {
        getRunnerRegistry: () => ({ get: () => ({ emitMessage: (m: WsServerMessage) => emitted.push(m) }) }),
        chatHistoryManager: {
          updateNonTurnFailureCard: (_s: string, cardId: string, patch: Record<string, unknown>) => {
            patches.push({ cardId, patch });
            return true;
          },
        },
      } as never,
      "s1",
      "card-1",
    );

    expect(ok).toBe(true);
    expect(patches[0].cardId).toBe("card-1");
    expect(patches[0].patch.dismissedAt).toBeTruthy();
    expect(emitted[0].type).toBe("non_turn_failure_dismissed");
  });

  it("patches the recorded card, not just the row, while its turn is still running", async () => {
    const { dismissNonTurnFailure } = await import("./non-turn-work.js");
    const dbPatches: string[] = [];
    const replaced: PersistedMessage[][] = [];
    const runner = {
      emitMessage: () => {},
      running: true,
      chatMessageGroups: [],
      steeredMessages: [],
      recordedCards: [
        {
          afterGroupIndex: 0,
          message: {
            role: "assistant" as const,
            text: "",
            nonTurnFailure: {
              cardId: "card-1",
              purpose: "session-naming",
              fallback: "kept the placeholder",
              createdAt: "2026-08-09T00:00:00.000Z",
            } as NonTurnFailureCard,
          },
        },
      ],
      getTurnEventBuffer: () => [],
      lastPersistedBufferIndex: 0,
    };

    const ok = dismissNonTurnFailure(
      {
        getRunnerRegistry: () => ({ get: () => runner }),
        chatHistoryManager: {
          replaceInProgress: (_s: string, ms: PersistedMessage[]) => replaced.push(ms),
          updateNonTurnFailureCard: () => {
            dbPatches.push("db");
            return true;
          },
        },
      } as never,
      "s1",
      "card-1",
    );

    expect(ok).toBe(true);
    const patched = runner.recordedCards[0].message.nonTurnFailure as { dismissedAt?: string };
    expect(patched.dismissedAt).toBeTruthy();
    expect(replaced).toHaveLength(1);
    expect(dbPatches).toHaveLength(0);
  });

  it("reports false for a card that is not in this session", async () => {
    const { dismissNonTurnFailure } = await import("./non-turn-work.js");
    const ok = dismissNonTurnFailure(
      {
        getRunnerRegistry: () => undefined,
        chatHistoryManager: { updateNonTurnFailureCard: () => false },
      } as never,
      "s1",
      "nope",
    );
    expect(ok).toBe(false);
  });
});

describe("recordNonTurnUsage with no resolved target", () => {
  function recorder() {
    const rows: { costUsd: number; extra?: Record<string, unknown> }[] = [];
    return {
      rows,
      deps: {
        usageManager: {
          record: (
            _s: string,
            costUsd: number,
            _d: number,
            _i?: number,
            _o?: number,
            extra?: Record<string, unknown>,
          ) => {
            rows.push({ costUsd, extra });
            return costUsd;
          },
        },
      } as never,
    };
  }

  it("writes unattributed volume at a hard zero, not the harness's own figure", async () => {
    const { recordNonTurnUsage } = await import("./non-turn-work.js");
    const { rows, deps } = recorder();

    recordNonTurnUsage(deps, {
      sessionId: "s1",
      harnessId: "claude",
      purpose: "session-naming",
      telemetry: { durationMs: 800, costUsd: 0.017, inputTokens: 900, outputTokens: 25 },
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]!.costUsd).toBe(0);
    expect(rows[0]!.extra?.attribution).toBeUndefined();
    expect(rows[0]!.extra?.model).toBeUndefined();
    expect(rows[0]!.extra?.subAgentId).toBe("claude");
    expect(rows[0]!.extra?.costSource).toBe("per-turn");
  });

  it("writes the row for a harness that reports tokens and no cost", async () => {
    const { recordNonTurnUsage } = await import("./non-turn-work.js");
    const { rows, deps } = recorder();

    recordNonTurnUsage(deps, {
      sessionId: "s1",
      harnessId: "codex",
      purpose: "session-naming",
      telemetry: { durationMs: 800, inputTokens: 900, outputTokens: 25, cacheReadTokens: 40 },
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]!.costUsd).toBe(0);
    expect(rows[0]!.extra?.subAgentId).toBe("codex");
    expect(rows[0]!.extra?.cacheRead).toBe(40);
  });

  it("records nothing when only a dollar figure was reported", async () => {
    const { recordNonTurnUsage } = await import("./non-turn-work.js");
    const { rows, deps } = recorder();

    recordNonTurnUsage(deps, {
      sessionId: "s1",
      harnessId: "claude",
      purpose: "session-naming",
      telemetry: { durationMs: 800, costUsd: 0.017 },
    });

    expect(rows).toHaveLength(0);
  });
});
