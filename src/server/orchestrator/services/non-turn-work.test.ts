import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { CredentialRoute, NonTurnFailureCard, WsServerMessage } from "../../shared/types.js";
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

  // "Nothing eligible" is ShipIt having no opinion, not a refusal to run.
  // `listConfiguredCredentials` sees the credential store and the environment,
  // not a CLI logged in on the host outside both — so a dev checkout and a
  // hand-authenticated deployment land here, and both worked before this
  // feature. Falling back is the only answer that cannot regress them; a notice
  // would name nothing actionable and fire on every session.
  it("falls back to the pre-feature generator when nothing at all is eligible", async () => {
    const { makeNonTurnGenerateText } = await import("./non-turn-work.js");
    const { deps, h } = buildDeps({ routes: [] });
    const fallback = vi.fn(async () => "from the fallback");
    const generate = makeNonTurnGenerateText({ ...(deps as object), fallback } as never);

    expect(await generate("prompt", "/ws", { sessionId: "s1" })).toBe("from the fallback");
    expect(h.appended).toHaveLength(0);
    expect(h.emitted).toHaveLength(0);
  });

  // The opposite case, and the distinction is the whole point: a pin the
  // install can no longer run is a service the USER chose that went away, so it
  // stops and says so rather than quietly running something else.
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

/**
 * Cross-backend review found the credential window missing entirely. Non-turn
 * work is chosen INDEPENDENTLY of the session, so its harness and its account
 * are routinely not the ones the session's container holds — and Anthropic's
 * subscription is the first catalogue row, so that is the default install
 * rather than a corner.
 */
/**
 * A runner that passes `instanceof ContainerSessionRunner` — the discriminator
 * the credential window keys on — without constructing a real container.
 *
 * Own data properties rather than `Object.assign`, because the real class
 * exposes most of this surface as accessors backed by collaborators a bare
 * `Object.create` does not have; an own property shadows the prototype's
 * accessor cleanly.
 */
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

  it("provisions the run's credentials before the spawn and wipes them after", async () => {
    const calls: string[] = [];
    vi.doMock("../session-credentials.js", () => ({
      provisionSubAgentCredentials: () => calls.push("provision"),
      removeSubAgentCredentials: () => calls.push("wipe"),
      syncAgentTokenBack: () => calls.push("sync"),
      syncProviderAccountTokenBack: () => calls.push("sync-account"),
      provisionProviderAccountCredentials: () => calls.push("restore"),
    }));
    // The runner has to BE a ContainerSessionRunner for the window to open —
    // local mode provisions nothing, by design (docs/138).
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
      credentialsDir: "/credentials",
      fallback: async () => "unused",
    } as never);

    await generate("prompt", "/ws", { sessionId: "s1", purpose: "pr-description" });

    // Provision BEFORE the spawn, wipe AFTER — a background generation must not
    // leave a credential behind in the session's container.
    expect(calls).toEqual(["provision", "spawn", "sync", "wipe"]);
  });

  it("still wipes when the spawn throws", async () => {
    const calls: string[] = [];
    vi.doMock("../session-credentials.js", () => ({
      provisionSubAgentCredentials: () => calls.push("provision"),
      removeSubAgentCredentials: () => calls.push("wipe"),
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
      credentialsDir: "/credentials",
      fallback: async () => "unused",
    } as never);

    expect(await generate("prompt", "/ws", { sessionId: "s1" })).toBe("");
    expect(calls).toContain("wipe");
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

  // The clobber docs/164, docs/177 and docs/193 each hit: `recordedCards` is not
  // cleared until the NEXT turn starts, so a database-only patch applied while
  // the proposing turn is still running is rebuilt away when it finalizes, and
  // the notice reappears on the next reload.
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
    // The recorded card carries the dismissal, so the turn's own final persist
    // writes it too rather than reverting it.
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

/**
 * planning#343 (req 16) — the row for work that resolved **no** model.
 *
 * Its tokens are real; its attribution does not exist. That is the same
 * condition as a pre-feature turn, reached forward in time rather than
 * historically, so it goes into the legacy group — and it is never priced.
 */
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
      // Claude DOES report a dollar figure. Taking it would price a row nothing
      // can attribute; `resolveTurnCost`'s no-attribution default would do
      // exactly that, which is why this path does not go through it.
      telemetry: { durationMs: 800, costUsd: 0.017, inputTokens: 900, outputTokens: 25 },
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]!.costUsd).toBe(0);
    expect(rows[0]!.extra?.attribution).toBeUndefined();
    expect(rows[0]!.extra?.model).toBeUndefined();
    expect(rows[0]!.extra?.subAgentId).toBe("claude");
    expect(rows[0]!.extra?.costSource).toBe("per-turn");
  });

  // Codex reports tokens and no dollar figure at all. The row is the same
  // shape — the figure was never going to be used either way.
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

  // Volume is the whole content of the row, so with none there is nothing to
  // write — a cost-only report cannot carry an unattributed run on its own.
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
