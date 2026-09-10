import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import type { SessionRunnerInterface } from "./session-runner.js";
import type { CredentialStore } from "./credential-store.js";
import type { SessionManager } from "./sessions.js";
import type { CredentialRoute } from "../shared/types.js";
import type { ModelSelection } from "../shared/catalogue/index.js";
import { credentialStorageEnvNames } from "../shared/catalogue/index.js";
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

class FakeContainerRunner extends EventEmitter {
  serviceManager: { getSecretsSnapshot: () => { agentValues: Record<string, string> } } | null = null;
  pushed: Record<string, string>[] = [];
  residentRoute?: { kind: "account" | "reserved"; id: string };
  emitted: { type: string; [k: string]: unknown }[] = [];
  residentAgent: object | null = null;
  getAgent(): object | null { return this.residentAgent; }
  async tryPushAgentSecrets(values: Record<string, string>): Promise<void> {
    this.pushed.push(values);
  }
  emitMessage(msg: { type: string; [k: string]: unknown }): void {
    this.emitted.push(msg);
  }
}
// Enter container-only branches without constructing a real runner.
Object.setPrototypeOf(FakeContainerRunner.prototype, ContainerSessionRunner.prototype);

function makeFakeCredentialStore(
  initial: {
    agentEnv?: Record<string, string>;
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
    getCredentialRoute: (routeId: string) => {
      const found = routes.find((r) => r.id === routeId);
      return found ? { ...found } : undefined;
    },
    markCredentialRouteUsed: (routeId: string) => {
      const found = routes.find((r) => r.id === routeId);
      if (found) found.lastUsedAt = Date.now();
    },
    getSelectionMode: () => "strict" as const,
    getFailoverCutoffs: () => ({ session: 90, weekly: 90 }),
  };
  return stub as unknown as CredentialStore;
}

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
    modelSelection: ModelSelection | undefined;
    setModelSelectionCalls: ModelSelection[];
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
    modelSelection: undefined as ModelSelection | undefined,
    setModelSelectionCalls: [] as ModelSelection[],
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
      ...(state.modelSelection
        ? {
            serviceId: state.modelSelection.serviceId,
            billingMode: state.modelSelection.billingMode,
            model: state.modelSelection.modelId,
          }
        : {}),
    }),
    setModelSelection: (_id: string, selection: ModelSelection) => {
      state.setModelSelectionCalls.push(selection);
      state.modelSelection = selection;
    },
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
    stopAllTokenWriteBackWatches();
  });

  it("provisions legacy flat credentials + scaffolds once on the first routed turn, skips both on the second (docs/260 — agentPinned gates only the legacy branch)", async () => {
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

  it("returns overrideAgentSessionId when the docs/153 repair recovers an id from an orphan jsonl", async () => {
    const account = path.join(tmpDir, "provider-accounts", "claude", "claude-default");
    fs.mkdirSync(path.join(account, ".claude"), { recursive: true });
    fs.writeFileSync(
      path.join(account, ".claude", ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { expiresAt: Date.now() + 60_000, accessToken: "FRESH" } }),
    );
    const sessionDir = path.join(tmpDir, "sessions", "s1");
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.symlinkSync(path.join(account, ".claude"), path.join(sessionDir, ".claude"));
    const recoveredId = "b5903553-cab6-49a9-a9c0-855a7708867d";
    const orphanProjects = path.join(
      sessionDir, "provider-accounts", "claude", "claude-default",
      ".claude", "projects", "-workspace",
    );
    fs.mkdirSync(orphanProjects, { recursive: true });
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
    expect(state.setAgentSessionIdCalls).toContainEqual({ id: "s1", value: recoveredId });
    expect(state.agentSessionId).toBe(recoveredId);
  });

  it("selects the turn's route fresh, returns it as turnRoute, and never persists a session route (docs/260-turn-level-account-routing reqs 1–2)", async () => {
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

    expect(manager.selectAccountForTurn).toHaveBeenCalledWith("anthropic", { optimistic: true });
    expect(result.turnRoute).toEqual({ kind: "account", id: "acct-primary" });
    expect(runner.residentRoute).toEqual({ kind: "account", id: "acct-primary" });
    expect(manager.markAccountUsed).toHaveBeenCalledWith("anthropic", "acct-primary");
    expect(state.setProviderRouteCalls).toEqual([]);
    expect(
      fs.existsSync(path.join(tmpDir, "sessions", "s1", ".claude", ".credentials.json")),
    ).toBe(true);
    expect(readSessionAccountMarker(tmpDir, "s1").claude).toBe("acct-primary");
  });

  it("re-runs selection on every turn — legacy provider_route_* row values are never consulted (docs/260-turn-level-account-routing req 1)", async () => {
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

    expect(state.setAgentPinnedCalls).toBe(0);
    expect(state.setProviderRouteCalls).toEqual([]);
    expect(fs.existsSync(path.join(tmpDir, "sessions", "s1"))).toBe(false);
  });

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

    expect(manager.selectAccountForTurn).toHaveBeenCalledWith("anthropic", { optimistic: true });
  });

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

  describe("a selection-less session is settled onto the install's first eligible model", () => {
    const deepseekRoute: CredentialRoute = {
      id: "cred_ds", serviceId: "deepseek", billingMode: "key", via: "string", label: "DeepSeek",
      isPrimary: true, priority: 0, status: "ready", createdAt: 0, updatedAt: 0,
    };
    const deepseekSelection = {
      serviceId: "deepseek",
      billingMode: "key",
      modelId: "deepseek-flash",
    };

    beforeEach(() => {
      // Host credentials must not change the derived default.
      for (const name of credentialStorageEnvNames()) vi.stubEnv(name, "");
    });
    afterEach(() => { vi.unstubAllEnvs(); });

    async function prep(opts: {
      routes?: CredentialRoute[];
      secrets?: Record<string, string>;
      extra?: Record<string, unknown>;
      model?: string;
      turn?: boolean;
      agent?: "claude" | "codex" | "opencode";
    }) {
      const runner = new FakeContainerRunner();
      const credentialStore = makeFakeCredentialStore({
        ...(opts.routes ? { credentialRoutes: opts.routes } : {}),
        ...(opts.secrets ? { credentialSecrets: opts.secrets } : {}),
      });
      const { sm, state } = makeFakeSessionManager({
        agentPinned: true,
        ...(opts.model ? { model: opts.model } : {}),
        ...(opts.extra ? { extra: opts.extra } : {}),
      });
      const result = await prepareSessionAgentEnvironment(runner as unknown as SessionRunnerInterface, {
        sessionId: "s1",
        agentId: opts.agent ?? "claude",
        ...(opts.turn === false ? {} : { enforceAccountRouting: true }),
        deps: { credentialsDir: tmpDir, credentialStore, sessionManager: sm },
      });
      return { result, state };
    }

    it("writes the derived selection to the row and routes the turn onto it", async () => {
      const { result, state } = await prep({
        routes: [deepseekRoute],
        secrets: { cred_ds: "sk-ds" },
      });
      expect(state.setModelSelectionCalls).toEqual([deepseekSelection]);
      expect(result.turnRoute).toEqual({ kind: "reserved", id: "cred_ds" });
    });

    it("tells the viewers, so the composer stops showing a model the turn is not using", async () => {
      const runner = new FakeContainerRunner();
      const credentialStore = makeFakeCredentialStore({
        credentialRoutes: [deepseekRoute],
        credentialSecrets: { cred_ds: "sk-ds" },
      });
      const { sm } = makeFakeSessionManager({ agentPinned: true });
      await prepareSessionAgentEnvironment(runner as unknown as SessionRunnerInterface, {
        sessionId: "s1",
        agentId: "claude",
        enforceAccountRouting: true,
        deps: { credentialsDir: tmpDir, credentialStore, sessionManager: sm },
      });
      const sent = runner.emitted.find((m) => m.type === "model_selection_changed");
      expect(sent).toMatchObject({ sessionId: "s1", agentId: "claude", selection: deepseekSelection });
    });

    it("leaves a row that already names a real catalogue mode completely alone", async () => {
      const { state } = await prep({
        routes: [
          deepseekRoute,
          {
            id: "cred_glm", serviceId: "zai", billingMode: "sub", via: "string", label: "GLM",
            isPrimary: true, priority: 0, status: "ready", createdAt: 0, updatedAt: 0,
          },
        ],
        secrets: { cred_ds: "sk-ds", cred_glm: "glm" },
        model: "glm-5.2[1m]",
        extra: { serviceId: "zai", billingMode: "sub" },
      });
      expect(state.setModelSelectionCalls).toEqual([]);
    });

    it("settles a row whose model id the catalogue no longer knows", async () => {
      const { state } = await prep({
        routes: [deepseekRoute],
        secrets: { cred_ds: "sk-ds" },
        model: "claude-sonnet-4-20250514",
      });
      expect(state.setModelSelectionCalls).toEqual([deepseekSelection]);
    });

    it("writes nothing when the first eligible model is the harness's own vendor", async () => {
      for (const [name, value] of [
        ["ANTHROPIC_AUTH_TOKEN", "tok"],
        ["ANTHROPIC_API_KEY", "sk-ant"],
      ] as const) {
        vi.stubEnv(name, value);
        const { state } = await prep({});
        expect(state.setModelSelectionCalls, `${name} must stay unshaped`).toEqual([]);
        vi.stubEnv(name, "");
      }
    });

    it("writes nothing when the native vendor has an account, even with another service configured", async () => {
      const { state } = await prep({
        routes: [
          {
            id: "acct_1", serviceId: "anthropic", billingMode: "sub", via: "account", label: "Acct",
            isPrimary: true, priority: 0, status: "ready", createdAt: 0, updatedAt: 0,
          },
          deepseekRoute,
        ],
        secrets: { cred_ds: "sk-ds" },
      });
      expect(state.setModelSelectionCalls).toEqual([]);
    });

    it("still writes when the derived service IS the native one but has no login (docs/272)", async () => {
      const { state } = await prep({
        agent: "opencode",
        routes: [{
          id: "cred_oc",
          serviceId: "opencode",
          billingMode: "key",
          via: "string",
          label: "OpenCode",
          isPrimary: true,
          priority: 0,
          status: "ready",
          createdAt: 0,
          updatedAt: 0,
        }],
        secrets: { cred_oc: "sk-oc" },
      });
      expect(state.setModelSelectionCalls).toEqual([
        { serviceId: "opencode", billingMode: "key", modelId: "claude-opus-5" },
      ]);
    });

    it("writes nothing on a warm-up", async () => {
      const { state } = await prep({
        routes: [deepseekRoute],
        secrets: { cred_ds: "sk-ds" },
        turn: false,
      });
      expect(state.setModelSelectionCalls).toEqual([]);
    });

    it("writes nothing, and does not throw, when the install has no credentials", async () => {
      const { result, state } = await prep({});
      expect(state.setModelSelectionCalls).toEqual([]);
      expect(result.turnRoute).toBeUndefined();
    });
  });

  describe("string-delivered subscription credentials are routed per turn (docs/260-turn-level-account-routing req 11)", () => {
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
      expect(routes.find((r) => r.id === "cred_b")?.lastUsedAt).toBeDefined();
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
      const routes = glmRoutes({ exhaustedUntil: Date.now() + 3_600_000 });

      const { result } = await prepGlm(routes);

      expect(result.turnRoute).toEqual({ kind: "reserved", id: "cred_a" });
    });

    it("still returns the best blocked credential when every one is refusal-blocked (req 12)", async () => {
      const now = Date.now();
      const routes = glmRoutes({ exhaustedUntil: now + 3_600_000, exhaustedAt: now });
      routes[1]!.exhaustedUntil = now + 3_600_000;
      routes[1]!.exhaustedAt = now;

      const { result } = await prepGlm(routes);

      expect(result.turnRoute).toEqual({ kind: "reserved", id: "cred_a" });
    });

    it("blocks the turn only when every credential was actually refused THIS turn (reqs 6, 12)", async () => {
      const now = Date.now();
      const routes = glmRoutes({ exhaustedUntil: now + 3_600_000, exhaustedAt: now });
      routes[1]!.exhaustedUntil = now + 3_600_000;
      routes[1]!.exhaustedAt = now;

      await expect(
        prepGlm(routes, { excludeRouteIds: ["cred_a", "cred_b"] }),
      ).rejects.toThrow(/Every GLM \(Z\.ai\) credential is out of quota/);
    });

    it("selects and stamps nothing on a pre-turn warm-up (docs/260 §5b)", async () => {
      const routes = glmRoutes();

      const { result } = await prepGlm(routes, { turn: false });

      expect(result.turnRoute).toBeUndefined();
      expect(routes.every((r) => r.lastUsedAt === undefined)).toBe(true);
    });
  });

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
    expect(runner.pushed).toHaveLength(1);
  });

  it("returns no override on healthy turns (no leak repair fired)", async () => {
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

  it("returns overrideAgentSessionId=null and clears the DB when the leak repair finds no resumable jsonl", async () => {
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
    expect(fs.existsSync(path.join(sessionDir, ".codex", codexRolloutRel))).toBe(true);
  });

  it("clears an unresumable Codex thread and arms a visible-history replay", async () => {
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

  it("fails open (resolves) when the worker secrets push hangs forever", async () => {
    fs.mkdirSync(path.join(tmpDir, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, ".claude.json"), "{}");
    fs.writeFileSync(
      path.join(tmpDir, ".claude", ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { expiresAt: Date.now() + 60_000 } }),
    );

    const runner = new FakeContainerRunner();
    runner.tryPushAgentSecrets = () => new Promise<void>(() => { /* never resolves */ });
    const credentialStore = makeFakeCredentialStore();
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

      await vi.advanceTimersByTimeAsync(PUSH_AGENT_SECRETS_TIMEOUT_MS - 1_000);
      expect(settled).toBe(false);

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

  const repoUrl = "https://github.com/example/memrepo.git";
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
    writeSessionAccountMarker(tmpDir, "s1", "claude", "acct-a");

    const runner = new FakeContainerRunner();
    const credentialStore = makeFakeCredentialStore();
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
    expect(() =>
      finalizeSessionAgentEnvironment(runner as unknown as SessionRunnerInterface, {
        sessionId: "s1",
        agentId: "claude",
        deps: { credentialsDir: tmpDir, credentialStore, sessionManager: sm },
      }),
    ).not.toThrow();
  });

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

  it("arms on the turn's own pre-spawn step and disarms at turn end when no CLI survives it", async () => {
    const { runner, sm } = await prep({ enforceAccountRouting: true });
    expect(hasTokenWriteBackWatch("s1")).toBe(true);

    finalizeSessionAgentEnvironment(runner as unknown as SessionRunnerInterface, {
      sessionId: "s1",
      agentId: "claude",
      deps: { credentialsDir: tmpDir, credentialStore: makeFakeCredentialStore(), sessionManager: sm },
    });
    expect(hasTokenWriteBackWatch("s1")).toBe(false);
  });

  it("keeps the watch alive past turn end while a CLI process is still resident", async () => {
    const { runner, sm } = await prep({ enforceAccountRouting: true });
    runner.residentAgent = { pid: 80 };

    finalizeSessionAgentEnvironment(runner as unknown as SessionRunnerInterface, {
      sessionId: "s1",
      agentId: "claude",
      deps: { credentialsDir: tmpDir, credentialStore: makeFakeCredentialStore(), sessionManager: sm },
    });
    expect(hasTokenWriteBackWatch("s1")).toBe(true);

    runner.emit("disposed");
    expect(hasTokenWriteBackWatch("s1")).toBe(false);
  });

  it("drops the surviving watch at the next turn end once the process is gone", async () => {
    const { runner, sm } = await prep({ enforceAccountRouting: true });
    runner.residentAgent = { pid: 80 };
    const finalize = (): void => {
      finalizeSessionAgentEnvironment(runner as unknown as SessionRunnerInterface, {
        sessionId: "s1",
        agentId: "claude",
        deps: { credentialsDir: tmpDir, credentialStore: makeFakeCredentialStore(), sessionManager: sm },
      });
    };
    finalize();
    expect(hasTokenWriteBackWatch("s1")).toBe(true);

    runner.residentAgent = null;
    finalize();
    expect(hasTokenWriteBackWatch("s1")).toBe(false);
  });

  it("does not arm on a pre-turn warm-up call (no turn to publish for yet)", async () => {
    await prep({});
    expect(hasTokenWriteBackWatch("s1")).toBe(false);
  });

  it("skips the reserved claude-env-oauth route, like the sync-in does", async () => {
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
        getSecretsSnapshot: () => ({
          agentValues: { STRIPE_KEY: "s" },
          declared: [],
          missingByService: {},
          missingRequired: [],
          agentNames: [],
          plugins: [],
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
          plugins: [],
        }),
      },
      credentialStore: makeFakeCredentialStore({
        credentialRoutes: [stored],
        credentialSecrets: { cred_ds: "sk-ds" },
      }),
    });
    expect(out.SHIPIT_CREDENTIAL_CRED_DS).toBe("sk-ds");
    expect(out.DEEPSEEK_API_KEY).toBeUndefined();
  });

  it("overwrites a ROTATED per-credential value the snapshot still carries", () => {
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
          plugins: [],
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

describe("credential topology under a resident agent (nikzlabs/shipit#1874)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-env-topology-"));
  });

  afterEach(() => {
    stopAllTokenWriteBackWatches();
  });

  const CONVERSATION_ID = "c0ffee00-dead-beef-cafe-000000000001";

  function seedAccount(accountId: string, accessToken: string): string {
    const root = path.join(tmpDir, "provider-accounts", "claude", accountId);
    fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
    fs.writeFileSync(
      path.join(root, ".claude", ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { expiresAt: Date.now() + 3_600_000, accessToken } }),
    );
    return root;
  }

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

    expect(fs.lstatSync(path.join(sessionDir, ".claude")).isSymbolicLink()).toBe(false);
    expect(fs.existsSync(path.join(sessionDir, "provider-accounts"))).toBe(false);
    expect(fs.existsSync(
      path.join(sessionDir, ".claude", "projects", "-workspace", `${CONVERSATION_ID}.jsonl`),
    )).toBe(true);
    expect(first.overrideAgentSessionId).toBe(CONVERSATION_ID);

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
    writeSessionAccountMarker(tmpDir, "s1", "claude", "claude-default");

    const { sm, state } = makeFakeSessionManager({
      agentPinned: true,
      agentSessionId: CONVERSATION_ID,
    });

    const result = await prepare(sm, { reusingResidentAgent: true });

    expect(fs.existsSync(orphanClaude)).toBe(true);
    expect(result.overrideAgentSessionId).toBeUndefined();
    expect(state.setAgentSessionIdCalls).toHaveLength(0);
    const synced = JSON.parse(
      fs.readFileSync(path.join(sessionDir, ".claude", ".credentials.json"), "utf8"),
    ) as { claudeAiOauth: { accessToken: string } };
    expect(synced.claudeAiOauth.accessToken).toBe("ROTATED");

    await prepare(sm);
    expect(fs.existsSync(path.join(sessionDir, "provider-accounts"))).toBe(false);
  });

  it("never leaves a resident agent without credentials when the source subtree is missing", async () => {
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
    writeSessionAccountMarker(tmpDir, "s1", "claude", "claude-default");

    const { sm } = makeFakeSessionManager({
      agentPinned: true,
      agentSessionId: CONVERSATION_ID,
    });

    await prepare(sm, { reusingResidentAgent: true });

    expect(fs.existsSync(path.join(leakedTarget, ".credentials.json"))).toBe(true);
    expect(fs.lstatSync(path.join(sessionDir, ".claude")).isSymbolicLink()).toBe(true);
  });
});

