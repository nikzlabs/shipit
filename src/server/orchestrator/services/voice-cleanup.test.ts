import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { CredentialRoute } from "../../shared/types.js";
import type { SubAgentRunResult } from "../../shared/sub-agent-run.js";
import type { BackgroundHarnessRun } from "../background-harness-run.js";
import type { ModelSelection } from "../../shared/catalogue/index.js";
import type { CleanupRequest } from "../voice/cleanup.js";

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

function cleanupRequest(over: Partial<CleanupRequest> = {}): CleanupRequest {
  return {
    prompt: "clean this",
    acceptableChars: 200,
    signal: AbortSignal.timeout(5000),
    ...over,
  };
}

const OK_RUN: SubAgentRunResult = {
  status: "success",
  text: "Add a React useEffect",
  truncated: false,
  durationMs: 3100,
  costUsd: 0,
  inputTokens: 900,
  outputTokens: 20,
};

interface Harness {
  runs: BackgroundHarnessRun[];
  recorded: { sessionId: string | null; extra?: Record<string, unknown> }[];
  requests: { url: string; body: Record<string, unknown> }[];
}

function buildDeps(opts: {
  pinned?: ModelSelection;
  routes?: CredentialRoute[];
  voiceKeys?: Record<string, string>;
  harnessResult?: (req: BackgroundHarnessRun) => Promise<SubAgentRunResult>;
  noHarnessRunner?: boolean;
  reply?: () => Response;
}) {
  const h: Harness = { runs: [], recorded: [], requests: [] };
  const routes = opts.routes ?? [keyRoute("zai", "sub")];
  const fetchImpl = (async (url: string, init: { body: string }) => {
    h.requests.push({ url, body: JSON.parse(init.body) as Record<string, unknown> });
    return opts.reply?.() ?? new Response(
      JSON.stringify({
        content: [{ type: "text", text: "Add a React useEffect" }],
        usage: { input_tokens: 400, output_tokens: 12 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  const deps = {
    credentialStore: {
      getNonTurnModel: () => opts.pinned,
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
      getVoiceProviderKey: (id: string) => opts.voiceKeys?.[id] ?? null,
    },
    usageManager: {
      record: (
        sessionId: string | null,
        _cost: number,
        _d: number,
        _i?: number,
        _o?: number,
        extra?: Record<string, unknown>,
      ) => {
        h.recorded.push({ sessionId, extra });
        return 0;
      },
    },
    ...(opts.noHarnessRunner
      ? {}
      : {
          backgroundHarnessRunner: {
            run: async (req: BackgroundHarnessRun) => {
              h.runs.push(req);
              return opts.harnessResult ? opts.harnessResult(req) : OK_RUN;
            },
          },
        }),
    fetchImpl,
  };
  return { deps: deps as never, h };
}

describe("planCleanup (docs/299-direct-provider-calls req 5)", () => {
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

  it("runs the background-work model as a direct call where the credential permits one", async () => {
    const { planCleanup } = await import("./voice-cleanup.js");
    const { deps, h } = buildDeps({
      routes: [keyRoute("anthropic")],
      pinned: { serviceId: "anthropic", billingMode: "key", modelId: "haiku" },
    });

    const plan = planCleanup(deps)!;
    expect(plan.execution).toBe("direct");
    expect(plan.serviceName).toBe("Anthropic");
    expect(await plan.run(cleanupRequest())).toBe("Add a React useEffect");
    expect(h.requests[0].url).toBe("https://api.anthropic.com/v1/messages");
    // The catalogue id is a harness alias; the API needs the dated identifier.
    expect(h.requests[0].body.model).toBe("claude-haiku-4-5");
    expect(h.runs).toHaveLength(0);
  });

  it("runs a subscription choice on the background harness, never the session's container", async () => {
    const { planCleanup } = await import("./voice-cleanup.js");
    const { deps, h } = buildDeps({});

    const plan = planCleanup(deps)!;
    expect(plan.execution).toBe("harness");
    expect(await plan.run(cleanupRequest())).toBe("Add a React useEffect");
    expect(h.runs).toHaveLength(1);
    expect(h.runs[0]).toMatchObject({
      harnessId: "claude",
      prompt: "clean this",
      model: "glm-5.3[1m]",
    });
    expect(h.requests).toHaveLength(0);
  });

  it("gives the harness a longer deadline than a direct call", async () => {
    const { planCleanup } = await import("./voice-cleanup.js");
    const { deps } = buildDeps({});
    const { deps: directDeps } = buildDeps({
      routes: [keyRoute("anthropic")],
      pinned: { serviceId: "anthropic", billingMode: "key", modelId: "haiku" },
    });

    expect(planCleanup(deps)!.deadlineMs).toBeGreaterThan(planCleanup(directDeps)!.deadlineMs);
  });

  it("passes the abort signal down so the deadline cancels the run", async () => {
    const { planCleanup } = await import("./voice-cleanup.js");
    const { deps, h } = buildDeps({});
    const controller = new AbortController();

    await planCleanup(deps)!.run(cleanupRequest({ signal: controller.signal }));

    expect(h.runs[0].signal).toBe(controller.signal);
  });

  /**
   * A cleaned transcript missing its ending reads exactly like a complete one,
   * so an output budget below what cleanup accepts loses the tail of a long
   * dictation with nothing on screen to say so.
   */
  it("never budgets a harness answer below the length cleanup would accept", async () => {
    const { planCleanup } = await import("./voice-cleanup.js");
    const { deps, h } = buildDeps({});

    await planCleanup(deps)!.run(cleanupRequest({ acceptableChars: 6000 }));

    expect(h.runs[0].maxOutputChars!).toBeGreaterThan(6000);
  });

  it("refuses a harness answer the harness itself cut short", async () => {
    const { planCleanup } = await import("./voice-cleanup.js");
    const { deps } = buildDeps({
      harnessResult: async () => ({ ...OK_RUN, truncated: true, text: "Add a React use" }),
    });

    await expect(planCleanup(deps)!.run(cleanupRequest())).rejects.toThrow(/cut off/);
  });

  // The provider's own limit can be lower than the one asked for, so a wide
  // budget is not what makes this safe: only the provider says it stopped.
  it("refuses a direct answer the provider cut off on its output limit", async () => {
    const { planCleanup } = await import("./voice-cleanup.js");
    const { deps } = buildDeps({
      routes: [keyRoute("anthropic")],
      pinned: { serviceId: "anthropic", billingMode: "key", modelId: "haiku" },
      reply: () => new Response(
        JSON.stringify({
          content: [{ type: "text", text: "Rename the file" }],
          stop_reason: "max_tokens",
          usage: { input_tokens: 90, output_tokens: 12 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    });

    await expect(planCleanup(deps)!.run(cleanupRequest())).rejects.toThrow(/output budget/);
  });

  // maxOutputChars reaches the API as max_tokens = chars / 3, and one character
  // per token is a real tokenizer, so the budget has to clear three times over.
  it("leaves a direct call enough tokens to exceed that length in any language", async () => {
    const { planCleanup } = await import("./voice-cleanup.js");
    const { deps, h } = buildDeps({
      routes: [keyRoute("anthropic")],
      pinned: { serviceId: "anthropic", billingMode: "key", modelId: "haiku" },
    });

    await planCleanup(deps)!.run(cleanupRequest({ acceptableChars: 6000 }));

    expect(h.requests[0].body.max_tokens as number).toBeGreaterThan(6000);
  });

  it("reports nothing to run when the choice needs a harness and none can run without a session", async () => {
    const { planCleanup } = await import("./voice-cleanup.js");
    const { deps } = buildDeps({ noHarnessRunner: true });

    expect(planCleanup(deps)).toBeNull();
  });

  it("reports nothing to run when no credential is configured at all", async () => {
    const { planCleanup } = await import("./voice-cleanup.js");
    const { deps } = buildDeps({ routes: [] });

    expect(planCleanup(deps)).toBeNull();
  });

  it("records a harness run as install-level spend naming the harness (docs/299-direct-provider-calls req 7)", async () => {
    const { planCleanup } = await import("./voice-cleanup.js");
    const { deps, h } = buildDeps({});

    await planCleanup(deps)!.run(cleanupRequest());

    expect(h.recorded).toHaveLength(1);
    expect(h.recorded[0].sessionId).toBeNull();
    expect(h.recorded[0].extra).toMatchObject({ backgroundWork: true, subAgentId: "claude" });
    expect(h.recorded[0].extra?.attribution).toMatchObject({ serviceId: "zai", billingMode: "sub" });
  });

  it("records what a failed harness run spent, and reports the failure to the caller", async () => {
    const { planCleanup } = await import("./voice-cleanup.js");
    const { deps, h } = buildDeps({
      harnessResult: async () => ({ ...OK_RUN, status: "error", text: "", error: "401 Unauthorized" }),
    });

    await expect(planCleanup(deps)!.run(cleanupRequest())).rejects.toThrow("401 Unauthorized");
    expect(h.recorded).toHaveLength(1);
  });

  it("reports a failed direct call to the caller rather than returning empty text", async () => {
    const { planCleanup } = await import("./voice-cleanup.js");
    const { deps } = buildDeps({
      routes: [keyRoute("anthropic")],
      pinned: { serviceId: "anthropic", billingMode: "key", modelId: "haiku" },
      reply: () => new Response("no key", { status: 401 }),
    });

    await expect(planCleanup(deps)!.run(cleanupRequest())).rejects.toThrow(/401/);
  });
});

describe("getCleanupStatus", () => {
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

  it("names the model that would actually clean the next dictation, and the harness it waits on", async () => {
    const { getCleanupStatus } = await import("./voice.js");
    const { deps } = buildDeps({});

    expect(getCleanupStatus(deps).model).toEqual({
      serviceName: "GLM (Z.ai)",
      modelId: "glm-5.3[1m]",
      modelLabel: "GLM-5.3",
      execution: "harness",
      harnessName: "Claude Code",
    });
  });

  // The line promises a quick cleanup here and a few seconds above, so the two
  // must be told apart by what will actually run, not by the model's name.
  it("reports a direct call as direct, with no harness to name", async () => {
    const { getCleanupStatus } = await import("./voice.js");
    const { deps } = buildDeps({
      routes: [keyRoute("anthropic")],
      pinned: { serviceId: "anthropic", billingMode: "key", modelId: "haiku" },
    });

    expect(getCleanupStatus(deps).model).toEqual({
      serviceName: "Anthropic",
      modelId: "haiku",
      modelLabel: "Haiku 4.5",
      execution: "direct",
    });
  });

  it("says nothing can clean when no background-work model is configured", async () => {
    const { getCleanupStatus } = await import("./voice.js");
    const { deps } = buildDeps({ routes: [] });

    expect(getCleanupStatus(deps).model).toBeNull();
  });
});

/**
 * The migration in visible form (docs/299-direct-provider-calls req 5): an
 * offer, never a silent write. Each case below is a state the Voice tab renders
 * differently.
 */
describe("findVoiceKeyAdoptionOffer", () => {
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

  it("offers the OpenAI voice key to an install whose cleanup has nothing to run on", async () => {
    const { getCleanupStatus } = await import("./voice.js");
    const { deps } = buildDeps({ routes: [], voiceKeys: { openai: "sk-voice" } });

    const status = getCleanupStatus(deps);
    expect(status.model).toBeNull();
    expect(status.adoptableVoiceKey).toEqual({
      providerId: "openai",
      providerLabel: "OpenAI",
      serviceName: "OpenAI",
    });
  });

  it("offers nothing where there is no voice key at all", async () => {
    const { getCleanupStatus } = await import("./voice.js");
    const { deps } = buildDeps({ routes: [] });

    expect(getCleanupStatus(deps).adoptableVoiceKey).toBeNull();
  });

  // Deepgram is a voice provider and not a model provider, so there is no
  // credential to adopt it into and no cleanup its key could buy.
  it("offers nothing for a voice key whose provider runs no models", async () => {
    const { getCleanupStatus } = await import("./voice.js");
    const { deps } = buildDeps({ routes: [], voiceKeys: { deepgram: "dg-voice" } });

    expect(getCleanupStatus(deps).adoptableVoiceKey).toBeNull();
  });

  it("offers nothing while cleanup already runs, since adoption would not change it", async () => {
    const { getCleanupStatus } = await import("./voice.js");
    const { deps } = buildDeps({ voiceKeys: { openai: "sk-voice" } });

    expect(getCleanupStatus(deps).model).not.toBeNull();
    expect(getCleanupStatus(deps).adoptableVoiceKey).toBeNull();
  });

  // Adoption seeds only where nothing is set, so with a pin pointing elsewhere
  // it cannot deliver the cleanup the offer's copy promises.
  it("offers nothing where a pin on another provider would keep cleanup broken", async () => {
    const { getCleanupStatus } = await import("./voice.js");
    const { deps } = buildDeps({
      routes: [],
      voiceKeys: { openai: "sk-voice" },
      pinned: { serviceId: "anthropic", billingMode: "key", modelId: "haiku" },
    });

    expect(getCleanupStatus(deps).adoptableVoiceKey).toBeNull();
  });

  /**
   * A pin on a retired model is not a dead pin: background work follows the
   * declared successor, so the adopted credential does reach it and the offer
   * must not be withheld. The retired id is read from the catalogue rather than
   * written here, so this case moves with the catalogue instead of pinning it.
   */
  it("offers the key where the pin is a retired model the credential still reaches", async () => {
    const { getMode } = await import("../../shared/catalogue/index.js");
    const { getCleanupStatus } = await import("./voice.js");
    const retiredId = getMode("openai", "key")?.retired[0]?.id;
    expect(retiredId, "OpenAI's key mode must declare a retired model for this case to exist").toBeTruthy();
    const { deps } = buildDeps({
      routes: [],
      voiceKeys: { openai: "sk-voice" },
      pinned: { serviceId: "openai", billingMode: "key", modelId: retiredId! },
    });

    expect(getCleanupStatus(deps).adoptableVoiceKey?.providerId).toBe("openai");
  });

  it("offers the key where the pin is that very credential", async () => {
    const { getCleanupStatus } = await import("./voice.js");
    const { deps } = buildDeps({
      routes: [],
      voiceKeys: { openai: "sk-voice" },
      pinned: { serviceId: "openai", billingMode: "key", modelId: "gpt-5.4-mini" },
    });

    expect(getCleanupStatus(deps).adoptableVoiceKey?.providerId).toBe("openai");
  });
});
