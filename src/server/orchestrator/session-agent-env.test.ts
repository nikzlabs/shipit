/**
 * Unit tests for `prepareSessionAgentEnvironment` /
 * `finalizeSessionAgentEnvironment` (docs/149).
 *
 * The integration tests in `agent-spawned-session.test.ts` exercise the
 * orchestrator end-to-end but use in-process `SessionRunner` instances, which
 * skip the container-only credential plumbing. These unit tests target the
 * helper directly with a fake ContainerSessionRunner so the OAuth sync /
 * cred-provision / agent-env push paths are covered.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import type { SessionRunnerInterface } from "./session-runner.js";
import type { CredentialStore } from "./credential-store.js";
import type { SessionManager } from "./sessions.js";
import { ContainerSessionRunner } from "./container-session-runner.js";
import {
  prepareSessionAgentEnvironment,
  finalizeSessionAgentEnvironment,
  repushSessionAgentToken,
  selectAgentEnvForPush,
  PUSH_AGENT_SECRETS_TIMEOUT_MS,
} from "./session-agent-env.js";
import { syncAgentTokenIn } from "./session-credentials.js";
import { repoUrlToHash } from "./git-utils.js";
import { ProviderRouteUnavailableError } from "./provider-route-preflight.js";
import {
  hasTokenWriteBackWatch,
  stopAllTokenWriteBackWatches,
} from "./session-token-publisher.js";

/**
 * Minimal ContainerSessionRunner stand-in that satisfies the instanceof check
 * in `prepareSessionAgentEnvironment`. We only exercise the env-prep methods
 * (`tryPushAgentSecrets`) so the rest of the runner surface is irrelevant.
 */
class FakeContainerRunner extends EventEmitter {
  serviceManager: { getSecretsSnapshot: () => { agentValues: Record<string, string> } } | null = null;
  pushed: Record<string, string>[] = [];
  async tryPushAgentSecrets(values: Record<string, string>): Promise<void> {
    this.pushed.push(values);
  }
}
// Reparent the fake so `runner instanceof ContainerSessionRunner` is true —
// the helper's container-only branches are otherwise unreachable from tests.
Object.setPrototypeOf(FakeContainerRunner.prototype, ContainerSessionRunner.prototype);

function makeFakeCredentialStore(
  initial: { agentEnv?: Record<string, string> } = {},
): CredentialStore {
  const agentEnv = { ...(initial.agentEnv ?? {}) };
  const stub = {
    getAllAgentEnv: () => ({ ...agentEnv }),
    getAllMcpOAuthTokens: () => ({}),
    getAllMcpServers: () => ({}),
    getAgentSystemInstructionsEnabled: () => true,
    getAutoCreatePr: () => false,
  };
  return stub as unknown as CredentialStore;
}

function makeFakeSessionManager(opts: {
  agentPinned: boolean;
  agentSessionId?: string;
  providerRouteKind?: "account" | "reserved";
  providerRouteId?: string;
  remoteUrl?: string;
  model?: string;
}): {
  sm: SessionManager;
  state: {
    agentPinned: boolean;
    setAgentIdCalls: number;
    setAgentPinnedCalls: number;
    agentSessionId: string | undefined;
    setAgentSessionIdCalls: { id: string; value: string }[];
    clearAgentSessionIdCalls: string[];
    conversationReplay: string | undefined;
    setProviderRouteCalls: { id: string; kind: string; routeId: string }[];
  };
} {
  const state = {
    agentPinned: opts.agentPinned,
    setAgentIdCalls: 0,
    setAgentPinnedCalls: 0,
    agentSessionId: opts.agentSessionId,
    setAgentSessionIdCalls: [] as { id: string; value: string }[],
    clearAgentSessionIdCalls: [] as string[],
    conversationReplay: undefined as string | undefined,
    setProviderRouteCalls: [] as { id: string; kind: string; routeId: string }[],
  };
  const sm = {
    get: () => ({
      agentPinned: state.agentPinned,
      id: "s1",
      agentSessionId: state.agentSessionId,
      providerRouteKind: opts.providerRouteKind,
      providerRouteId: opts.providerRouteId,
      remoteUrl: opts.remoteUrl ?? "",
      model: opts.model,
    }),
    setAgentId: () => { state.setAgentIdCalls += 1; },
    setAgentPinned: () => {
      state.setAgentPinnedCalls += 1;
      state.agentPinned = true;
    },
    setAgentSessionId: (id: string, value: string) => {
      state.setAgentSessionIdCalls.push({ id, value });
      state.agentSessionId = value;
    },
    clearAgentSessionId: (id: string) => {
      state.clearAgentSessionIdCalls.push(id);
      state.agentSessionId = undefined;
    },
    setConversationReplay: (_id: string, replay: string) => {
      state.conversationReplay = replay;
    },
    setProviderRoute: (id: string, kind: string, routeId: string) => {
      state.setProviderRouteCalls.push({ id, kind, routeId });
    },
  } as unknown as SessionManager;
  return { sm, state };
}

