import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { CredentialRoute, NonTurnFailureCard, WsServerMessage } from "../../shared/types.js";
import type { PersistedMessage } from "../chat-history.js";
import type { SubAgentRunResult } from "../../shared/sub-agent-run.js";
import { TEST_CREDENTIALS_DIR } from "../credentials-test-helpers.js";
import { DatabaseManager } from "../../shared/database.js";
import { UsageManager } from "../usage.js";
import { recordNonTurnUsage } from "./non-turn-work.js";

function keyRoute(serviceId: string, billingMode: "key" | "sub" = "key"): CredentialRoute {
  return {
    id: `${serviceId}-${billingMode}`,
    serviceId,
    billingMode,
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
  // Z.AI's coding plan declares no direct call, so the default fixture is a
  // credential background work has to carry on a harness.
  const routes = opts.routes ?? [keyRoute("zai", "sub")];
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
      getSelectionMode: () => "strict" as const,
      getFailoverCutoffs: () => ({ session: 90, weekly: 90 }),
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
    expect(req.model).toBe("glm-5.3[1m]");
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
    expect(row.extra?.attribution).toMatchObject({ serviceId: "zai", billingMode: "sub" });
    expect(row.costUsd).toBe(0);
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
    expect(card?.serviceName).toBe("GLM (Z.ai)");
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

describe("recordNonTurnUsage — what the selection says, not how it ran (docs/299-direct-provider-calls req 7)", () => {
  let dbManager: DatabaseManager;
  let usageManager: UsageManager;

  beforeEach(() => {
    dbManager = new DatabaseManager(":memory:");
    usageManager = new UsageManager(dbManager);
  });
  afterEach(() => {
    dbManager.close();
  });

  const telemetry = { durationMs: 900, inputTokens: 1_000_000, outputTokens: 0 };

  const rowsOf = (sessionId: string) =>
    dbManager.db.prepare("SELECT * FROM usage_turns WHERE session_id = ? ORDER BY id")
      .all(sessionId) as Record<string, unknown>[];

  // OpenCode Go is a `sub` mode carried by a pasted key over ordinary API
  // endpoints, so calling it directly is still subscription usage.
  it("keeps a direct call on a subscription as subscription usage, never metered spend", () => {
    recordNonTurnUsage({ usageManager }, {
      sessionId: "s1",
      purpose: "pr-description",
      target: { selection: { serviceId: "opencode", billingMode: "sub", modelId: "glm-5.3" } },
      telemetry,
    });

    const row = rowsOf("s1")[0];
    expect(row).toMatchObject({
      service_id: "opencode",
      billing_mode: "sub",
      cost_usd: 0,
      model: "glm-5.3",
      background_work: 1,
      sub_agent_id: null,
    });
    const group = usageManager.getSessionUsage("s1")!.groups!.find((g) => g.key === "opencode:sub")!;
    expect(group.costUsd).toBe(0);
    expect(group.atApiRatesUsd).toBeGreaterThan(0);
  });

  it("prices a direct call on a key from the catalogue, with no harness to report a cost", () => {
    recordNonTurnUsage({ usageManager }, {
      sessionId: "s1",
      purpose: "pr-description",
      target: { selection: { serviceId: "deepseek", billingMode: "key", modelId: "deepseek-flash" } },
      telemetry,
    });

    const row = rowsOf("s1")[0];
    expect(row.billing_mode).toBe("key");
    expect(row.cost_usd as number).toBeGreaterThan(0);
    expect(usageManager.getSessionUsage("s1")!.totals.meteredCostUsd).toBeGreaterThan(0);
  });

  it("keeps a direct call carrying a session id out of that session's context dial", () => {
    usageManager.record("s1", 0.1, 2000, 800, 100, { contextTokens: 1500, model: "claude-opus-5" });
    recordNonTurnUsage({ usageManager }, {
      sessionId: "s1",
      purpose: "session-naming",
      target: { selection: { serviceId: "deepseek", billingMode: "key", modelId: "deepseek-flash" } },
      telemetry: { ...telemetry, inputTokens: 4000 },
    });

    const dial = usageManager.getPerTurnUsage("s1");
    expect(dial).toHaveLength(1);
    expect(dial.at(-1)).toMatchObject({ contextTokens: 1500, model: "claude-opus-5" });
  });

  it("records work belonging to no session as install-level spend", () => {
    recordNonTurnUsage({ usageManager }, {
      sessionId: null,
      purpose: "pr-description",
      target: { selection: { serviceId: "deepseek", billingMode: "key", modelId: "deepseek-flash" } },
      telemetry,
    });

    const stats = usageManager.getStats();
    expect(stats.sessions).toEqual([]);
    expect(stats.groups.map((g) => g.key)).toEqual(["install:deepseek:key"]);
    expect(stats.totals.meteredCostUsd).toBeGreaterThan(0);
  });

  it("still names the harness that ran the work, where one did", () => {
    recordNonTurnUsage({ usageManager }, {
      sessionId: "s1",
      harnessId: "claude",
      purpose: "pr-description",
      target: { selection: { serviceId: "deepseek", billingMode: "key", modelId: "deepseek-flash" } },
      telemetry,
    });

    expect(rowsOf("s1")[0]).toMatchObject({ sub_agent_id: "claude", background_work: 1 });
  });
});

/**
 * docs/299-direct-provider-calls reqs 2, 4 and 7. Both cases below fail before this feature: the
 * no-session one returned the pre-feature fallback, and the reclaimed-container
 * one reported "The session's container was not running."
 */
describe("makeNonTurnGenerateText — a direct call needs no session and no container", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doMock("../../shared/installed-harnesses.js", () => ({
      isHarnessInstalled: () => false,
      readInstalledHarnesses: () => [],
    }));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock("../../shared/installed-harnesses.js");
  });

  interface DirectHarness {
    requests: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[];
    recorded: {
      sessionId: string | null;
      costUsd: number;
      inputTokens?: number;
      outputTokens?: number;
      extra?: Record<string, unknown>;
    }[];
    appended: PersistedMessage[];
  }

  function buildDirectDeps(opts: { reply?: () => Response; noRunner?: boolean } = {}) {
    const h: DirectHarness = { requests: [], recorded: [], appended: [] };
    const routes = [keyRoute("anthropic")];
    const fetchImpl = (async (url: string, init: { headers: Record<string, string>; body: string }) => {
      h.requests.push({ url, headers: init.headers, body: JSON.parse(init.body) as Record<string, unknown> });
      return opts.reply?.() ?? new Response(
        JSON.stringify({
          content: [{ type: "text", text: "## Summary\n\nDid a thing." }],
          usage: { input_tokens: 900, output_tokens: 40, cache_read_input_tokens: 10 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    const deps = {
      credentialStore: {
        getNonTurnModel: () => ({ serviceId: "anthropic", billingMode: "key", modelId: "haiku" }),
        listCredentialRoutes: (serviceId?: string, billingMode?: string) =>
          routes.filter(
            (r) =>
              (serviceId === undefined || r.serviceId === serviceId)
              && (billingMode === undefined || r.billingMode === billingMode),
          ),
        getCredentialSecret: () => "sk-direct",
        getCredentialRoute: (id: string) => routes.find((r) => r.id === id),
        getSelectionMode: () => "strict" as const,
        getFailoverCutoffs: () => ({ session: 90, weekly: 90 }),
      },
      getRunnerRegistry: () => ({ get: () => undefined }),
      chatHistoryManager: {
        append: (_s: string, m: PersistedMessage) => h.appended.push(m),
        replaceInProgress: () => {},
        updateNonTurnFailureCard: () => true,
      },
      usageManager: {
        record: (
          sessionId: string | null,
          costUsd: number,
          _d: number,
          inputTokens?: number,
          outputTokens?: number,
          extra?: Record<string, unknown>,
        ) => {
          h.recorded.push({ sessionId, costUsd, inputTokens, outputTokens, extra });
          return costUsd;
        },
      },
      fetchImpl,
    };
    return { deps: deps as never, h };
  }

  it("runs with no session open at all", async () => {
    const { makeNonTurnGenerateText } = await import("./non-turn-work.js");
    const { deps, h } = buildDirectDeps();
    const fallback = vi.fn(async () => "from the fallback");
    const generate = makeNonTurnGenerateText({ ...(deps as object), fallback } as never);

    const text = await generate("prompt", "/ws", { purpose: "pr-description" });

    expect(text).toContain("Did a thing");
    expect(fallback).not.toHaveBeenCalled();
    expect(h.recorded).toHaveLength(1);
    // Install-level spend: real money that belongs to no session.
    expect(h.recorded[0].sessionId).toBeNull();
  });

  it("runs with the session's container reclaimed", async () => {
    const { makeNonTurnGenerateText } = await import("./non-turn-work.js");
    const { deps, h } = buildDirectDeps({ noRunner: true });
    const generate = makeNonTurnGenerateText({
      ...(deps as object),
      fallback: async () => "unused",
    } as never);

    const text = await generate("prompt", "/ws", { sessionId: "s1", purpose: "pr-description" });

    expect(text).toContain("Did a thing");
    expect(h.appended).toHaveLength(0);
    expect(h.recorded[0].sessionId).toBe("s1");
  });

  it("sends the API's model id to the joined endpoint with the resolved key", async () => {
    const { makeNonTurnGenerateText } = await import("./non-turn-work.js");
    const { deps, h } = buildDirectDeps();
    const generate = makeNonTurnGenerateText({
      ...(deps as object),
      fallback: async () => "unused",
    } as never);

    await generate("write a description", "/ws", { sessionId: "s1" });

    expect(h.requests).toHaveLength(1);
    expect(h.requests[0].url).toBe("https://api.anthropic.com/v1/messages");
    expect(h.requests[0].headers["x-api-key"]).toBe("sk-direct");
    expect(h.requests[0].body.model).toBe("claude-haiku-4-5");
    expect(h.requests[0].body.messages).toEqual([{ role: "user", content: "write a description" }]);
  });

  it("records what was selected and never a harness that did not run", async () => {
    const { makeNonTurnGenerateText } = await import("./non-turn-work.js");
    const { deps, h } = buildDirectDeps();
    const generate = makeNonTurnGenerateText({
      ...(deps as object),
      fallback: async () => "unused",
    } as never);

    await generate("prompt", "/ws", { sessionId: "s1", purpose: "session-naming" });

    const row = h.recorded[0];
    expect(row.extra?.subAgentId).toBeUndefined();
    expect(row.extra?.backgroundWork).toBe(true);
    expect(row.extra?.attribution).toMatchObject({ serviceId: "anthropic", billingMode: "key" });
    expect(row.extra?.model).toBe("haiku");
    expect(row.extra?.cacheRead).toBe(10);
    expect(row.inputTokens).toBe(900);
    expect(row.outputTokens).toBe(40);
    expect(row.costUsd).toBeGreaterThan(0);
  });

  it("persists a failure notice for the session that asked, and returns nothing", async () => {
    const { makeNonTurnGenerateText } = await import("./non-turn-work.js");
    const { deps, h } = buildDirectDeps({
      reply: () => new Response("no key", { status: 401 }),
    });
    const generate = makeNonTurnGenerateText({
      ...(deps as object),
      fallback: async () => "unused",
    } as never);

    expect(await generate("prompt", "/ws", { sessionId: "s1" })).toBe("");
    expect(h.appended).toHaveLength(1);
    expect(h.appended[0].nonTurnFailure?.serviceName).toBe("Anthropic");
    expect(h.appended[0].nonTurnFailure?.detail).toContain("401");
    expect(h.recorded).toHaveLength(0);
  });

  it("still records what a textless answer was billed", async () => {
    // HTTP 200, all the tokens spent, no answer: the run failed and the money
    // is real, so it has to appear in the totals exactly once (docs/299-direct-provider-calls req 7).
    const { makeNonTurnGenerateText } = await import("./non-turn-work.js");
    const { deps, h } = buildDirectDeps({
      reply: () => new Response(
        JSON.stringify({
          content: [],
          stop_reason: "max_tokens",
          usage: { input_tokens: 900, output_tokens: 4000 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    });
    const generate = makeNonTurnGenerateText({
      ...(deps as object),
      fallback: async () => "unused",
    } as never);

    expect(await generate("prompt", "/ws", { sessionId: "s1" })).toBe("");
    expect(h.appended).toHaveLength(1);
    expect(h.recorded).toHaveLength(1);
    expect(h.recorded[0].extra?.attribution).toMatchObject({ serviceId: "anthropic" });
    expect(h.recorded[0].inputTokens).toBe(900);
    expect(h.recorded[0].outputTokens).toBe(4000);
    expect(h.recorded[0].costUsd).toBeGreaterThan(0);
  });

  it("charges a billed failure with no session to the install", async () => {
    const { makeNonTurnGenerateText } = await import("./non-turn-work.js");
    const { deps, h } = buildDirectDeps({
      reply: () => new Response(
        JSON.stringify({
          content: [],
          stop_reason: "max_tokens",
          usage: { input_tokens: 900, output_tokens: 4000 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    });
    const generate = makeNonTurnGenerateText({
      ...(deps as object),
      fallback: async () => "unused",
    } as never);

    expect(await generate("prompt", "/ws")).toBe("");
    expect(h.appended).toHaveLength(0);
    expect(h.recorded).toHaveLength(1);
    expect(h.recorded[0].sessionId).toBeNull();
    expect(h.recorded[0].outputTokens).toBe(4000);
  });

  it("writes no card for a failure belonging to no session", async () => {
    const { makeNonTurnGenerateText } = await import("./non-turn-work.js");
    const { deps, h } = buildDirectDeps({
      reply: () => new Response("no key", { status: 401 }),
    });
    const generate = makeNonTurnGenerateText({
      ...(deps as object),
      fallback: async () => "unused",
    } as never);

    expect(await generate("prompt", "/ws")).toBe("");
    expect(h.appended).toHaveLength(0);
  });
});

/**
 * The executor is shared with voice cleanup, which must write nothing to the
 * chat transcript (docs/299-direct-provider-calls req 6). So it reports a failure to its caller and
 * renders nothing itself; the caller that wants a card emits one.
 */
describe("runNonTurnDirect — reports failure, never renders it", () => {
  const target = {
    execution: "direct" as const,
    selection: { serviceId: "anthropic", billingMode: "key" as const, modelId: "haiku" },
    serviceName: "Anthropic",
    source: "default" as const,
    call: {
      style: "anthropic-messages" as const,
      baseUrl: "https://api.anthropic.com",
      apiModelId: "claude-haiku-4-5",
      storageEnv: "ANTHROPIC_API_KEY",
    },
    apiKey: "sk-direct",
  };

  it("returns the reason rather than empty text", async () => {
    const { runNonTurnDirect } = await import("./non-turn-work.js");
    const fetchImpl = (async () => new Response("no key", { status: 401 })) as unknown as typeof fetch;

    const outcome = await runNonTurnDirect({ fetchImpl }, {
      sessionId: "s1",
      purpose: "voice-cleanup",
      target,
      prompt: "clean this",
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected a failure");
    expect(outcome.detail).toContain("401");
  });

  it("returns the answer on success", async () => {
    const { runNonTurnDirect } = await import("./non-turn-work.js");
    const fetchImpl = (async () => new Response(
      JSON.stringify({ content: [{ type: "text", text: "Add a React useEffect" }] }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )) as unknown as typeof fetch;

    const outcome = await runNonTurnDirect({ fetchImpl }, {
      sessionId: null,
      purpose: "voice-cleanup",
      target,
      prompt: "clean this",
    });

    expect(outcome).toEqual({ ok: true, text: "Add a React useEffect" });
  });
});

/**
 * Voice cleanup's own deadline aborts the call, inserts the raw transcript and
 * walks away — but the provider was already spending. A run nobody can price
 * still has to appear somewhere (docs/299-direct-provider-calls req 7), so this
 * reads the rows a real UsageManager wrote: an empty table and a table holding
 * one amount-less row are the two outcomes that must not be confused.
 */
describe("runNonTurnDirect — a call cut off before its amount could be read still reports a run", () => {
  let dbManager: DatabaseManager;
  let usageManager: UsageManager;

  beforeEach(() => {
    dbManager = new DatabaseManager(":memory:");
    usageManager = new UsageManager(dbManager);
  });
  afterEach(() => {
    dbManager.close();
  });

  const target = {
    execution: "direct" as const,
    selection: { serviceId: "anthropic", billingMode: "key" as const, modelId: "haiku" },
    serviceName: "Anthropic",
    source: "default" as const,
    call: {
      style: "anthropic-messages" as const,
      baseUrl: "https://api.anthropic.com",
      apiModelId: "claude-haiku-4-5",
      storageEnv: "ANTHROPIC_API_KEY",
    },
    apiKey: "sk-direct",
  };

  const allRows = () =>
    dbManager.db.prepare("SELECT * FROM usage_turns ORDER BY id").all() as Record<string, unknown>[];

  function abortingFetch(controller: AbortController): typeof fetch {
    return (async () => {
      controller.abort();
      throw Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
    }) as unknown as typeof fetch;
  }

  async function cleanWithDeadlineHit(controller: AbortController) {
    const { runNonTurnDirect } = await import("./non-turn-work.js");
    return runNonTurnDirect(
      { usageManager, fetchImpl: abortingFetch(controller) },
      {
        sessionId: null,
        purpose: "voice-cleanup",
        target,
        prompt: "clean this",
        signal: controller.signal,
      },
    );
  }

  it("writes the run with no amounts rather than dropping it", async () => {
    const controller = new AbortController();

    expect((await cleanWithDeadlineHit(controller)).ok).toBe(false);

    const rows = allRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      session_id: null,
      service_id: "anthropic",
      billing_mode: "key",
      model: "haiku",
      background_work: 1,
      sub_agent_id: null,
      cost_usd: 0,
    });
    // NULL, not zero: nobody measured these, and a zero would claim they were.
    expect(rows[0]!.input_tokens).toBeNull();
    expect(rows[0]!.output_tokens).toBeNull();
    expect(rows[0]!.cache_read_tokens).toBeNull();
    expect(rows[0]!.cache_create_tokens).toBeNull();
  });

  it("shows it install-wide, since a dictation belongs to no session", async () => {
    await cleanWithDeadlineHit(new AbortController());

    const stats = usageManager.getStats();
    expect(stats.sessions).toEqual([]);
    expect(stats.groups.map((g) => g.key)).toEqual(["install:anthropic:key"]);
    expect(stats.groups[0]!.installLevel).toBe(true);
    expect(stats.groups[0]!.models).toEqual(["haiku"]);
    expect(stats.totalTurns).toBe(1);
    // The amount is unknown, so no figure is invented for the money totals.
    expect(stats.totals.meteredCostUsd).toBe(0);
  });

  // The provider answered 200 and was writing an answer when the socket died.
  // Nobody cancelled anything, and the run was billed just the same.
  it("writes the run when the response body is lost to a dropped socket", async () => {
    const { runNonTurnDirect } = await import("./non-turn-work.js");
    const fetchImpl = (async () => new Response(
      new ReadableStream({
        start: (c) => {
          c.enqueue(new TextEncoder().encode('{"content":[{"type":"text"'));
          c.error(new TypeError("terminated"));
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )) as unknown as typeof fetch;

    await runNonTurnDirect({ usageManager, fetchImpl }, {
      sessionId: null,
      purpose: "voice-cleanup",
      target,
      prompt: "clean this",
    });

    const rows = allRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ service_id: "anthropic", cost_usd: 0, background_work: 1 });
    expect(rows[0]!.output_tokens).toBeNull();
  });

  it("records nothing when the deadline had already passed before the request went out", async () => {
    const controller = new AbortController();
    controller.abort();

    await cleanWithDeadlineHit(controller);

    expect(allRows()).toEqual([]);
  });

  it("records nothing for a failure the provider answered, which it does not bill", async () => {
    const { runNonTurnDirect } = await import("./non-turn-work.js");
    const fetchImpl = (async () => new Response("no key", { status: 401 })) as unknown as typeof fetch;

    await runNonTurnDirect({ usageManager, fetchImpl }, {
      sessionId: null,
      purpose: "voice-cleanup",
      target,
      prompt: "clean this",
    });

    expect(allRows()).toEqual([]);
  });
});