void vi;

describe("local-mode workspace trust (docs/118, planning#61)", () => {
  let tmpDir: string;
  let home: string;
  let runtimeModeBefore: string | undefined;
  let agentHomeBefore: string | undefined;

  function makeLocalRunner(sessionDir: string): SessionRunnerInterface {
    const runner = new EventEmitter() as unknown as { sessionId: string; sessionDir: string };
    runner.sessionId = "s1";
    runner.sessionDir = sessionDir;
    return runner as unknown as SessionRunnerInterface;
  }

  function makeWorkspace(id: string): string {
    const ws = path.join(tmpDir, "sessions", id, "workspace");
    fs.mkdirSync(path.join(ws, ".git"), { recursive: true });
    return ws;
  }

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
    // Redirect even container cases to protect the real agent home.
    process.env.AGENT_HOME = home;
  });

  afterEach(async () => {
    if (runtimeModeBefore === undefined) delete process.env.RUNTIME_MODE;
    else process.env.RUNTIME_MODE = runtimeModeBefore;
    if (agentHomeBefore === undefined) delete process.env.AGENT_HOME;
    else process.env.AGENT_HOME = agentHomeBefore;
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

  it("CONTAINERIZED: writes no workspace trust key — the posture is unchanged", async () => {
    delete process.env.RUNTIME_MODE;
    fs.mkdirSync(path.join(tmpDir, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, ".claude.json"), "{}");
    const { sm } = makeFakeSessionManager({ agentPinned: false });
    const runner = new FakeContainerRunner() as unknown as SessionRunnerInterface;
    (runner as unknown as { sessionDir: string }).sessionDir = path.join(tmpDir, "sessions", "s1");

    await prepare(runner, sm);

    const sessionConfig = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "sessions", "s1", ".claude.json"), "utf-8"),
    ) as { hasCompletedOnboarding: boolean; projects: Record<string, unknown> };
    expect(sessionConfig.hasCompletedOnboarding).toBe(true);
    expect(sessionConfig.projects).toEqual({
      "/app": { hasTrustDialogAccepted: true },
      "/workspace": { hasTrustDialogAccepted: true },
    });
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