describe("prepareSessionAgentEnvironment", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-env-prep-"));
  });

  it("provisions agent credentials + pins on first call, but skips both on a second call (idempotent)", async () => {
    // Seed Claude creds at the source so provisioning has something to copy.
    fs.mkdirSync(path.join(tmpDir, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, ".claude.json"), "{}");
    fs.writeFileSync(
      path.join(tmpDir, ".claude", ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { expiresAt: Date.now() + 60_000 } }),
    );

    const runner = new FakeContainerRunner();
    const credentialStore = makeFakeCredentialStore();
    const { sm, state } = makeFakeSessionManager({ agentPinned: false });

    await prepareSessionAgentEnvironment(runner as unknown as SessionRunnerInterface, {
      sessionId: "s1",
      agentId: "claude",
      deps: { credentialsDir: tmpDir, credentialStore, sessionManager: sm },
    });
    expect(state.setAgentIdCalls).toBe(1);
    expect(state.setAgentPinnedCalls).toBe(1);
    const provisioned = fs.existsSync(path.join(tmpDir, "sessions", "s1", ".claude.json"));
    expect(provisioned).toBe(true);

    // Second call: session is now pinned, so re-provisioning is a no-op.
    // Clobber the session's `.claude.json` to prove we didn't re-copy.
    fs.writeFileSync(path.join(tmpDir, "sessions", "s1", ".claude.json"), "sentinel");
    await prepareSessionAgentEnvironment(runner as unknown as SessionRunnerInterface, {
      sessionId: "s1",
      agentId: "claude",
      deps: { credentialsDir: tmpDir, credentialStore, sessionManager: sm },
    });
    expect(state.setAgentIdCalls).toBe(1);
    expect(state.setAgentPinnedCalls).toBe(1);
    expect(
      fs.readFileSync(path.join(tmpDir, "sessions", "s1", ".claude.json"), "utf8"),
    ).toBe("sentinel");
  });

  it("syncs the freshest source token into the session before every turn (rotated-token freshness)", async () => {
    // Pin first so provisioning runs once.
    fs.mkdirSync(path.join(tmpDir, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, ".claude.json"), "{}");
    const stale = JSON.stringify({ claudeAiOauth: { expiresAt: 1_000, accessToken: "stale" } });
    fs.writeFileSync(path.join(tmpDir, ".claude", ".credentials.json"), stale);

    const runner = new FakeContainerRunner();
    const credentialStore = makeFakeCredentialStore();
    const { sm } = makeFakeSessionManager({ agentPinned: false });

    await prepareSessionAgentEnvironment(runner as unknown as SessionRunnerInterface, {
      sessionId: "s1",
      agentId: "claude",
      deps: { credentialsDir: tmpDir, credentialStore, sessionManager: sm },
    });
    const sessionCreds = path.join(tmpDir, "sessions", "s1", ".claude", ".credentials.json");
    expect(fs.readFileSync(sessionCreds, "utf8")).toBe(stale);

    // Rotate the source token. The session should pick it up on the next prep
    // — this is the 401-fix path: any other session refreshing the source
    // leaves a stale copy here, so we MUST resync on every turn (not just first).
    const fresh = JSON.stringify({ claudeAiOauth: { expiresAt: 2_000_000_000_000, accessToken: "fresh" } });
    fs.writeFileSync(path.join(tmpDir, ".claude", ".credentials.json"), fresh);

    await prepareSessionAgentEnvironment(runner as unknown as SessionRunnerInterface, {
      sessionId: "s1",
      agentId: "claude",
      deps: { credentialsDir: tmpDir, credentialStore, sessionManager: sm },
    });
    expect(fs.readFileSync(sessionCreds, "utf8")).toBe(fresh);
  });

  // docs/153 Fix 1 — when the per-turn sync repairs a leaked symlink (Case 1
  // or Case 3 in materializeLeakedSubtreeSymlinks), the recovered
  // agent_session_id must be surfaced to the caller as `overrideAgentSessionId`
  // so the spawn argument can be replaced. Without this the spawn uses the
  // captured-at-turn-start (stale) id, --resume fails, and the listener
  // poisons the DB with a fresh init UUID. The DB row is updated as a side
  // effect of the recovery callback, but the spawn-arg fix is the load-bearing
  // piece — turn-start captured `opts.agentSessionId` is already in the
  // caller's closure by the time prepareSessionAgentEnvironment runs.

  it("returns overrideAgentSessionId when the docs/153 repair recovers an id from an orphan jsonl", async () => {
    // Recreate the prod state: docs/150 provider-account layout with the
    // legacy alias symlink, AND the orphan jsonl tree the agent CLI wrote
    // through the leaked symlink in its Subpath namespace.
    const account = path.join(tmpDir, "provider-accounts", "claude", "claude-default");
    fs.mkdirSync(path.join(account, ".claude"), { recursive: true });
    fs.writeFileSync(
      path.join(account, ".claude", ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { expiresAt: Date.now() + 60_000, accessToken: "FRESH" } }),
    );
    // Session dir has the leaked symlink — Case 1.
    const sessionDir = path.join(tmpDir, "sessions", "s1");
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.symlinkSync(path.join(account, ".claude"), path.join(sessionDir, ".claude"));
    // Orphan jsonl from when the CLI followed the symlink in its Subpath view.
    const recoveredId = "b5903553-cab6-49a9-a9c0-855a7708867d";
    const orphanProjects = path.join(
      sessionDir, "provider-accounts", "claude", "claude-default",
      ".claude", "projects", "-workspace",
    );
    fs.mkdirSync(orphanProjects, { recursive: true });
    // Validator-aware: jsonl must contain real user+assistant events to
    // pass `--resume` (docs/153 — stub jsonls fail the validator and the
    // repair would surface a `null` clear signal instead of recovering).
    fs.writeFileSync(
      path.join(orphanProjects, `${recoveredId}.jsonl`),
      `${JSON.stringify({ sessionId: recoveredId, type: "summary" })}\n`
      + `${JSON.stringify({ sessionId: recoveredId, type: "user", message: { content: "hi" } })}\n`
      + `${JSON.stringify({ sessionId: recoveredId, type: "assistant", message: { content: "hello" } })}\n`,
    );

    const runner = new FakeContainerRunner();
    const credentialStore = makeFakeCredentialStore();
    const { sm, state } = makeFakeSessionManager({
      agentPinned: true,
      agentSessionId: "2595726f-stale-uuid-from-pre-recovery",
      providerRouteKind: "account",
      providerRouteId: "claude-default",
    });

    const result = await prepareSessionAgentEnvironment(runner as unknown as SessionRunnerInterface, {
      sessionId: "s1",
      agentId: "claude",
      deps: { credentialsDir: tmpDir, credentialStore, sessionManager: sm },
    });

    expect(result.overrideAgentSessionId).toBe(recoveredId);
    // DB row was also updated (so the listener's agent_result write resolves
    // to the right value too — but the spawn-arg override is the primary fix).
    expect(state.setAgentSessionIdCalls).toContainEqual({ id: "s1", value: recoveredId });
    expect(state.agentSessionId).toBe(recoveredId);
  });

  it("routes a fresh session through the account router rather than inheriting one (req 18)", async () => {
    // An agent-spawned child session is created with no persisted route. It
    // must therefore ask the router, which applies the user's normal priority
    // order — a child does NOT ride whatever account its parent happened to be
    // pinned to (docs/150 req 18). This is the mechanism that guarantees it:
    // `providerRouteKind`/`providerRouteId` are only ever written from a
    // router decision, never copied at spawn.
    const account = path.join(tmpDir, "provider-accounts", "claude", "acct-primary");
    fs.mkdirSync(path.join(account, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(account, ".claude", ".credentials.json"), "{}");

    const runner = new FakeContainerRunner();
    const credentialStore = makeFakeCredentialStore();
    const { sm, state } = makeFakeSessionManager({ agentPinned: false });
    const selectAccountForTurn = vi
      .fn()
      .mockReturnValue({ ok: true, route: { kind: "account", id: "acct-primary" } });

    await prepareSessionAgentEnvironment(runner as unknown as SessionRunnerInterface, {
      sessionId: "s1",
      agentId: "claude",
      deps: {
        credentialsDir: tmpDir,
        credentialStore,
        sessionManager: sm,
        providerAccountManager: { selectAccountForTurn, markAccountUsed: vi.fn() } as never,
      },
    });

    expect(selectAccountForTurn).toHaveBeenCalledWith("claude");
    expect(state.setProviderRouteCalls).toEqual([
      { id: "s1", kind: "account", routeId: "acct-primary" },
    ]);
    // The child's own credentials came from the routed account.
    expect(
      fs.existsSync(path.join(tmpDir, "sessions", "s1", ".claude", ".credentials.json")),
    ).toBe(true);
  });

  it("reuses an already-persisted route instead of re-running the router", async () => {
    // Follow-up turns (including detached / system turns that recreate a
    // runner from scratch) must land on the account the session is already
    // pinned to, not re-select and drift onto a different one mid-conversation.
    const runner = new FakeContainerRunner();
    const credentialStore = makeFakeCredentialStore();
    const { sm, state } = makeFakeSessionManager({
      agentPinned: true,
      providerRouteKind: "account",
      providerRouteId: "acct-secondary",
    });
    const selectAccountForTurn = vi.fn();

    await prepareSessionAgentEnvironment(runner as unknown as SessionRunnerInterface, {
      sessionId: "s1",
      agentId: "claude",
      enforceAccountRouting: true,
      deps: {
        credentialsDir: tmpDir,
        credentialStore,
        sessionManager: sm,
        providerAccountManager: { selectAccountForTurn, markAccountUsed: vi.fn() } as never,
      },
    });

    expect(selectAccountForTurn).not.toHaveBeenCalled();
    expect(state.setProviderRouteCalls).toEqual([]);
  });

  // ---- docs/150 req 13: the turn preflight ----

  it("fails the turn immediately with the earliest reset when every account is exhausted (req 13)", async () => {
    const runner = new FakeContainerRunner();
    const credentialStore = makeFakeCredentialStore();
    const { sm, state } = makeFakeSessionManager({ agentPinned: false });
    const selectAccountForTurn = vi.fn().mockReturnValue({
      ok: false,
      reason: "all_exhausted",
      earliestResetAt: "2026-08-01T14:30:00.000Z",
    });

    await expect(
      prepareSessionAgentEnvironment(runner as unknown as SessionRunnerInterface, {
        sessionId: "s1",
        agentId: "claude",
        enforceAccountRouting: true,
        deps: {
          credentialsDir: tmpDir,
          credentialStore,
          sessionManager: sm,
          providerAccountManager: { selectAccountForTurn, markAccountUsed: vi.fn() } as never,
        },
      }),
    ).rejects.toThrow(ProviderRouteUnavailableError);

    // req 13 — "before any first-turn pinning or credential provisioning": a
    // blocked turn must leave no trace that it picked an account, or the next
    // turn would silently reuse a route the router never chose.
    expect(state.setAgentPinnedCalls).toBe(0);
    expect(state.setProviderRouteCalls).toEqual([]);
    expect(fs.existsSync(path.join(tmpDir, "sessions", "s1"))).toBe(false);
  });

  // Routing around an account that cannot run the requested model is a
  // NON-GOAL (docs/150). The router is therefore never told which model the
  // turn wants: mixing accounts with different model access is the user's
  // choice to manage, and the provider's own error is the clear signal.
  it("does not consult the model when choosing an account", async () => {
    fs.mkdirSync(path.join(tmpDir, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, ".claude.json"), "{}");

    const runner = new FakeContainerRunner();
    const credentialStore = makeFakeCredentialStore();
    const { sm } = makeFakeSessionManager({ agentPinned: false, model: "claude-opus-5" });
    const selectAccountForTurn = vi
      .fn()
      .mockReturnValue({ ok: true, route: { kind: "account", id: "acct-a" } });

    await prepareSessionAgentEnvironment(runner as unknown as SessionRunnerInterface, {
      sessionId: "s1",
      agentId: "claude",
      enforceAccountRouting: true,
      deps: {
        credentialsDir: tmpDir,
        credentialStore,
        sessionManager: sm,
        providerAccountManager: { selectAccountForTurn, markAccountUsed: vi.fn() } as never,
      },
    });

    expect(selectAccountForTurn).toHaveBeenCalledWith("claude");
  });

  // Not-signed-in has its own guided surface; env-prep must not convert it
  // into a hard turn error, and the legacy provisioning path still runs.
  it("does not block the turn when nothing is connected (auth_required)", async () => {
    fs.mkdirSync(path.join(tmpDir, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, ".claude.json"), "{}");

    const runner = new FakeContainerRunner();
    const credentialStore = makeFakeCredentialStore();
    const { sm, state } = makeFakeSessionManager({ agentPinned: false });
    const selectAccountForTurn = vi.fn().mockReturnValue({ ok: false, reason: "auth_required" });

    await prepareSessionAgentEnvironment(runner as unknown as SessionRunnerInterface, {
      sessionId: "s1",
      agentId: "claude",
      enforceAccountRouting: true,
      deps: {
        credentialsDir: tmpDir,
        credentialStore,
        sessionManager: sm,
        providerAccountManager: { selectAccountForTurn, markAccountUsed: vi.fn() } as never,
      },
    });

    expect(state.setAgentPinnedCalls).toBe(1);
    expect(state.setProviderRouteCalls).toEqual([]);
  });

  // The service-level warm-up calls (child spawn, headless create) run before
  // the turn exists. Throwing there would abort a session *creation*, leaving
  // a session in the sidebar nobody asked for; the executor's own preflight is
  // what stops the turn moments later.
  it("keeps its fail-open contract when the caller is not the turn's preflight", async () => {
    fs.mkdirSync(path.join(tmpDir, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, ".claude.json"), "{}");

    const runner = new FakeContainerRunner();
    const credentialStore = makeFakeCredentialStore();
    const { sm, state } = makeFakeSessionManager({ agentPinned: false });
    const selectAccountForTurn = vi
      .fn()
      .mockReturnValue({ ok: false, reason: "all_exhausted", earliestResetAt: null });

    await prepareSessionAgentEnvironment(runner as unknown as SessionRunnerInterface, {
      sessionId: "s1",
      agentId: "claude",
      deps: {
        credentialsDir: tmpDir,
        credentialStore,
        sessionManager: sm,
        providerAccountManager: { selectAccountForTurn, markAccountUsed: vi.fn() } as never,
      },
    });

    // Nothing was routed, so the executor's preflight still has the decision
    // to make — but the session itself was created and pinned normally.
    expect(state.setProviderRouteCalls).toEqual([]);
    expect(state.setAgentPinnedCalls).toBe(1);
  });

  it("returns no override on healthy turns (no leak repair fired)", async () => {
    // Healthy provider-account session with a real .claude/ dir — no symlink,
    // no orphan tree.
    const account = path.join(tmpDir, "provider-accounts", "claude", "claude-default");
    fs.mkdirSync(path.join(account, ".claude"), { recursive: true });
    fs.writeFileSync(
      path.join(account, ".claude", ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { expiresAt: Date.now() + 60_000, accessToken: "FRESH" } }),
    );
    const sessionDir = path.join(tmpDir, "sessions", "s1");
    fs.mkdirSync(path.join(sessionDir, ".claude"), { recursive: true });
    fs.writeFileSync(
      path.join(sessionDir, ".claude", ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { expiresAt: Date.now() + 60_000, accessToken: "FRESH" } }),
    );
    // Seed the on-disk jsonl matching the DB id — without it, Case 4
    // would fire (stale DB pointer) and the override would be `null`
    // (clear). A "healthy turn" is precisely the case where the DB id
    // resolves to a resumable jsonl on disk.
    const healthyId = "healthy-existing-id";
    const projectsDir = path.join(sessionDir, ".claude", "projects", "-workspace");
    fs.mkdirSync(projectsDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectsDir, `${healthyId}.jsonl`),
      `${JSON.stringify({ sessionId: healthyId, type: "summary" })}\n`
      + `${JSON.stringify({ sessionId: healthyId, type: "user", message: { content: "hi" } })}\n`
      + `${JSON.stringify({ sessionId: healthyId, type: "assistant", message: { content: "hello" } })}\n`,
    );

    const runner = new FakeContainerRunner();
    const credentialStore = makeFakeCredentialStore();
    const { sm, state } = makeFakeSessionManager({
      agentPinned: true,
      agentSessionId: healthyId,
      providerRouteKind: "account",
      providerRouteId: "claude-default",
    });

    const result = await prepareSessionAgentEnvironment(runner as unknown as SessionRunnerInterface, {
      sessionId: "s1",
      agentId: "claude",
      deps: { credentialsDir: tmpDir, credentialStore, sessionManager: sm },
    });

    expect(result.overrideAgentSessionId).toBeUndefined();
    expect(state.setAgentSessionIdCalls).toHaveLength(0);
    expect(state.agentSessionId).toBe(healthyId);
  });

  // docs/153 — when the leak repair fires but no resumable jsonl is found,
  // the override is explicit `null` and the DB row must be cleared so the
  // caller drops `--resume` from the next spawn.

  it("returns overrideAgentSessionId=null and clears the DB when the leak repair finds no resumable jsonl", async () => {
    // Real .claude/ dir, no orphan, but DB id has no matching jsonl AND
    // the only jsonl on disk is a stub (last-prompt/ai-title only) — the
    // exact prod state for 59d8c0bd/23edf3da.
    const account = path.join(tmpDir, "provider-accounts", "claude", "claude-default");
    fs.mkdirSync(path.join(account, ".claude"), { recursive: true });
    fs.writeFileSync(
      path.join(account, ".claude", ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { expiresAt: Date.now() + 60_000, accessToken: "FRESH" } }),
    );
    const sessionDir = path.join(tmpDir, "sessions", "s1");
    fs.mkdirSync(path.join(sessionDir, ".claude"), { recursive: true });
    fs.writeFileSync(
      path.join(sessionDir, ".claude", ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { expiresAt: Date.now() + 60_000, accessToken: "FRESH" } }),
    );
    const projectsDir = path.join(sessionDir, ".claude", "projects", "-workspace");
    fs.mkdirSync(projectsDir, { recursive: true });
    const stubSid = "856d63e4-stub-jsonl-no-user-no-assistant";
    fs.writeFileSync(
      path.join(projectsDir, `${stubSid}.jsonl`),
      `${JSON.stringify({ sessionId: stubSid, type: "last-prompt", prompt: "x" })}\n`,
    );

    const runner = new FakeContainerRunner();
    const credentialStore = makeFakeCredentialStore();
    const { sm, state } = makeFakeSessionManager({
      agentPinned: true,
      agentSessionId: "doomed-init-uuid-from-failed-resume",
      providerRouteKind: "account",
      providerRouteId: "claude-default",
    });

    const result = await prepareSessionAgentEnvironment(runner as unknown as SessionRunnerInterface, {
      sessionId: "s1",
      agentId: "claude",
      deps: { credentialsDir: tmpDir, credentialStore, sessionManager: sm },
    });

    expect(result.overrideAgentSessionId).toBeNull();
    expect(state.clearAgentSessionIdCalls).toEqual(["s1"]);
    expect(state.agentSessionId).toBeUndefined();
  });

  const codexThreadId = "019e8956-beff-7300-b553-6eff4f9e3ee6";
  const codexRolloutRel = path.join(
    "sessions", "2026", "06", "02", `rollout-2026-06-02T00-00-00-${codexThreadId}.jsonl`,
  );

  /**
   * Seed a Codex session whose `.codex` is a live leaked symlink, with the
   * orphan tree the CLI wrote through it. `withRollout` decides whether that
   * orphan carries the thread's durable rollout jsonl.
   */
  function seedLeakedCodexSession(withRollout: boolean): string {
    const account = path.join(tmpDir, "provider-accounts", "codex", "codex-default");
    fs.mkdirSync(path.join(account, ".codex"), { recursive: true });
    fs.writeFileSync(
      path.join(account, ".codex", "auth.json"),
      JSON.stringify({ last_refresh: "2026-06-02T00:00:00.000Z" }),
    );

    const sessionDir = path.join(tmpDir, "sessions", "s1");
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.symlinkSync(path.join(account, ".codex"), path.join(sessionDir, ".codex"));
    const orphan = path.join(sessionDir, "provider-accounts", "codex", "codex-default", ".codex");
    fs.mkdirSync(orphan, { recursive: true });
    fs.writeFileSync(
      path.join(orphan, "auth.json"),
      JSON.stringify({ last_refresh: "2026-06-01T00:00:00.000Z" }),
    );
    if (withRollout) {
      fs.mkdirSync(path.dirname(path.join(orphan, codexRolloutRel)), { recursive: true });
      fs.writeFileSync(path.join(orphan, codexRolloutRel), `${JSON.stringify({ id: codexThreadId })}\n`);
    }
    return sessionDir;
  }

  it("does not clear Codex agentSessionId when the repair preserves its rollout", async () => {
    // Production regression: a Codex session had a provider-account .codex
    // symlink repaired. The repair path found no Claude-style
    // .claude/projects jsonl and incorrectly cleared the generic
    // agent_session_id, so the next Codex turn started without thread/resume.
    // The Claude-shaped absence still must not speak for Codex — and now that
    // the repair actually preserves `.codex/sessions/**`, the thread's rollout
    // survives, so the pointer stays put.
    const sessionDir = seedLeakedCodexSession(true);

    const runner = new FakeContainerRunner();
    const credentialStore = makeFakeCredentialStore();
    const { sm, state } = makeFakeSessionManager({
      agentPinned: true,
      agentSessionId: codexThreadId,
      providerRouteKind: "account",
      providerRouteId: "codex-default",
    });

    const result = await prepareSessionAgentEnvironment(runner as unknown as SessionRunnerInterface, {
      sessionId: "s1",
      agentId: "codex",
      deps: { credentialsDir: tmpDir, credentialStore, sessionManager: sm },
    });

    expect(result.overrideAgentSessionId).toBeUndefined();
    expect(state.clearAgentSessionIdCalls).toHaveLength(0);
    expect(state.setAgentSessionIdCalls).toHaveLength(0);
    expect(state.agentSessionId).toBe(codexThreadId);
    expect(fs.lstatSync(path.join(sessionDir, ".codex")).isSymbolicLink()).toBe(false);
    // The rollout landed where the app-server reads it for `thread/resume`.
    expect(fs.existsSync(path.join(sessionDir, ".codex", codexRolloutRel))).toBe(true);
  });

  it("clears an unresumable Codex thread and arms a visible-history replay", async () => {
    // The recovery half: a session whose rollout was already destroyed would
    // otherwise `thread/resume` → -32600 "no rollout found" on every turn
    // forever (the adapter fails closed, by design). Detecting the missing
    // rollout before the spawn converts that permanent loop into one explicit
    // recovery — and the fresh thread is seeded from ShipIt's own transcript
    // rather than starting contextless.
    seedLeakedCodexSession(false);

    const runner = new FakeContainerRunner();
    const credentialStore = makeFakeCredentialStore();
    const { sm, state } = makeFakeSessionManager({
      agentPinned: true,
      agentSessionId: codexThreadId,
      providerRouteKind: "account",
      providerRouteId: "codex-default",
    });
    const chatHistoryManager = {
      load: () => [
        { role: "user" as const, text: "fix the flaky test" },
        { role: "assistant" as const, text: "Fixed it in foo.test.ts." },
      ],
      replaceInProgress: () => {},
    };

    const result = await prepareSessionAgentEnvironment(runner as unknown as SessionRunnerInterface, {
      sessionId: "s1",
      agentId: "codex",
      deps: { credentialsDir: tmpDir, credentialStore, sessionManager: sm, chatHistoryManager },
    });

    expect(result.overrideAgentSessionId).toBeNull();
    expect(state.clearAgentSessionIdCalls).toEqual(["s1"]);
    expect(state.conversationReplay).toContain("fix the flaky test");
    expect(state.conversationReplay).toContain("Fixed it in foo.test.ts.");
  });

  it("still clears an unresumable Codex thread when no chat history is wired", async () => {
    // Without the optional dep the replay is skipped, but the loop-breaking
    // clear must still happen — a session can never get stuck resume-looping.
    seedLeakedCodexSession(false);

    const runner = new FakeContainerRunner();
    const credentialStore = makeFakeCredentialStore();
    const { sm, state } = makeFakeSessionManager({
      agentPinned: true,
      agentSessionId: codexThreadId,
      providerRouteKind: "account",
      providerRouteId: "codex-default",
    });

    const result = await prepareSessionAgentEnvironment(runner as unknown as SessionRunnerInterface, {
      sessionId: "s1",
      agentId: "codex",
      deps: { credentialsDir: tmpDir, credentialStore, sessionManager: sm },
    });

    expect(result.overrideAgentSessionId).toBeNull();
    expect(state.clearAgentSessionIdCalls).toEqual(["s1"]);
    expect(state.conversationReplay).toBeUndefined();
  });

  // Warm-pool quick-session hang (docs/162 follow-up): the install gate
  // resolved, but a pre-spawn env-prep await never settled, so `agent.run()`
  // never fired and the worker never saw `/agent/start`. The fix bounds every
  // network/worker await in env-prep with a fail-open timeout. This proves the
  // load-bearing guarantee: a wedged worker secrets push CANNOT block the
  // function from returning — it resolves once the timeout fires.
  it("fails open (resolves) when the worker secrets push hangs forever", async () => {
    fs.mkdirSync(path.join(tmpDir, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, ".claude.json"), "{}");
    fs.writeFileSync(
      path.join(tmpDir, ".claude", ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { expiresAt: Date.now() + 60_000 } }),
    );

    const runner = new FakeContainerRunner();
    // Step 4's worker POST never settles — the exact hang the bug exhibited.
    runner.tryPushAgentSecrets = () => new Promise<void>(() => { /* never resolves */ });
    const credentialStore = makeFakeCredentialStore();
    // agentPinned skips step 1 provisioning; empty MCP tokens make step 3 a
    // no-op, isolating the step-4 hang.
    const { sm } = makeFakeSessionManager({ agentPinned: true, agentSessionId: "sid" });

    vi.useFakeTimers();
    try {
      let settled = false;
      const p = (async () => {
        const r = await prepareSessionAgentEnvironment(runner as unknown as SessionRunnerInterface, {
          sessionId: "s1",
          agentId: "claude",
          deps: { credentialsDir: tmpDir, credentialStore, sessionManager: sm },
        });
        settled = true;
        return r;
      })();

      // Before the timeout elapses the call is still pending (it really is
      // awaiting the hung push, not short-circuiting).
      await vi.advanceTimersByTimeAsync(PUSH_AGENT_SECRETS_TIMEOUT_MS - 1_000);
      expect(settled).toBe(false);

      // Once the fail-open timeout fires, the function resolves regardless.
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(p).resolves.toBeDefined();
      expect(settled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("pushes the merged agent env to the worker via the runner's tryPushAgentSecrets", async () => {
    fs.mkdirSync(path.join(tmpDir, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, ".claude.json"), "{}");
    fs.writeFileSync(
      path.join(tmpDir, ".claude", ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { expiresAt: Date.now() + 60_000 } }),
    );

    const runner = new FakeContainerRunner();
    const credentialStore = makeFakeCredentialStore({
      agentEnv: { OPENAI_API_KEY: "k1", mcp__notion: "k2" },
    });
    const { sm } = makeFakeSessionManager({ agentPinned: false });

    await prepareSessionAgentEnvironment(runner as unknown as SessionRunnerInterface, {
      sessionId: "s1",
      agentId: "claude",
      deps: { credentialsDir: tmpDir, credentialStore, sessionManager: sm },
    });
    expect(runner.pushed).toHaveLength(1);
    expect(runner.pushed[0]).toEqual({ OPENAI_API_KEY: "k1", mcp__notion: "k2" });
  });

  // docs/155 — per-repo Claude memory sharing. On first turn, the shared
  // `repo-memory/<hash>` dir is seeded into the session's memory subtree.

  const repoUrl = "https://github.com/example/memrepo.git";
  // Hash kept in lockstep with `repoUrlToHash` so the test asserts the real
  // on-disk location rather than a hand-computed one.
  const memDirOf = (root: string, url: string) =>
    path.join(root, "repo-memory", repoUrlToHash(url));
  const sessionMemoryOf = (root: string) =>
    path.join(root, "sessions", "s1", ".claude", "projects", "-workspace", "memory");

  function seedClaudeSource(root: string): void {
    fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(root, ".claude.json"), "{}");
    fs.writeFileSync(
      path.join(root, ".claude", ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { expiresAt: Date.now() + 60_000 } }),
    );
  }

  it("seeds the shared per-repo memory dir into the session on first Claude turn", async () => {
    seedClaudeSource(tmpDir);
    // Pre-existing shared memory for this repo (written by an earlier session).
    const shared = memDirOf(tmpDir, repoUrl);
    fs.mkdirSync(shared, { recursive: true });
    fs.writeFileSync(path.join(shared, "user-prefers-tabs.md"), "tabs");
    fs.writeFileSync(path.join(shared, "MEMORY.md"), "- [Tabs](user-prefers-tabs.md)");

    const runner = new FakeContainerRunner();
    const credentialStore = makeFakeCredentialStore();
    const { sm } = makeFakeSessionManager({ agentPinned: false, remoteUrl: repoUrl });

    await prepareSessionAgentEnvironment(runner as unknown as SessionRunnerInterface, {
      sessionId: "s1",
      agentId: "claude",
      deps: { credentialsDir: tmpDir, credentialStore, sessionManager: sm },
    });

    const sessionMemory = sessionMemoryOf(tmpDir);
    expect(fs.readFileSync(path.join(sessionMemory, "user-prefers-tabs.md"), "utf8")).toBe("tabs");
    expect(fs.existsSync(path.join(sessionMemory, "MEMORY.md"))).toBe(true);
  });

  it("creates an empty shared memory dir on first turn even when none exists yet", async () => {
    seedClaudeSource(tmpDir);
    const runner = new FakeContainerRunner();
    const credentialStore = makeFakeCredentialStore();
    const { sm } = makeFakeSessionManager({ agentPinned: false, remoteUrl: repoUrl });

    await prepareSessionAgentEnvironment(runner as unknown as SessionRunnerInterface, {
      sessionId: "s1",
      agentId: "claude",
      deps: { credentialsDir: tmpDir, credentialStore, sessionManager: sm },
    });

    expect(fs.existsSync(memDirOf(tmpDir, repoUrl))).toBe(true);
    expect(fs.existsSync(sessionMemoryOf(tmpDir))).toBe(true);
  });

  it("does NOT share memory for a session without a remote URL (memory stays ephemeral)", async () => {
    seedClaudeSource(tmpDir);
    const runner = new FakeContainerRunner();
    const credentialStore = makeFakeCredentialStore();
    const { sm } = makeFakeSessionManager({ agentPinned: false, remoteUrl: "" });

    await prepareSessionAgentEnvironment(runner as unknown as SessionRunnerInterface, {
      sessionId: "s1",
      agentId: "claude",
      deps: { credentialsDir: tmpDir, credentialStore, sessionManager: sm },
    });

    expect(fs.existsSync(path.join(tmpDir, "repo-memory"))).toBe(false);
    expect(fs.existsSync(sessionMemoryOf(tmpDir))).toBe(false);
  });

  it("does NOT create a Claude memory dir for a Codex session (docs/138 isolation)", async () => {
    // Codex source so provisioning has something to copy.
    fs.mkdirSync(path.join(tmpDir, ".codex"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, ".codex", "auth.json"), "{}");

    const runner = new FakeContainerRunner();
    const credentialStore = makeFakeCredentialStore();
    const { sm } = makeFakeSessionManager({ agentPinned: false, remoteUrl: repoUrl });

    await prepareSessionAgentEnvironment(runner as unknown as SessionRunnerInterface, {
      sessionId: "s1",
      agentId: "codex",
      deps: { credentialsDir: tmpDir, credentialStore, sessionManager: sm },
    });

    // No repo-memory dir, and no `.claude` subtree materialized in the session.
    expect(fs.existsSync(path.join(tmpDir, "repo-memory"))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, "sessions", "s1", ".claude"))).toBe(false);
  });
});

