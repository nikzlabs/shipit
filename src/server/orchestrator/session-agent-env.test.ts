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
import type { CredentialRoute } from "../shared/types.js";
import { ContainerSessionRunner } from "./container-session-runner.js";
import {
  prepareSessionAgentEnvironment,
  finalizeSessionAgentEnvironment,
  repushSessionAgentToken,
  selectAgentEnvForPush,
  PUSH_AGENT_SECRETS_TIMEOUT_MS,
} from "./session-agent-env.js";
import { syncAgentTokenIn } from "./session-credentials.js";
import {
  readSessionAccountMarker,
  writeSessionAccountMarker,
} from "./session-agent-credentials.js";
import { resetLocalAgentOpsForTests } from "./local-agent-ops.js";
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
  /** docs/260 §5 — env-prep stamps the turn's selection here before the spawn. */
  residentRoute?: { kind: "account" | "reserved"; id: string };
  async tryPushAgentSecrets(values: Record<string, string>): Promise<void> {
    this.pushed.push(values);
  }
}
// Reparent the fake so `runner instanceof ContainerSessionRunner` is true —
// the helper's container-only branches are otherwise unreachable from tests.
Object.setPrototypeOf(FakeContainerRunner.prototype, ContainerSessionRunner.prototype);

function makeFakeCredentialStore(
  initial: {
    agentEnv?: Record<string, string>;
    // docs/252 phase 2 — the stored service credentials, which are collected
    // separately from `agentEnv` and land under their catalogue `storageEnv`
    // names.
    credentialRoutes?: CredentialRoute[];
    credentialSecrets?: Record<string, string>;
  } = {},
): CredentialStore {
  const agentEnv = { ...(initial.agentEnv ?? {}) };
  const routes = initial.credentialRoutes ?? [];
  const secrets = { ...(initial.credentialSecrets ?? {}) };
  const stub = {
    getAllAgentEnv: () => ({ ...agentEnv }),
    getAllMcpOAuthTokens: () => ({}),
    getAllMcpServers: () => ({}),
    getAgentSystemInstructionsEnabled: () => true,
    getAutoCreatePr: () => false,
    listCredentialRoutes: () => routes.map((r) => ({ ...r })),
    getCredentialSecret: (routeId: string) => secrets[routeId],
    // docs/252 phase 5 — env prep asks whether the pinned credential is benched
    // and stamps the one it resolved onto.
    getCredentialRoute: (routeId: string) => {
      const found = routes.find((r) => r.id === routeId);
      return found ? { ...found } : undefined;
    },
    markCredentialRouteUsed: (routeId: string) => {
      const found = routes.find((r) => r.id === routeId);
      if (found) found.lastUsedAt = Date.now();
    },
    getSelectionMode: () => "strict" as const,
  };
  return stub as unknown as CredentialStore;
}

/**
 * docs/260 — env-prep's routing dependency, faked at the seam a turn actually
 * calls: `selectAccountForTurn` answers the walk (accounts first, reserved env
 * fallback last) and `markAccountUsed` receives the lastUsedAt stamp. The
 * session row no longer carries a route to pre-set, so a test pins a specific
 * account by making it this walk's answer — exactly how production pins one
 * (the only ready account, or the highest priority).
 */
function fakeAccountManager(
  selection:
    | { ok: true; route: { kind: "account" | "reserved"; id: string } }
    | { ok: false; reason: "auth_required" }
    | { ok: false; reason: "all_exhausted"; earliestResetAt: string | null },
): { selectAccountForTurn: ReturnType<typeof vi.fn>; markAccountUsed: ReturnType<typeof vi.fn> } {
  return {
    selectAccountForTurn: vi.fn().mockReturnValue(selection),
    markAccountUsed: vi.fn(),
  };
}

