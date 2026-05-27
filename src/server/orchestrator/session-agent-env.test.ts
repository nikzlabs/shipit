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

import { describe, it, expect, beforeEach, vi } from "vitest";
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
  selectAgentEnvForPush,
} from "./session-agent-env.js";

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
  providerRouteKind?: "account";
  providerRouteId?: string;
}): {
  sm: SessionManager;
  state: {
    agentPinned: boolean;
    setAgentIdCalls: number;
    setAgentPinnedCalls: number;
    agentSessionId: string | undefined;
    setAgentSessionIdCalls: { id: string; value: string }[];
  };
} {
  const state = {
    agentPinned: opts.agentPinned,
    setAgentIdCalls: 0,
    setAgentPinnedCalls: 0,
    agentSessionId: opts.agentSessionId,
    setAgentSessionIdCalls: [] as { id: string; value: string }[],
  };
  const sm = {
    get: () => ({
      agentPinned: state.agentPinned,
      id: "s1",
      agentSessionId: state.agentSessionId,
      providerRouteKind: opts.providerRouteKind,
      providerRouteId: opts.providerRouteId,
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
    setProviderRoute: () => { /* no-op */ },
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
    fs.writeFileSync(
      path.join(orphanProjects, `${recoveredId}.jsonl`),
      `${JSON.stringify({ sessionId: recoveredId, type: "summary" })}\n`,
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

    const runner = new FakeContainerRunner();
    const credentialStore = makeFakeCredentialStore();
    const { sm, state } = makeFakeSessionManager({
      agentPinned: true,
      agentSessionId: "healthy-existing-id",
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
    expect(state.agentSessionId).toBe("healthy-existing-id");
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

// Silence vi import lint when no `vi` calls remain after refactors.
void vi;