describe("finalizeSessionAgentEnvironment", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-env-final-"));
  });

  it("writes a CLI-refreshed token back to the orchestrator source", () => {
    fs.mkdirSync(path.join(tmpDir, ".claude"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, ".claude", ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { expiresAt: 1_000_000_000_000 } }),
    );
    const sessionDir = path.join(tmpDir, "sessions", "s1", ".claude");
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionDir, ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { expiresAt: 2_000_000_000_000, accessToken: "rotated" } }),
    );

    const runner = new FakeContainerRunner();
    const credentialStore = makeFakeCredentialStore();
    const { sm } = makeFakeSessionManager({ agentPinned: true });

    finalizeSessionAgentEnvironment(runner as unknown as SessionRunnerInterface, {
      sessionId: "s1",
      agentId: "claude",
      deps: { credentialsDir: tmpDir, credentialStore, sessionManager: sm },
    });
    const sourceCreds = fs.readFileSync(
      path.join(tmpDir, ".claude", ".credentials.json"),
      "utf8",
    );
    expect(sourceCreds).toContain("rotated");
  });

  it("is a no-op when the runner is not a ContainerSessionRunner", () => {
    const runner = new EventEmitter();
    const credentialStore = makeFakeCredentialStore();
    const { sm } = makeFakeSessionManager({ agentPinned: true });
    // Just confirm it doesn't throw — no source file exists, no creds to sync.
    expect(() =>
      finalizeSessionAgentEnvironment(runner as unknown as SessionRunnerInterface, {
        sessionId: "s1",
        agentId: "claude",
        deps: { credentialsDir: tmpDir, credentialStore, sessionManager: sm },
      }),
    ).not.toThrow();
  });

  // docs/155 — memory files the CLI wrote this turn are mirrored back to the
  // shared per-repo dir at turn end.
  it("mirrors a Claude session's new memory file back to the shared per-repo dir", () => {
    const repoUrl = "https://github.com/example/memrepo.git";
    const sessionMemory = path.join(
      tmpDir, "sessions", "s1", ".claude", "projects", "-workspace", "memory",
    );
    fs.mkdirSync(sessionMemory, { recursive: true });
    fs.writeFileSync(path.join(sessionMemory, "new-note.md"), "fresh insight");

    const runner = new FakeContainerRunner();
    const credentialStore = makeFakeCredentialStore();
    const { sm } = makeFakeSessionManager({ agentPinned: true, remoteUrl: repoUrl });

    finalizeSessionAgentEnvironment(runner as unknown as SessionRunnerInterface, {
      sessionId: "s1",
      agentId: "claude",
      deps: { credentialsDir: tmpDir, credentialStore, sessionManager: sm },
    });

    const sharedFile = path.join(tmpDir, "repo-memory", repoUrlToHash(repoUrl), "new-note.md");
    expect(fs.readFileSync(sharedFile, "utf8")).toBe("fresh insight");
  });

  it("does not sync memory back for a session without a remote URL", () => {
    const sessionMemory = path.join(
      tmpDir, "sessions", "s1", ".claude", "projects", "-workspace", "memory",
    );
    fs.mkdirSync(sessionMemory, { recursive: true });
    fs.writeFileSync(path.join(sessionMemory, "note.md"), "x");

    const runner = new FakeContainerRunner();
    const credentialStore = makeFakeCredentialStore();
    const { sm } = makeFakeSessionManager({ agentPinned: true, remoteUrl: "" });

    finalizeSessionAgentEnvironment(runner as unknown as SessionRunnerInterface, {
      sessionId: "s1",
      agentId: "claude",
      deps: { credentialsDir: tmpDir, credentialStore, sessionManager: sm },
    });

    expect(fs.existsSync(path.join(tmpDir, "repo-memory"))).toBe(false);
  });
});

