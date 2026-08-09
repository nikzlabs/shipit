import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { CredentialRoute, WsServerMessage } from "../../shared/types.js";
import type { PersistedMessage } from "../chat-history.js";
import type { SubAgentRunResult } from "../../shared/sub-agent-run.js";

/**
 * docs/252 phase 7 (req 9) — running the work outside a turn.
 *
 * The two properties the requirement is emphatic about are what these tests
 * pin: **a failed generation still lets the surrounding operation complete with
 * a fallback**, and **the notice is persisted, not merely emitted** — a card
 * that renders live and vanishes on reload is silent in practice.
 */

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
  /** Omit the runner entirely — the container-is-gone path. */
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
  // The structural fakes above intentionally model only what this module reads.
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

  // A call with no session is not non-turn *work* — it is the post-interrupt
  // commit message, which has no session to attribute to and no notice to
  // raise. It must keep running on whatever the caller injected.
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
    expect(req.model).toBe("deepseek-v4-flash");
    // A string-delivered credential is shaped: endpoint + credential target.
    expect(req.serviceRouting).toBeTruthy();
  });

  // req 16 — a user can point non-turn work at a metered service and be charged
  // for every session they create. The spend has to land somewhere.
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
    // Not the pinned agent's turn — a one-shot spawn of the derived harness,
    // which is what keeps it out of the primary delta chain and the context dial.
    expect(row.extra?.subAgentId).toBe("claude");
    expect(row.extra?.attribution).toMatchObject({ serviceId: "deepseek", billingMode: "key" });
    // Codex-style: no dollar figure reported, so the row is priced from the
    // catalogue's persisted rates rather than recorded as free.
    expect(row.costUsd).toBeGreaterThan(0);
    expect(row.extra?.costSource).toBe("per-turn");
  });

  // The trap the cost rule's docstring is written around: an all-zero row
  // priced through the rates says "this was free", which is a wrong number
  // rather than a missing one.
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

  // req 9 — the surrounding operation still completes with a fallback, AND the
  // user is told. Returning "" is how the caller reaches its generic text.
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
    // PERSISTED, not merely emitted: the turn is not running, so `emitChatCard`
    // appends a finalized row. A card that only rode the WS would vanish on the
    // next reload, which req 9 explicitly forbids.
    expect(h.appended).toHaveLength(1);
    const card = h.appended[0].nonTurnFailure;
    expect(card?.purpose).toBe("pr-description");
    expect(card?.serviceName).toBe("DeepSeek");
    expect(card?.detail).toContain("401");
    expect(h.emitted.some((m) => m.type === "non_turn_failure_card")).toBe(true);
  });

  // A blank success is a failure from the user's side — the whole reason the PR
  // half is a *change* rather than a preserved behaviour.
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
    // No runner to emit through, so the row is appended directly — the notice
    // still has to reach the transcript, which is the point of it being
    // transcript content rather than a toast.
    expect(h.appended).toHaveLength(1);
  });

  // No service failed — an install with no credentials has nothing to blame,
  // and a notice on every session naming nothing actionable is noise.
  it("stays silent when nothing at all is eligible", async () => {
    const { makeNonTurnGenerateText } = await import("./non-turn-work.js");
    const { deps, h } = buildDeps({ routes: [] });
    const generate = makeNonTurnGenerateText({
      ...(deps as object),
      fallback: async () => "unused",
    } as never);

    expect(await generate("prompt", "/ws", { sessionId: "s1" })).toBe("");
    expect(h.appended).toHaveLength(0);
    expect(h.emitted).toHaveLength(0);
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