function makeFakeSessionManager(opts: {
  agentPinned: boolean;
  agentSessionId?: string;
  providerRouteKind?: "account" | "reserved";
  providerRouteId?: string;
  remoteUrl?: string;
  model?: string;
  /** Extra session-row fields (docs/252: the selection triple, route ownership). */
  extra?: Record<string, unknown>;
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
      ...(opts.extra ?? {}),
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

  afterEach(() => {
    // Turn-shaped calls (enforceAccountRouting) arm the mid-turn write-back
    // watch as a side effect; drop them so no watcher outlives its test.
    stopAllTokenWriteBackWatches();
  });

  it("provisions legacy flat credentials + scaffolds once on the first routed turn, skips both on the second (docs/260 — agentPinned gates only the legacy branch)", async () => {
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
      enforceAccountRouting: true,
      deps: { credentialsDir: tmpDir, credentialStore, sessionManager: sm },
    });
    expect(state.setAgentIdCalls).toBe(1);
    expect(state.setAgentPinnedCalls).toBe(1);
    const provisioned = fs.existsSync(path.join(tmpDir, "sessions", "s1", ".claude.json"));
    expect(provisioned).toBe(true);

    // Second turn: session is now pinned, so re-provisioning is a no-op.
    // Clobber the session's `.claude.json` to prove we didn't re-copy.
    fs.writeFileSync(path.join(tmpDir, "sessions", "s1", ".claude.json"), "sentinel");
    await prepareSessionAgentEnvironment(runner as unknown as SessionRunnerInterface, {
      sessionId: "s1",
      agentId: "claude",
      enforceAccountRouting: true,
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
      enforceAccountRouting: true,
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
      enforceAccountRouting: true,
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
    });

    // docs/260 — the account-scoped sync (and with it the repair) follows THIS
    // call's own selection, not a session row; the repair only runs on a turn.
    const result = await prepareSessionAgentEnvironment(runner as unknown as SessionRunnerInterface, {
      sessionId: "s1",
      agentId: "claude",
      enforceAccountRouting: true,
      deps: {
        credentialsDir: tmpDir,
        credentialStore,
        sessionManager: sm,
        providerAccountManager: fakeAccountManager({
          ok: true, route: { kind: "account", id: "claude-default" },
        }) as never,
      },
    });

    expect(result.overrideAgentSessionId).toBe(recoveredId);
    // DB row was also updated (so the listener's agent_result write resolves
    // to the right value too — but the spawn-arg override is the primary fix).
    expect(state.setAgentSessionIdCalls).toContainEqual({ id: "s1", value: recoveredId });
    expect(state.agentSessionId).toBe(recoveredId);
  });

  it("selects the turn's route fresh, returns it as turnRoute, and never persists a session route (docs/260 reqs 1–2)", async () => {
    // Every routed turn asks the walk at its own start — an agent-spawned
    // child, a follow-up turn, and a first turn all take the same path, so a
    // child never rides its parent's account and nothing fixes a session to
    // an account across turns. The choice is handed back as a VALUE
    // (`turnRoute`) and stamped on the runner; the session row records
    // nothing.
    const account = path.join(tmpDir, "provider-accounts", "claude", "acct-primary");
    fs.mkdirSync(path.join(account, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(account, ".claude", ".credentials.json"), "{}");

    const runner = new FakeContainerRunner();
    const credentialStore = makeFakeCredentialStore();
    const { sm, state } = makeFakeSessionManager({ agentPinned: false });
    const manager = fakeAccountManager({ ok: true, route: { kind: "account", id: "acct-primary" } });

    const result = await prepareSessionAgentEnvironment(runner as unknown as SessionRunnerInterface, {
      sessionId: "s1",
      agentId: "claude",
      enforceAccountRouting: true,
      deps: {
        credentialsDir: tmpDir,
        credentialStore,
        sessionManager: sm,
        providerAccountManager: manager as never,
      },
    });

    // Optimistic, always (req 12): the result WILL be attempted, so refusal
    // memory may order candidates but never produce all_exhausted on its own.
    expect(manager.selectAccountForTurn).toHaveBeenCalledWith("anthropic", { optimistic: true });
    expect(result.turnRoute).toEqual({ kind: "account", id: "acct-primary" });
    expect(runner.residentRoute).toEqual({ kind: "account", id: "acct-primary" });
    // lastUsedAt stamped on the account the turn resolved onto (docs/150 req 21).
    expect(manager.markAccountUsed).toHaveBeenCalledWith("anthropic", "acct-primary");
    // req 2 — no session pin exists, so none may be written.
    expect(state.setProviderRouteCalls).toEqual([]);
    // Per-turn provisioning came from the routed account and recorded it in
    // the session's marker (docs/260 §4).
    expect(
      fs.existsSync(path.join(tmpDir, "sessions", "s1", ".claude", ".credentials.json")),
    ).toBe(true);
    expect(readSessionAccountMarker(tmpDir, "s1").claude).toBe("acct-primary");
  });

  it("re-runs selection on every turn — legacy provider_route_* row values are never consulted (docs/260 req 1)", async () => {
    // The session row's provider_route_* columns survive only as dead legacy.
    // A row still naming another account must not steer the turn: the walk's
    // fresh answer wins, every time.
    const account = path.join(tmpDir, "provider-accounts", "claude", "acct-primary");
    fs.mkdirSync(path.join(account, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(account, ".claude", ".credentials.json"), "{}");

    const runner = new FakeContainerRunner();
    const credentialStore = makeFakeCredentialStore();
    const { sm, state } = makeFakeSessionManager({
      agentPinned: true,
      providerRouteKind: "account",
      providerRouteId: "acct-secondary",
    });
    const manager = fakeAccountManager({ ok: true, route: { kind: "account", id: "acct-primary" } });

    const result = await prepareSessionAgentEnvironment(runner as unknown as SessionRunnerInterface, {
      sessionId: "s1",
      agentId: "claude",
      enforceAccountRouting: true,
      deps: {
        credentialsDir: tmpDir,
        credentialStore,
        sessionManager: sm,
        providerAccountManager: manager as never,
      },
    });

    expect(manager.selectAccountForTurn).toHaveBeenCalledTimes(1);
    expect(result.turnRoute).toEqual({ kind: "account", id: "acct-primary" });
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
    const manager = fakeAccountManager({ ok: true, route: { kind: "account", id: "acct-a" } });

    await prepareSessionAgentEnvironment(runner as unknown as SessionRunnerInterface, {
      sessionId: "s1",
      agentId: "claude",
      enforceAccountRouting: true,
      deps: {
        credentialsDir: tmpDir,
        credentialStore,
        sessionManager: sm,
        providerAccountManager: manager as never,
      },
    });

    // The walk hears the service and the attempt-loop options — never a model.
    expect(manager.selectAccountForTurn).toHaveBeenCalledWith("anthropic", { optimistic: true });
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

  // docs/260 req 11 — the string-delivered twin of the account walk. A
  // subscription authenticated by a supplied key (the GLM coding plan) is
  // selected per turn through the SAME walk: refusal memory is the only skip
  // (blocked while now < min(exhaustedUntil, exhaustedAt + ~30 min)), nothing
  // is persisted onto the session between turns, and only credentials the
  // provider actually refused this turn (the attempt loop's exclusion set)
  // can produce the terminal failure.
  describe("string-delivered subscription credentials are routed per turn (docs/260 req 11)", () => {
    const glmRoutes = (primary: Partial<CredentialRoute> = {}): CredentialRoute[] => [
      {
        id: "cred_a", serviceId: "zai", billingMode: "sub", via: "string", label: "Plan A",
        isPrimary: true, priority: 0, status: "ready", createdAt: 0, updatedAt: 0,
        ...primary,
      },
      {
        id: "cred_b", serviceId: "zai", billingMode: "sub", via: "string", label: "Plan B",
        isPrimary: false, priority: 1, status: "ready", createdAt: 0, updatedAt: 0,
      },
    ];
    const glmSession = { serviceId: "zai", billingMode: "sub" };

    async function prepGlm(
      routes: CredentialRoute[],
      opts: { turn?: boolean; excludeRouteIds?: string[] } = {},
    ): Promise<{
      result: Awaited<ReturnType<typeof prepareSessionAgentEnvironment>>;
      state: { setProviderRouteCalls: { id: string; kind: string; routeId: string }[] };
      runner: FakeContainerRunner;
    }> {
      const runner = new FakeContainerRunner();
      const credentialStore = makeFakeCredentialStore({
        credentialRoutes: routes,
        credentialSecrets: { cred_a: "k1", cred_b: "k2" },
      });
      const { sm, state } = makeFakeSessionManager({
        agentPinned: true,
        model: "glm-5.2[1m]",
        extra: glmSession,
      });
      const result = await prepareSessionAgentEnvironment(runner as unknown as SessionRunnerInterface, {
        sessionId: "s1",
        agentId: "claude",
        ...(opts.turn === false ? {} : { enforceAccountRouting: true }),
        ...(opts.excludeRouteIds ? { excludeRouteIds: opts.excludeRouteIds } : {}),
        deps: { credentialsDir: tmpDir, credentialStore, sessionManager: sm },
      });
      return { result, state, runner };
    }

    it("routes the turn onto the next credential when the primary is refusal-blocked, stamping lastUsedAt (reqs 9, 11)", async () => {
      const now = Date.now();
      const routes = glmRoutes({ exhaustedUntil: now + 3_600_000, exhaustedAt: now });

      const { result, state } = await prepGlm(routes);

      expect(result.turnRoute).toEqual({ kind: "reserved", id: "cred_b" });
      // The credential the turn authenticates with is the one `balanced`
      // sorts by — attribution and authentication name the same credential.
      expect(routes.find((r) => r.id === "cred_b")?.lastUsedAt).toBeDefined();
      // The move is a per-turn fact; nothing is persisted onto the session (req 1).
      expect(state.setProviderRouteCalls).toEqual([]);
    });

    it("keeps a healthy primary, per turn, with nothing persisted", async () => {
      const now = Date.now();
      const routes = glmRoutes({ exhaustedUntil: now - 1, exhaustedAt: now - 3_600_000 });

      const { result, state } = await prepGlm(routes);

      expect(result.turnRoute).toEqual({ kind: "reserved", id: "cred_a" });
      expect(state.setProviderRouteCalls).toEqual([]);
    });

    it("treats a legacy bench with no exhaustedAt clock as expired (docs/260 migration)", async () => {
      // Pre-260 string benches never wrote the clock. The read rule requires
      // both halves, so a clockless bench cannot block — which is exactly how
      // the permanently-stuck legacy rows self-heal on deploy.
      const routes = glmRoutes({ exhaustedUntil: Date.now() + 3_600_000 });

      const { result } = await prepGlm(routes);

      expect(result.turnRoute).toEqual({ kind: "reserved", id: "cred_a" });
    });

    it("still returns the best blocked credential when every one is refusal-blocked (req 12)", async () => {
      // Selection is optimistic on the turn's own preflight: remembered
      // refusals may order candidates but never block a turn on a credential
      // that was not actually tried this turn (req 5).
      const now = Date.now();
      const routes = glmRoutes({ exhaustedUntil: now + 3_600_000, exhaustedAt: now });
      routes[1]!.exhaustedUntil = now + 3_600_000;
      routes[1]!.exhaustedAt = now;

      const { result } = await prepGlm(routes);

      expect(result.turnRoute).toEqual({ kind: "reserved", id: "cred_a" });
    });

    it("blocks the turn only when every credential was actually refused THIS turn (reqs 6, 12)", async () => {
      // The attempt loop excludes each refused route as it goes; only a
      // selection with every candidate excluded may fail. Names the SERVICE,
      // not the harness: "every connected Claude account is out of quota" is
      // wrong for a spent GLM plan running on the Claude harness.
      const now = Date.now();
      const routes = glmRoutes({ exhaustedUntil: now + 3_600_000, exhaustedAt: now });
      routes[1]!.exhaustedUntil = now + 3_600_000;
      routes[1]!.exhaustedAt = now;

      await expect(
        prepGlm(routes, { excludeRouteIds: ["cred_a", "cred_b"] }),
      ).rejects.toThrow(/Every GLM \(Z\.ai\) credential is out of quota/);
    });

    it("selects and stamps nothing on a pre-turn warm-up (docs/260 §5b)", async () => {
      // The warm-up calls (child spawn, headless create, CI fix, wake) leave
      // `enforceAccountRouting` unset: account-neutral by design, so they can
      // never double-select against the real turn moments later.
      const routes = glmRoutes();

      const { result } = await prepGlm(routes, { turn: false });

      expect(result.turnRoute).toBeUndefined();
      expect(routes.every((r) => r.lastUsedAt === undefined)).toBe(true);
    });
  });

  // The service-level warm-up calls (child spawn, headless create, CI fix,
  // wake) run before the turn exists. docs/260 §5b splits env prep in two:
  // the warm-up half is ACCOUNT-NEUTRAL — it selects nothing, provisions
  // nothing, and stamps nothing (so it can neither throw a routing failure
  // nor double-select against the real turn moments later); only the MCP
  // refresh and the secrets push still run.
  it("a warm-up call is account-neutral: selects, provisions, and pins nothing (docs/260 §5b)", async () => {
    fs.mkdirSync(path.join(tmpDir, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, ".claude.json"), "{}");

    const runner = new FakeContainerRunner();
    const credentialStore = makeFakeCredentialStore();
    const { sm, state } = makeFakeSessionManager({ agentPinned: false });
    const manager = fakeAccountManager({ ok: true, route: { kind: "account", id: "acct-a" } });

    const result = await prepareSessionAgentEnvironment(runner as unknown as SessionRunnerInterface, {
      sessionId: "s1",
      agentId: "claude",
      deps: {
        credentialsDir: tmpDir,
        credentialStore,
        sessionManager: sm,
        providerAccountManager: manager as never,
      },
    });

    expect(manager.selectAccountForTurn).not.toHaveBeenCalled();
    expect(result.turnRoute).toBeUndefined();
    expect(manager.markAccountUsed).not.toHaveBeenCalled();
    expect(state.setProviderRouteCalls).toEqual([]);
    expect(state.setAgentPinnedCalls).toBe(0);
    expect(state.setAgentIdCalls).toBe(0);
    expect(fs.existsSync(path.join(tmpDir, "sessions", "s1"))).toBe(false);
    // The account-neutral half still ran: the merged agent env reached the worker.
    expect(runner.pushed).toHaveLength(1);
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
    });
    // The subtree already belongs to the account this turn's selection lands
    // on (docs/260 §4 — the marker, not the session row, records identity).
    writeSessionAccountMarker(tmpDir, "s1", "claude", "claude-default");

    const result = await prepareSessionAgentEnvironment(runner as unknown as SessionRunnerInterface, {
      sessionId: "s1",
      agentId: "claude",
      enforceAccountRouting: true,
      deps: {
        credentialsDir: tmpDir,
        credentialStore,
        sessionManager: sm,
        providerAccountManager: fakeAccountManager({
          ok: true, route: { kind: "account", id: "claude-default" },
        }) as never,
      },
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
    });
    writeSessionAccountMarker(tmpDir, "s1", "claude", "claude-default");

    const result = await prepareSessionAgentEnvironment(runner as unknown as SessionRunnerInterface, {
      sessionId: "s1",
      agentId: "claude",
      enforceAccountRouting: true,
      deps: {
        credentialsDir: tmpDir,
        credentialStore,
        sessionManager: sm,
        providerAccountManager: fakeAccountManager({
          ok: true, route: { kind: "account", id: "claude-default" },
        }) as never,
      },
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
    });

    const result = await prepareSessionAgentEnvironment(runner as unknown as SessionRunnerInterface, {
      sessionId: "s1",
      agentId: "codex",
      enforceAccountRouting: true,
      deps: {
        credentialsDir: tmpDir,
        credentialStore,
        sessionManager: sm,
        providerAccountManager: fakeAccountManager({
          ok: true, route: { kind: "account", id: "codex-default" },
        }) as never,
      },
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
    });
    const chatHistoryManager = {
      load: () => [
        { role: "user" as const, text: "fix the flaky test" },
        { role: "assistant" as const, text: "Fixed it in foo.test.ts." },
      ],
      replaceInProgress: () => {},
      append: () => 0,
    };

    const result = await prepareSessionAgentEnvironment(runner as unknown as SessionRunnerInterface, {
      sessionId: "s1",
      agentId: "codex",
      enforceAccountRouting: true,
      deps: {
        credentialsDir: tmpDir,
        credentialStore,
        sessionManager: sm,
        chatHistoryManager,
        providerAccountManager: fakeAccountManager({
          ok: true, route: { kind: "account", id: "codex-default" },
        }) as never,
      },
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
    });

    const result = await prepareSessionAgentEnvironment(runner as unknown as SessionRunnerInterface, {
      sessionId: "s1",
      agentId: "codex",
      enforceAccountRouting: true,
      deps: {
        credentialsDir: tmpDir,
        credentialStore,
        sessionManager: sm,
        providerAccountManager: fakeAccountManager({
          ok: true, route: { kind: "account", id: "codex-default" },
        }) as never,
      },
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

    // docs/260 — memory seeding is turn-bound (`agentPinned` still gates it to
    // the FIRST routed turn), so the flag is required.
    await prepareSessionAgentEnvironment(runner as unknown as SessionRunnerInterface, {
      sessionId: "s1",
      agentId: "claude",
      enforceAccountRouting: true,
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
      enforceAccountRouting: true,
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
      enforceAccountRouting: true,
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
      enforceAccountRouting: true,
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

  it("writes back to the route captured for the turn, not a later session route", () => {
    const accountRoot = (id: string) =>
      path.join(tmpDir, "provider-accounts", "claude", id, ".claude");
    for (const [id, token] of [["acct-a", "A"], ["acct-b", "B"]] as const) {
      fs.mkdirSync(accountRoot(id), { recursive: true });
      fs.writeFileSync(
        path.join(accountRoot(id), ".credentials.json"),
        JSON.stringify({ claudeAiOauth: { expiresAt: 1_000_000_000_000, accessToken: token } }),
      );
    }
    const sessionDir = path.join(tmpDir, "sessions", "s1", ".claude");
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionDir, ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { expiresAt: 2_000_000_000_000, accessToken: "A-rotated" } }),
    );

    const runner = new FakeContainerRunner();
    const credentialStore = makeFakeCredentialStore();
    // The persisted row moved after this process started. Re-reading it here
    // used to copy A's token into B's account root.
    const { sm } = makeFakeSessionManager({
      agentPinned: true,
      providerRouteKind: "account",
      providerRouteId: "acct-b",
    });

    finalizeSessionAgentEnvironment(runner as unknown as SessionRunnerInterface, {
      sessionId: "s1",
      agentId: "claude",
      capturedRoute: { providerRouteKind: "account", providerRouteId: "acct-a" },
      deps: { credentialsDir: tmpDir, credentialStore, sessionManager: sm },
    });

    expect(fs.readFileSync(path.join(accountRoot("acct-a"), ".credentials.json"), "utf8"))
      .toContain("A-rotated");
    expect(fs.readFileSync(path.join(accountRoot("acct-b"), ".credentials.json"), "utf8"))
      .toContain('"accessToken":"B"');
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

  it("repushes from the account recorded in the session's credential marker (docs/260)", () => {
    // The session row records no route any more; the subtree's own marker
    // (written by the only provisioning writer) names the account whose token
    // the session holds — so the recovery pushes THAT account's source, never
    // the flat root's, over the dead copy.
    const accountRoot = path.join(tmpDir, "provider-accounts", "claude", "acct-a");
    writeToken(accountRoot, "ACCOUNT-A", 1_000_000_000_000);
    writeToken(tmpDir, "SHARED-ROOT", 1_000_000_000_000);
    const sessionRoot = path.join(tmpDir, "sessions", "s1");
    writeToken(sessionRoot, "DEAD-BUT-LATER", 2_000_000_000_000);
    writeSessionAccountMarker(tmpDir, "s1", "claude", "acct-a");
    const { sm } = makeFakeSessionManager({ agentPinned: true });

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
      /**
       * docs/260 — the route THIS call's own selection resolves. The session
       * row is no longer consulted, so a test pins the route by making it the
       * walk's answer.
       */
      selection?: { kind: "account" | "reserved"; id: string };
    },
  ): Promise<{ runner: FakeContainerRunner; sm: SessionManager }> {
    const runner = new FakeContainerRunner();
    const { sm } = makeFakeSessionManager({ agentPinned: true });
    await prepareSessionAgentEnvironment(runner as unknown as SessionRunnerInterface, {
      sessionId: "s1",
      agentId: "claude",
      ...(opts.enforceAccountRouting ? { enforceAccountRouting: true } : {}),
      deps: {
        credentialsDir: tmpDir,
        credentialStore: makeFakeCredentialStore(),
        sessionManager: sm,
        ...(opts.selection
          ? { providerAccountManager: fakeAccountManager({ ok: true, route: opts.selection }) as never }
          : {}),
      },
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
    // What a real selection resolves when ANTHROPIC_AUTH_TOKEN is the only
    // credential (no accounts connected) — those credentials aren't ours to
    // write, so no watch may arm.
    await prep({
      enforceAccountRouting: true,
      selection: { kind: "reserved", id: "claude-env-oauth" },
    });
    expect(hasTokenWriteBackWatch("s1")).toBe(false);
  });

  it("arms against the routed account's source for an account turn", async () => {
    const accountSource = path.join(
      tmpDir, "provider-accounts", "claude", "acct-work", ".claude", ".credentials.json",
    );
    fs.mkdirSync(path.dirname(accountSource), { recursive: true });
    fs.writeFileSync(accountSource, JSON.stringify({ claudeAiOauth: { expiresAt: 1_000 } }));
    // The session's CLI rotated mid-turn — ahead of the account source. The
    // marker names the account so the per-turn identity check reads "match"
    // and leaves the rotated copy in place (docs/260 §4).
    const sessionCreds = path.join(tmpDir, "sessions", "s1", ".claude", ".credentials.json");
    fs.mkdirSync(path.dirname(sessionCreds), { recursive: true });
    fs.writeFileSync(
      sessionCreds,
      JSON.stringify({ claudeAiOauth: { expiresAt: 2_000_000_000_000, accessToken: "rotated" } }),
    );
    writeSessionAccountMarker(tmpDir, "s1", "claude", "acct-work");

    await prep({
      enforceAccountRouting: true,
      selection: { kind: "account", id: "acct-work" },
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

  // docs/252 phase 5 — a snapshot taken before the per-credential names existed
  // makes a shaped turn find no credential and raise `auth_required`, because
  // spawn shaping now sources the PINNED credential from its own variable. Every
  // session already holding a compose stack was in that state on the deploy that
  // shipped this, and `syncSecrets` does not necessarily run before the next turn.
  it("merges a per-credential name a stale compose snapshot is missing", () => {
    const stored: CredentialRoute = {
      id: "cred_ds", serviceId: "deepseek", billingMode: "key", via: "string",
      label: "Key", isPrimary: true, priority: 0, status: "ready", createdAt: 0, updatedAt: 0,
    };
    const out = selectAgentEnvForPush({
      serviceManager: {
        getSecretsSnapshot: () => ({
          agentValues: { STRIPE_KEY: "s" },
          declared: [],
          missingByService: {},
          missingRequired: [],
          agentNames: [],
        }),
      },
      credentialStore: makeFakeCredentialStore({
        credentialRoutes: [stored],
        credentialSecrets: { cred_ds: "sk-ds" },
      }),
    });
    expect(out.SHIPIT_CREDENTIAL_CRED_DS).toBe("sk-ds");
    // The group name is NOT merged: a compose file can legitimately declare its
    // own `DEEPSEEK_API_KEY`, and the snapshot is authoritative for it.
    expect(out.DEEPSEEK_API_KEY).toBeUndefined();
  });

  it("overwrites a ROTATED per-credential value the snapshot still carries", () => {
    // Found by cross-backend review. Filling only the gap would keep pushing the
    // old secret after a rotation: the name is present in the stale snapshot, so
    // nothing replaces it, and a broken compose file means no sync ever will —
    // a revoked key delivered indefinitely.
    const stored: CredentialRoute = {
      id: "cred_ds", serviceId: "deepseek", billingMode: "key", via: "string",
      label: "Key", isPrimary: true, priority: 0, status: "ready", createdAt: 0, updatedAt: 0,
    };
    const out = selectAgentEnvForPush({
      serviceManager: {
        getSecretsSnapshot: () => ({
          agentValues: { SHIPIT_CREDENTIAL_CRED_DS: "sk-old" },
          declared: [],
          missingByService: {},
          missingRequired: [],
          agentNames: [],
        }),
      },
      credentialStore: makeFakeCredentialStore({
        credentialRoutes: [stored],
        credentialSecrets: { cred_ds: "sk-rotated" },
      }),
    });
    expect(out.SHIPIT_CREDENTIAL_CRED_DS).toBe("sk-rotated");
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

  afterEach(() => {
    stopAllTokenWriteBackWatches();
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

  /**
   * A turn-shaped preparation. docs/260 — the route comes from this call's own
   * selection (`accountId`, default the legacy-named `claude-default`), never
   * from a session row.
   */
  function prepare(
    sessionManager: SessionManager,
    opts: { reusingResidentAgent?: boolean; accountId?: string } = {},
  ): Promise<{ overrideAgentSessionId?: string | null }> {
    return prepareSessionAgentEnvironment(
      new FakeContainerRunner() as unknown as SessionRunnerInterface,
      {
        sessionId: "s1",
        agentId: "claude",
        enforceAccountRouting: true,
        deps: {
          credentialsDir: tmpDir,
          credentialStore: makeFakeCredentialStore(),
          sessionManager,
          providerAccountManager: fakeAccountManager({
            ok: true,
            route: { kind: "account", id: opts.accountId ?? "claude-default" },
          }) as never,
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

  it("syncs the routed non-default account's token, not the default's", async () => {
    seedAccount("claude-default", "DEFAULT-TOKEN");
    seedAccount("acct_second", "SECOND-TOKEN");
    const sessionDir = path.join(tmpDir, "sessions", "s1");
    fs.mkdirSync(path.join(sessionDir, ".claude"), { recursive: true });
    seedConversation(path.join(sessionDir, ".claude"), CONVERSATION_ID);

    const { sm } = makeFakeSessionManager({
      agentPinned: true,
      agentSessionId: CONVERSATION_ID,
    });

    await prepare(sm, { accountId: "acct_second" });

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
    // The resident process was spawned from an earlier claude-default turn,
    // whose provisioning wrote the marker — so this turn's identity check
    // reads "match" and leaves the subtree alone (docs/260 §4).
    writeSessionAccountMarker(tmpDir, "s1", "claude", "claude-default");

    const { sm, state } = makeFakeSessionManager({
      agentPinned: true,
      agentSessionId: CONVERSATION_ID,
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
    // The live process's earlier provisioning recorded the account, so the
    // per-turn identity check matches and never reprovisions under it.
    writeSessionAccountMarker(tmpDir, "s1", "claude", "claude-default");

    const { sm } = makeFakeSessionManager({
      agentPinned: true,
      agentSessionId: CONVERSATION_ID,
    });

    await prepare(sm, { reusingResidentAgent: true });

    // The live CLI's credentials are still readable through the path it opened.
    expect(fs.existsSync(path.join(leakedTarget, ".credentials.json"))).toBe(true);
    expect(fs.lstatSync(path.join(sessionDir, ".claude")).isSymbolicLink()).toBe(true);
  });
});

// Silence vi import lint when no `vi` calls remain after refactors.
void vi;

/**
 * docs/118 (planning#61) — local-mode workspace trust.
 *
 * The Claude CLI silently drops a workspace's own `.claude/settings.json`
 * `permissions.allow` entries until that exact directory is trusted. A
 * container is covered because its cwd IS `/workspace`, one of
 * `CLAUDE_PRE_TRUSTED_DIRS`; a local session's workspace is
 * `<dataDir>/sessions/<id>/workspace` and trust is keyed by exact directory,
 * so the pre-trust never reaches it.
 *
 * The regression that would matter is the containerized one — trust there is
 * real security posture, since a container session can hold an arbitrary user
 * repository. So both directions are pinned: local mode writes the key, and
 * containerized mode is byte-for-byte what it was.
 */
describe("local-mode workspace trust (docs/118, planning#61)", () => {
  let tmpDir: string;
  let home: string;
  let runtimeModeBefore: string | undefined;
  let agentHomeBefore: string | undefined;

  /** A plain (non-container) runner — what local mode actually builds. */
  function makeLocalRunner(sessionDir: string): SessionRunnerInterface {
    const runner = new EventEmitter() as unknown as { sessionId: string; sessionDir: string };
    runner.sessionId = "s1";
    runner.sessionDir = sessionDir;
    return runner as unknown as SessionRunnerInterface;
  }

  /** A git-inited local session workspace, as `GitManager.init` leaves it. */
  function makeWorkspace(id: string): string {
    const ws = path.join(tmpDir, "sessions", id, "workspace");
    fs.mkdirSync(path.join(ws, ".git"), { recursive: true });
    return ws;
  }

  /**
   * A turn-shaped preparation (the local-mode trust write, like every routing
   * side effect, runs only on turns — docs/260). `selection` is what this
   * call's own walk resolves; omitted, nothing is signed in and the legacy
   * flat path runs.
   */
  function prepare(
    runner: SessionRunnerInterface,
    sm: SessionManager,
    selection?: { kind: "account" | "reserved"; id: string },
  ): Promise<unknown> {
    return prepareSessionAgentEnvironment(runner, {
      sessionId: "s1",
      agentId: "claude",
      enforceAccountRouting: true,
      deps: {
        credentialsDir: tmpDir,
        credentialStore: makeFakeCredentialStore(),
        sessionManager: sm,
        ...(selection
          ? { providerAccountManager: fakeAccountManager({ ok: true, route: selection }) as never }
          : {}),
      },
    });
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-local-trust-"));
    home = path.join(tmpDir, "agent-home");
    fs.mkdirSync(home, { recursive: true });
    runtimeModeBefore = process.env.RUNTIME_MODE;
    agentHomeBefore = process.env.AGENT_HOME;
    // AGENT_HOME is redirected for every case, including the containerized
    // ones: a leak would otherwise write into the developer's real home.
    process.env.AGENT_HOME = home;
  });

  afterEach(async () => {
    if (runtimeModeBefore === undefined) delete process.env.RUNTIME_MODE;
    else process.env.RUNTIME_MODE = runtimeModeBefore;
    if (agentHomeBefore === undefined) delete process.env.AGENT_HOME;
    else process.env.AGENT_HOME = agentHomeBefore;
    // Turn-shaped calls arm the write-back watch (container cases) and start
    // the local `/agent-ops` loopback host (local cases); drop both.
    stopAllTokenWriteBackWatches();
    await resetLocalAgentOpsForTests();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("trusts the session's workspace in the account root the CLI will spawn against", async () => {
    process.env.RUNTIME_MODE = "local";
    const accountRoot = path.join(tmpDir, "provider-accounts", "claude", "acct-a");
    fs.mkdirSync(path.join(accountRoot, ".claude"), { recursive: true });
    const ws = makeWorkspace("s1");
    const { sm } = makeFakeSessionManager({ agentPinned: true });

    await prepare(makeLocalRunner(ws), sm, { kind: "account", id: "acct-a" });

    const config = JSON.parse(
      fs.readFileSync(path.join(accountRoot, ".claude.json"), "utf-8"),
    ) as { projects: Record<string, { hasTrustDialogAccepted?: boolean }> };
    expect(config.projects[ws]?.hasTrustDialogAccepted).toBe(true);
  });

  it("falls back to the process-global agent home for a reserved route", async () => {
    process.env.RUNTIME_MODE = "local";
    const ws = makeWorkspace("s1");
    const { sm } = makeFakeSessionManager({ agentPinned: true });

    await prepare(makeLocalRunner(ws), sm, { kind: "reserved", id: "claude-api-key" });

    const config = JSON.parse(
      fs.readFileSync(path.join(home, ".claude.json"), "utf-8"),
    ) as { projects: Record<string, { hasTrustDialogAccepted?: boolean }> };
    expect(config.projects[ws]?.hasTrustDialogAccepted).toBe(true);
  });

  it("prunes a dead sibling workspace, so the shared config stays bounded", async () => {
    process.env.RUNTIME_MODE = "local";
    const accountRoot = path.join(tmpDir, "provider-accounts", "claude", "acct-a");
    fs.mkdirSync(path.join(accountRoot, ".claude"), { recursive: true });
    const dead = path.join(tmpDir, "sessions", "gone", "workspace");
    fs.writeFileSync(
      path.join(accountRoot, ".claude.json"),
      JSON.stringify({ projects: { [dead]: { hasTrustDialogAccepted: true } } }),
    );
    const ws = makeWorkspace("s1");
    const { sm } = makeFakeSessionManager({ agentPinned: true });

    await prepare(makeLocalRunner(ws), sm, { kind: "account", id: "acct-a" });

    const config = JSON.parse(
      fs.readFileSync(path.join(accountRoot, ".claude.json"), "utf-8"),
    ) as { projects: Record<string, unknown> };
    expect(Object.keys(config.projects)).toEqual([ws]);
  });

  // ── The regression that matters ────────────────────────────────────────────

  it("CONTAINERIZED: writes no workspace trust key — the posture is unchanged", async () => {
    delete process.env.RUNTIME_MODE;
    fs.mkdirSync(path.join(tmpDir, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, ".claude.json"), "{}");
    const { sm } = makeFakeSessionManager({ agentPinned: false });
    const runner = new FakeContainerRunner() as unknown as SessionRunnerInterface;
    // A container runner's sessionDir is the HOST path; the agent's cwd inside
    // the container is `/workspace`. Nothing may key trust off the host path.
    (runner as unknown as { sessionDir: string }).sessionDir = path.join(tmpDir, "sessions", "s1");

    await prepare(runner, sm);

    const sessionConfig = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "sessions", "s1", ".claude.json"), "utf-8"),
    ) as { hasCompletedOnboarding: boolean; projects: Record<string, unknown> };
    // Exactly CLAUDE_PRE_TRUSTED_DIRS, and nothing else.
    expect(sessionConfig.hasCompletedOnboarding).toBe(true);
    expect(sessionConfig.projects).toEqual({
      "/app": { hasTrustDialogAccepted: true },
      "/workspace": { hasTrustDialogAccepted: true },
    });
    // And the local-mode writer never ran against the fallback home either.
    expect(fs.existsSync(path.join(home, ".claude.json"))).toBe(false);
  });

  it("CONTAINERIZED: an already-pinned session's re-assert is still pre-trusted dirs only", async () => {
    delete process.env.RUNTIME_MODE;
    const sessionDir = path.join(tmpDir, "sessions", "s1");
    fs.mkdirSync(path.join(sessionDir, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(sessionDir, ".claude.json"), "{}");
    const { sm } = makeFakeSessionManager({ agentPinned: true });
    const runner = new FakeContainerRunner() as unknown as SessionRunnerInterface;
    (runner as unknown as { sessionDir: string }).sessionDir = sessionDir;

    await prepare(runner, sm);

    const sessionConfig = JSON.parse(
      fs.readFileSync(path.join(sessionDir, ".claude.json"), "utf-8"),
    ) as { projects: Record<string, unknown> };
    expect(sessionConfig.projects).toEqual({
      "/app": { hasTrustDialogAccepted: true },
      "/workspace": { hasTrustDialogAccepted: true },
    });
  });
});