// docs/179 — the runtime-401 recovery's unconditional token push.
//
// The state under test is the one the whole credential system is blind to: a
// session token whose `expiresAt` is LATER than the source's but whose grant is
// dead (a single-use refresh token a sibling container rotated first). Every
// guard in the system keys off `expiresAt`, which is a proxy for ordering and
// not for validity — so the ordinary per-turn sync-in reads the later timestamp
// and REFUSES to hand the session the good source token, and the quiet retry
// re-spawns on the identical dead credentials. That is the most likely reason
// most of the observed quiet retries failed.
describe("repushSessionAgentToken (docs/179 401 recovery)", () => {
  let tmpDir: string;

  const writeToken = (dir: string, marker: string, expiresAt: number): void => {
    const credDir = path.join(dir, ".claude");
    fs.mkdirSync(credDir, { recursive: true });
    fs.writeFileSync(
      path.join(credDir, ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { expiresAt, accessToken: marker } }),
    );
  };
  const readToken = (dir: string): string =>
    fs.readFileSync(path.join(dir, ".claude", ".credentials.json"), "utf8");

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-env-repush-"));
  });

  it("forces the source token in over a session token with a LATER expiry", () => {
    writeToken(tmpDir, "LIVE-SOURCE", 1_000_000_000_000);
    const sessionRoot = path.join(tmpDir, "sessions", "s1");
    writeToken(sessionRoot, "DEAD-BUT-LATER", 2_000_000_000_000);
    const { sm } = makeFakeSessionManager({ agentPinned: true });

    // Baseline: the guarded per-turn sync-in leaves the dead token in place —
    // this is the trap the recovery has to step around, not a bug in sync-in.
    syncAgentTokenIn(tmpDir, "s1", "claude");
    expect(readToken(sessionRoot)).toContain("DEAD-BUT-LATER");

    repushSessionAgentToken(new FakeContainerRunner() as unknown as SessionRunnerInterface, {
      sessionId: "s1",
      agentId: "claude",
      deps: { credentialsDir: tmpDir, sessionManager: sm },
    });

    expect(readToken(sessionRoot)).toContain("LIVE-SOURCE");
  });

  it("repushes from the pinned account's root for an account-routed session", () => {
    const accountRoot = path.join(tmpDir, "provider-accounts", "claude", "acct-a");
    writeToken(accountRoot, "ACCOUNT-A", 1_000_000_000_000);
    writeToken(tmpDir, "SHARED-ROOT", 1_000_000_000_000);
    const sessionRoot = path.join(tmpDir, "sessions", "s1");
    writeToken(sessionRoot, "DEAD-BUT-LATER", 2_000_000_000_000);
    const { sm } = makeFakeSessionManager({
      agentPinned: true,
      providerRouteKind: "account",
      providerRouteId: "acct-a",
    });

    repushSessionAgentToken(new FakeContainerRunner() as unknown as SessionRunnerInterface, {
      sessionId: "s1",
      agentId: "claude",
      deps: { credentialsDir: tmpDir, sessionManager: sm },
    });

    expect(readToken(sessionRoot)).toContain("ACCOUNT-A");
  });

  it("is a no-op for a non-container runner", () => {
    writeToken(tmpDir, "SOURCE", 1_000_000_000_000);
    const sessionRoot = path.join(tmpDir, "sessions", "s1");
    writeToken(sessionRoot, "UNTOUCHED", 2_000_000_000_000);
    const { sm } = makeFakeSessionManager({ agentPinned: true });

    repushSessionAgentToken(new EventEmitter() as unknown as SessionRunnerInterface, {
      sessionId: "s1",
      agentId: "claude",
      deps: { credentialsDir: tmpDir, sessionManager: sm },
    });

    expect(readToken(sessionRoot)).toContain("UNTOUCHED");
  });
});

/**
 * docs/153 — the mid-turn publisher's lifecycle is owned by the env-prep pair:
 * armed on the turn's own pre-spawn step, torn down at turn end. Publication
 * behavior itself is covered in `session-token-publisher.test.ts`; these tests
 * only pin the wiring, which is where a route or lifecycle mistake would hide.
 */
describe("mid-turn token write-back watch wiring", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-env-watch-"));
    fs.mkdirSync(path.join(tmpDir, ".claude"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, ".claude", ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { expiresAt: 2_000_000_000_000 } }),
    );
  });

  afterEach(() => {
    stopAllTokenWriteBackWatches();
  });

  async function prep(
    opts: {
      enforceAccountRouting?: boolean;
      providerRouteKind?: "account" | "reserved";
      providerRouteId?: string;
    },
  ): Promise<{ runner: FakeContainerRunner; sm: SessionManager }> {
    const runner = new FakeContainerRunner();
    const { sm } = makeFakeSessionManager({
      agentPinned: true,
      ...(opts.providerRouteKind ? { providerRouteKind: opts.providerRouteKind } : {}),
      ...(opts.providerRouteId ? { providerRouteId: opts.providerRouteId } : {}),
    });
    await prepareSessionAgentEnvironment(runner as unknown as SessionRunnerInterface, {
      sessionId: "s1",
      agentId: "claude",
      ...(opts.enforceAccountRouting ? { enforceAccountRouting: true } : {}),
      deps: { credentialsDir: tmpDir, credentialStore: makeFakeCredentialStore(), sessionManager: sm },
    });
    return { runner, sm };
  }

  it("arms on the turn's own pre-spawn step and disarms at turn end", async () => {
    const { runner, sm } = await prep({ enforceAccountRouting: true });
    expect(hasTokenWriteBackWatch("s1")).toBe(true);

    finalizeSessionAgentEnvironment(runner as unknown as SessionRunnerInterface, {
      sessionId: "s1",
      agentId: "claude",
      deps: { credentialsDir: tmpDir, credentialStore: makeFakeCredentialStore(), sessionManager: sm },
    });
    expect(hasTokenWriteBackWatch("s1")).toBe(false);
  });

  it("does not arm on a pre-turn warm-up call (no turn to publish for yet)", async () => {
    await prep({});
    expect(hasTokenWriteBackWatch("s1")).toBe(false);
  });

  it("skips the reserved claude-env-oauth route, like the sync-in does", async () => {
    await prep({
      enforceAccountRouting: true,
      providerRouteKind: "reserved",
      providerRouteId: "claude-env-oauth",
    });
    expect(hasTokenWriteBackWatch("s1")).toBe(false);
  });

  it("arms against the pinned account's source for an account-routed session", async () => {
    const accountSource = path.join(
      tmpDir, "provider-accounts", "claude", "acct-work", ".claude", ".credentials.json",
    );
    fs.mkdirSync(path.dirname(accountSource), { recursive: true });
    fs.writeFileSync(accountSource, JSON.stringify({ claudeAiOauth: { expiresAt: 1_000 } }));
    // The session's CLI rotated mid-turn — ahead of the account source.
    const sessionCreds = path.join(tmpDir, "sessions", "s1", ".claude", ".credentials.json");
    fs.mkdirSync(path.dirname(sessionCreds), { recursive: true });
    fs.writeFileSync(
      sessionCreds,
      JSON.stringify({ claudeAiOauth: { expiresAt: 2_000_000_000_000, accessToken: "rotated" } }),
    );

    await prep({
      enforceAccountRouting: true,
      providerRouteKind: "account",
      providerRouteId: "acct-work",
    });
    expect(hasTokenWriteBackWatch("s1")).toBe(true);

    // The arm-time catch-up publishes to the ACCOUNT source, never the legacy root.
    await vi.waitFor(() => {
      expect(fs.readFileSync(accountSource, "utf8")).toContain("rotated");
    }, { timeout: 3_000, interval: 20 });
    expect(fs.readFileSync(path.join(tmpDir, ".claude", ".credentials.json"), "utf8"))
      .not.toContain("rotated");
  });
});

describe("selectAgentEnvForPush (relocated from agent-execution.ts)", () => {
  it("returns the compose snapshot's agentValues when a ServiceManager is present", () => {
    const out = selectAgentEnvForPush({
      serviceManager: {
        // Only `agentValues` is read by the helper — keep the rest minimal.
        getSecretsSnapshot: () => ({
          agentValues: { STRIPE_KEY: "s" },
          declared: [],
          missingByService: {},
          missingRequired: [],
          agentNames: [],
        }),
      },
      credentialStore: makeFakeCredentialStore(),
    });
    expect(out).toEqual({ STRIPE_KEY: "s" });
  });

  it("falls back to the account-level credential set when there is no ServiceManager", () => {
    const out = selectAgentEnvForPush({
      serviceManager: null,
      credentialStore: makeFakeCredentialStore({
        agentEnv: { OPENAI_API_KEY: "k" },
      }),
    });
    expect(out).toEqual({ OPENAI_API_KEY: "k" });
  });
});

/**
 * nikzlabs/shipit#1874 — the docs/153 leak repair is destructive (unlink
 * `.claude`, re-copy from the source, merge the orphan, drop the orphan root).
 * That is fine immediately before a spawn and unsafe under a resident CLI,
 * which re-reads `.claude/.credentials.json` on every API call. These cover
 * the acceptance matrix: a legacy default-account link, a pinned non-default
 * account, repeated preparation (convergence), and streaming reuse.
 */
describe("credential topology under a resident agent (nikzlabs/shipit#1874)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-env-topology-"));
  });

  const CONVERSATION_ID = "c0ffee00-dead-beef-cafe-000000000001";

  /** A source account subtree holding a fresh, valid Claude token. */
  function seedAccount(accountId: string, accessToken: string): string {
    const root = path.join(tmpDir, "provider-accounts", "claude", accountId);
    fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
    fs.writeFileSync(
      path.join(root, ".claude", ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { expiresAt: Date.now() + 3_600_000, accessToken } }),
    );
    return root;
  }

  /** A resumable conversation jsonl, as the CLI writes it. */
  function seedConversation(claudeDir: string, id: string): void {
    const projects = path.join(claudeDir, "projects", "-workspace");
    fs.mkdirSync(projects, { recursive: true });
    fs.writeFileSync(
      path.join(projects, `${id}.jsonl`),
      `${JSON.stringify({ sessionId: id, type: "user", message: { content: "hi" } })}\n`
      + `${JSON.stringify({ sessionId: id, type: "assistant", message: { content: "hello" } })}\n`,
    );
  }

  function prepare(
    sessionManager: SessionManager,
    opts: { reusingResidentAgent?: boolean; accountId?: string } = {},
  ): Promise<{ overrideAgentSessionId?: string | null }> {
    return prepareSessionAgentEnvironment(
      new FakeContainerRunner() as unknown as SessionRunnerInterface,
      {
        sessionId: "s1",
        agentId: "claude",
        deps: {
          credentialsDir: tmpDir,
          credentialStore: makeFakeCredentialStore(),
          sessionManager,
        },
        ...(opts.reusingResidentAgent ? { reusingResidentAgent: true } : {}),
      },
    );
  }

  it("repairs a legacy default-account link once, then converges to a no-op", async () => {
    // The shape docs/153 describes: provisioning preserved the legacy alias as
    // a symlink, so the CLI — resolving it inside its Subpath-mounted namespace
    // — wrote its conversation into `<sessionDir>/provider-accounts/...`.
    seedAccount("claude-default", "FRESH");
    const sessionDir = path.join(tmpDir, "sessions", "s1");
    fs.mkdirSync(sessionDir, { recursive: true });
    const orphanClaude = path.join(
      sessionDir, "provider-accounts", "claude", "claude-default", ".claude",
    );
    fs.mkdirSync(orphanClaude, { recursive: true });
    seedConversation(orphanClaude, CONVERSATION_ID);
    fs.symlinkSync(
      path.join(tmpDir, "provider-accounts", "claude", "claude-default", ".claude"),
      path.join(sessionDir, ".claude"),
    );

    const { sm, state } = makeFakeSessionManager({
      agentPinned: true,
      agentSessionId: CONVERSATION_ID,
      providerRouteKind: "account",
      providerRouteId: "claude-default",
    });

    const first = await prepare(sm);

    // Converged: a real dir carrying the recovered conversation, orphan gone.
    expect(fs.lstatSync(path.join(sessionDir, ".claude")).isSymbolicLink()).toBe(false);
    expect(fs.existsSync(path.join(sessionDir, "provider-accounts"))).toBe(false);
    expect(fs.existsSync(
      path.join(sessionDir, ".claude", "projects", "-workspace", `${CONVERSATION_ID}.jsonl`),
    )).toBe(true);
    expect(first.overrideAgentSessionId).toBe(CONVERSATION_ID);

    // Criterion 2: a second preparation finds nothing to repair. The DB
    // pointer is left alone, which is what "at most once" looks like from the
    // caller's side — a repeat firing would re-report an override.
    const callsAfterFirst = state.setAgentSessionIdCalls.length;
    const second = await prepare(sm);
    expect(second.overrideAgentSessionId).toBeUndefined();
    expect(state.setAgentSessionIdCalls).toHaveLength(callsAfterFirst);
    expect(state.clearAgentSessionIdCalls).toHaveLength(0);
  });

  it("syncs the pinned non-default account's token, not the default's", async () => {
    seedAccount("claude-default", "DEFAULT-TOKEN");
    seedAccount("acct_second", "SECOND-TOKEN");
    const sessionDir = path.join(tmpDir, "sessions", "s1");
    fs.mkdirSync(path.join(sessionDir, ".claude"), { recursive: true });
    seedConversation(path.join(sessionDir, ".claude"), CONVERSATION_ID);

    const { sm } = makeFakeSessionManager({
      agentPinned: true,
      agentSessionId: CONVERSATION_ID,
      providerRouteKind: "account",
      providerRouteId: "acct_second",
    });

    await prepare(sm);

    const synced = JSON.parse(
      fs.readFileSync(path.join(sessionDir, ".claude", ".credentials.json"), "utf8"),
    ) as { claudeAiOauth: { accessToken: string } };
    expect(synced.claudeAiOauth.accessToken).toBe("SECOND-TOKEN");
  });

  it("does not touch the subtree under a resident agent, but still refreshes the token", async () => {
    // A leftover orphan tree (docs/153 Case 3) alongside a healthy real
    // `.claude` — the state a session sits in between repairs. On a reuse turn
    // the repair must stand down entirely; the token copy must not.
    seedAccount("claude-default", "ROTATED");
    const sessionDir = path.join(tmpDir, "sessions", "s1");
    fs.mkdirSync(path.join(sessionDir, ".claude"), { recursive: true });
    seedConversation(path.join(sessionDir, ".claude"), CONVERSATION_ID);
    fs.writeFileSync(
      path.join(sessionDir, ".claude", ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { expiresAt: Date.now() + 60_000, accessToken: "OLD" } }),
    );
    const orphanClaude = path.join(
      sessionDir, "provider-accounts", "claude", "claude-default", ".claude",
    );
    fs.mkdirSync(orphanClaude, { recursive: true });
    seedConversation(orphanClaude, CONVERSATION_ID);

    const { sm, state } = makeFakeSessionManager({
      agentPinned: true,
      agentSessionId: CONVERSATION_ID,
      providerRouteKind: "account",
      providerRouteId: "claude-default",
    });

    const result = await prepare(sm, { reusingResidentAgent: true });

    // Repair stood down: the orphan survives and the DB pointer is untouched.
    expect(fs.existsSync(orphanClaude)).toBe(true);
    expect(result.overrideAgentSessionId).toBeUndefined();
    expect(state.setAgentSessionIdCalls).toHaveLength(0);
    // ...but the rotated token still reached the live process (docs/142 A).
    const synced = JSON.parse(
      fs.readFileSync(path.join(sessionDir, ".claude", ".credentials.json"), "utf8"),
    ) as { claudeAiOauth: { accessToken: string } };
    expect(synced.claudeAiOauth.accessToken).toBe("ROTATED");

    // The very next spawn-shaped preparation does the deferred repair.
    await prepare(sm);
    expect(fs.existsSync(path.join(sessionDir, "provider-accounts"))).toBe(false);
  });

  it("never leaves a resident agent without credentials when the source subtree is missing", async () => {
    // The failure mechanism behind the report. On the repair path a leaked
    // symlink is unlinked FIRST and only then re-copied from the source — so a
    // source with no `.claude` leaves the session with no credentials at all,
    // and a CLI that re-reads the file mid-turn answers
    // `Not logged in · Please run /login`. Under reuse the repair never runs,
    // so the file the live process is reading stays where it is.
    fs.mkdirSync(path.join(tmpDir, "provider-accounts", "claude", "claude-default"), {
      recursive: true,
    });
    const sessionDir = path.join(tmpDir, "sessions", "s1");
    fs.mkdirSync(sessionDir, { recursive: true });
    const leakedTarget = path.join(
      sessionDir, "provider-accounts", "claude", "claude-default", ".claude",
    );
    fs.mkdirSync(leakedTarget, { recursive: true });
    fs.writeFileSync(
      path.join(leakedTarget, ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { expiresAt: Date.now() + 60_000, accessToken: "LIVE" } }),
    );
    seedConversation(leakedTarget, CONVERSATION_ID);
    fs.symlinkSync(
      path.join(tmpDir, "provider-accounts", "claude", "claude-default", ".claude"),
      path.join(sessionDir, ".claude"),
    );

    const { sm } = makeFakeSessionManager({
      agentPinned: true,
      agentSessionId: CONVERSATION_ID,
      providerRouteKind: "account",
      providerRouteId: "claude-default",
    });

    await prepare(sm, { reusingResidentAgent: true });

    // The live CLI's credentials are still readable through the path it opened.
    expect(fs.existsSync(path.join(leakedTarget, ".credentials.json"))).toBe(true);
    expect(fs.lstatSync(path.join(sessionDir, ".claude")).isSymbolicLink()).toBe(true);
  });
});

// Silence vi import lint when no `vi` calls remain after refactors.
void vi;
