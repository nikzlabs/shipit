import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";

import { ClaudeOAuthRefresher, summarizeRefreshFailure } from "./oauth-refresher.js";
import type { ClaudeOAuthRefresherDeps, RefreshResult } from "./oauth-refresher.js";
import type { ProviderAccountManager } from "../../provider-account-manager.js";
import { writeSessionAccountMarker } from "../../session-credentials-scaffold.js";
import type { CredentialRoute, AgentId } from "../../../shared/types.js";

function makeAccount(id: string, overrides: Partial<CredentialRoute> = {}): CredentialRoute {
  return {
    id,
    serviceId: "anthropic",
    billingMode: "sub",
    via: "account",
    label: id,
    isPrimary: true,
    status: "ready",
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function makeProviderAccountManager(opts: {
  rootDir: string;
  accounts: CredentialRoute[];
}): ProviderAccountManager {
  return {
    list: (serviceId?: string): CredentialRoute[] => {
      if (serviceId && serviceId !== "anthropic") return [];
      return opts.accounts;
    },
    resolveCredentialRoot: (provider: AgentId, accountId: string): string => {
      return path.join(opts.rootDir, "provider-accounts", provider, accountId);
    },
  } as unknown as ProviderAccountManager;
}

function writeCredentials(accountRoot: string, payload: { expiresAt: number }): void {
  const dir = path.join(accountRoot, ".claude");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, ".credentials.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      claudeAiOauth: {
        accessToken: `tok_${Math.random().toString(36).slice(2)}`,
        refreshToken: `rfk_${Math.random().toString(36).slice(2)}`,
        expiresAt: payload.expiresAt,
      },
    }),
    "utf8",
  );
}

// Assemble the fake token to avoid triggering the secret scanner.
const FAKE_OAUTH_TOKEN = ["sk", "ant", "oat01", "F".repeat(40)].join("-");

function accountTokenFile(rootDir: string, accountId: string): string {
  return path.join(rootDir, "provider-accounts", "claude", accountId, ".claude", ".credentials.json");
}

function writeBlankedCredentials(accountRoot: string): void {
  const dir = path.join(accountRoot, ".claude");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, ".credentials.json"),
    JSON.stringify({
      claudeAiOauth: {
        accessToken: "",
        refreshToken: "",
        expiresAt: 0,
        scopes: ["user:inference"],
        subscriptionType: "max",
      },
    }),
    "utf8",
  );
}

function writeSessionToken(
  rootDir: string,
  sessionId: string,
  opts: { expiresAt: number; accountId: string | null },
): void {
  const dir = path.join(rootDir, "sessions", sessionId);
  fs.mkdirSync(path.join(dir, ".claude"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, ".claude", ".credentials.json"),
    JSON.stringify({
      claudeAiOauth: {
        accessToken: `sess_tok_${opts.expiresAt}`,
        refreshToken: `sess_rfk_${opts.expiresAt}`,
        expiresAt: opts.expiresAt,
      },
    }),
    "utf8",
  );
  if (opts.accountId !== null) writeSessionAccountMarker(rootDir, sessionId, "claude", opts.accountId);
}

function captureLogs(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.map((arg) => (typeof arg === "string" ? arg : String(arg))).join(" "));
  });
  return { lines, restore: () => spy.mockRestore() };
}

interface SpawnEffect {
  rotateTo?: number;
  debugLog?: string;
  stderr?: string;
  stdout?: string;
  exitCode?: number;
  delayMs?: number;
}

interface FakeSpawnHandle {
  invocations: { args: string[]; accountRoot: string }[];
  effects: SpawnEffect[];
  spawn: (cmd: string, args?: readonly string[], opts?: { env?: Record<string, string> }) => ChildProcess;
}

function makeFakeSpawn(getAccountRoot: (env: Record<string, string>) => string): FakeSpawnHandle {
  const handle: FakeSpawnHandle = {
    invocations: [],
    effects: [],
    spawn: (() => undefined as unknown) as FakeSpawnHandle["spawn"],
  };

  handle.spawn = ((cmd, args, opts) => {
    const argArr = Array.from(args ?? []);
    const accountRoot = opts?.env ? getAccountRoot(opts.env) : "";
    handle.invocations.push({ args: argArr, accountRoot });
    const idx = handle.invocations.length - 1;
    const effect = handle.effects[idx] ?? { exitCode: 0 };

    const child = new EventEmitter() as ChildProcess;
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    (child as unknown as { stdout: EventEmitter }).stdout = stdout;
    (child as unknown as { stderr: EventEmitter }).stderr = stderr;
    (child as unknown as { kill: (sig?: string) => boolean }).kill = () => true;

    const fire = (): void => {
      if (effect.stdout) stdout.emit("data", Buffer.from(effect.stdout, "utf8"));
      if (effect.stderr) stderr.emit("data", Buffer.from(effect.stderr, "utf8"));
      if (effect.debugLog) {
        const dfIdx = argArr.indexOf("--debug-file");
        if (dfIdx >= 0 && dfIdx + 1 < argArr.length) {
          const dfPath = argArr[dfIdx + 1];
          if (dfPath) {
            try {
              fs.writeFileSync(dfPath, effect.debugLog, "utf8");
            } catch { /* */ }
          }
        }
      }
      if (effect.rotateTo !== undefined && accountRoot) {
        writeCredentials(accountRoot, { expiresAt: effect.rotateTo });
      }
      child.emit("exit", effect.exitCode ?? 0, null);
    };
    if (effect.delayMs && effect.delayMs > 0) {
      setTimeout(fire, effect.delayMs);
    } else {
      // Let concurrent callers see the pending promise.
      setTimeout(fire, 0);
    }
    return child;
  }) as FakeSpawnHandle["spawn"];

  return handle;
}

interface TestRig {
  rootDir: string;
  refresher: ClaudeOAuthRefresher;
  spawnHandle: FakeSpawnHandle;
  repushCalls: { agentId: AgentId; accountId: string }[];
  sseCalls: { event: string; data: unknown }[];
  now: () => number;
  setNow: (n: number) => void;
}

function buildRig(opts: {
  accounts: CredentialRoute[];
  initialExpiries?: Record<string, number>;
  initialNow?: number;
  safetyMarginMs?: number;
}): TestRig {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-refresh-test-"));
  const accounts = opts.accounts;
  const pam = makeProviderAccountManager({ rootDir, accounts });

  for (const acc of accounts) {
    const accountRoot = pam.resolveCredentialRoot("claude", acc.id);
    fs.mkdirSync(accountRoot, { recursive: true });
    const initial = opts.initialExpiries?.[acc.id];
    if (initial !== undefined) writeCredentials(accountRoot, { expiresAt: initial });
  }

  const repushCalls: { agentId: AgentId; accountId: string }[] = [];
  const sseCalls: { event: string; data: unknown }[] = [];

  const spawnHandle = makeFakeSpawn((env) => env.HOME ?? "");

  let nowValue = opts.initialNow ?? 1_700_000_000_000;
  const now = () => nowValue;
  const setNow = (n: number) => {
    nowValue = n;
  };

  const deps: ClaudeOAuthRefresherDeps = {
    credentialsDir: rootDir,
    providerAccountManager: pam,
    repushAccountToken: (agentId, accountId) => {
      repushCalls.push({ agentId, accountId });
    },
    sseBroadcast: (event, data) => {
      sseCalls.push({ event, data });
    },
    runtimeMode: "containerized",
    now,
    spawn: spawnHandle.spawn as unknown as ClaudeOAuthRefresherDeps["spawn"],
  };
  if (opts.safetyMarginMs !== undefined) {
    deps.safetyMarginMs = opts.safetyMarginMs;
  }

  const refresher = new ClaudeOAuthRefresher(deps);

  return { rootDir, refresher, spawnHandle, repushCalls, sseCalls, now, setNow };
}

function cleanupRig(rig: TestRig): void {
  rig.refresher.stop();
  fs.rmSync(rig.rootDir, { recursive: true, force: true });
}

describe("ClaudeOAuthRefresher", () => {
  let rigs: TestRig[] = [];
  afterEach(() => {
    for (const rig of rigs) cleanupRig(rig);
    rigs = [];
  });

  it("noop when token is healthy and tier1 doesn't rotate", async () => {
    const now = 1_700_000_000_000;
    const future = now + 8 * 60 * 60 * 1000;
    const rig = buildRig({
      accounts: [makeAccount("claude-default")],
      initialExpiries: { "claude-default": future },
      initialNow: now,
    });
    rigs.push(rig);
    rig.spawnHandle.effects = [{}];

    const [result] = await rig.refresher.refreshNow("claude-default");
    expect(result!.outcome).toBe("noop");
    expect(rig.spawnHandle.invocations.length).toBe(1);
    expect(rig.spawnHandle.invocations[0]!.args).toContain("status");
    expect(rig.repushCalls.length).toBe(0);
    expect(rig.refresher._inspectForTest("claude-default").failureCount).toBe(0);
  });

  it("rotates via tier1 and repushes to pinned sessions", async () => {
    const now = 1_700_000_000_000;
    const future = now + 8 * 60 * 60 * 1000;
    const rotatedTo = now + 16 * 60 * 60 * 1000;
    const rig = buildRig({
      accounts: [makeAccount("claude-default")],
      initialExpiries: { "claude-default": future },
      initialNow: now,
    });
    rigs.push(rig);
    rig.spawnHandle.effects = [{ rotateTo: rotatedTo }];

    const [result] = await rig.refresher.refreshNow("claude-default");
    expect(result!.outcome).toBe("rotated_tier1");
    expect(result!.afterExpiresAt).toBe(rotatedTo);
    expect(rig.spawnHandle.invocations.length).toBe(1);
    expect(rig.repushCalls).toEqual([{ agentId: "claude", accountId: "claude-default" }]);
  });

  it("falls through to tier2 when tier1 doesn't rotate and token is near expiry", async () => {
    const now = 1_700_000_000_000;
    const nearExpiry = now + 10 * 60 * 1000;
    const rotatedTo = now + 8 * 60 * 60 * 1000;
    const rig = buildRig({
      accounts: [makeAccount("claude-default")],
      initialExpiries: { "claude-default": nearExpiry },
      initialNow: now,
    });
    rigs.push(rig);
    rig.spawnHandle.effects = [
      {},
      { rotateTo: rotatedTo },
    ];

    const [result] = await rig.refresher.refreshNow("claude-default");
    expect(result!.outcome).toBe("rotated_tier2");
    expect(rig.spawnHandle.invocations.length).toBe(2);
    const tier2Args = rig.spawnHandle.invocations[1]!.args;
    expect(tier2Args).toContain("--print");
    expect(tier2Args).toContain("--model");
    expect(tier2Args).toContain("--no-session-persistence");
    expect(rig.repushCalls.length).toBe(1);
  });

  it("classifies a 429 in the debug log as rate_limited and schedules backoff", async () => {
    const now = 1_700_000_000_000;
    const nearExpiry = now + 5 * 60 * 1000;
    const rig = buildRig({
      accounts: [makeAccount("claude-default")],
      initialExpiries: { "claude-default": nearExpiry },
      initialNow: now,
    });
    rigs.push(rig);
    rig.spawnHandle.effects = [
      { stderr: "HTTP 429 rate_limit_error" },
      { stderr: "HTTP 429 rate_limit_error" },
    ];

    const [result] = await rig.refresher.refreshNow("claude-default");
    expect(result!.outcome).toBe("rate_limited");
    expect(rig.repushCalls.length).toBe(0);
    expect(rig.refresher._inspectForTest("claude-default").failureCount).toBe(1);
    expect(rig.refresher._inspectForTest("claude-default").hasTimer).toBe(true);
    expect(rig.sseCalls.find((c) => c.event === "agent_auth_failed")).toBeUndefined();
    expect(rig.sseCalls.find((c) => c.event === "claude_account_unauthenticated")).toBeUndefined();
  });

  it("classifies invalid_grant as revoked and emits per-account + global auth events", async () => {
    const now = 1_700_000_000_000;
    const nearExpiry = now + 5 * 60 * 1000;
    const rig = buildRig({
      accounts: [makeAccount("claude-default")],
      initialExpiries: { "claude-default": nearExpiry },
      initialNow: now,
    });
    rigs.push(rig);
    rig.spawnHandle.effects = [
      { stderr: "OAuth error: invalid_grant — refresh token expired" },
      { stderr: "OAuth error: invalid_grant — refresh token expired" },
    ];

    const [result] = await rig.refresher.refreshNow("claude-default");
    expect(result!.outcome).toBe("revoked");

    const sseEvents = rig.sseCalls.map((c) => c.event);
    expect(sseEvents).toContain("claude_account_unauthenticated");
    expect(sseEvents).toContain("agent_auth_failed");
    const failed = rig.sseCalls.find((c) => c.event === "agent_auth_failed");
    expect(failed!.data).toEqual({ loginId: "anthropic-oauth", accountId: "claude-default", reason: "revoked" });

    const perAccount = rig.sseCalls.find((c) => c.event === "claude_account_unauthenticated");
    expect(perAccount!.data).toEqual({ accountId: "claude-default" });

    expect(rig.refresher._inspectForTest("claude-default").emittedUnauthenticated).toBe(true);
    expect(rig.refresher._inspectForTest("claude-default").hasTimer).toBe(false);
  });

  it("classifies runtime 401 invalid-credentials output as unknown_failure (NOT revoked) and keeps retrying", async () => {
    const now = 1_700_000_000_000;
    const nearExpiry = now + 5 * 60 * 1000;
    const rig = buildRig({
      accounts: [makeAccount("claude-default")],
      initialExpiries: { "claude-default": nearExpiry },
      initialNow: now,
    });
    rigs.push(rig);
    rig.spawnHandle.effects = [
      { stderr: "auth status did not rotate" },
      {
        stderr: [
          "Failed to authenticate.",
          "API Error: 401 Invalid authentication credentials",
        ].join(" "),
      },
    ];

    const [result] = await rig.refresher.refreshNow("claude-default");
    expect(result!.outcome).toBe("unknown_failure");

    const sseEvents = rig.sseCalls.map((c) => c.event);
    expect(sseEvents).not.toContain("claude_account_unauthenticated");
    expect(sseEvents).not.toContain("agent_auth_failed");
    expect(rig.refresher._inspectForTest("claude-default").emittedUnauthenticated).toBe(false);
    expect(rig.refresher._inspectForTest("claude-default").hasTimer).toBe(true);
  });

  it("classifies expired-token 401 + refresh 429 as rate_limited (NOT revoked)", async () => {
    const now = 1_700_000_000_000;
    const expired = now - 5 * 60 * 1000;
    const rig = buildRig({
      accounts: [makeAccount("claude-default")],
      initialExpiries: { "claude-default": expired },
      initialNow: now,
    });
    rigs.push(rig);
    rig.spawnHandle.effects = [
      { stderr: "auth status did not rotate" },
      {
        stderr: [
          'API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired."}}',
          "POST https://console.anthropic.com/v1/oauth/token → 429 rate_limit_error",
        ].join("\n"),
      },
    ];

    const [result] = await rig.refresher.refreshNow("claude-default");
    expect(result!.outcome).toBe("rate_limited");

    const sseEvents = rig.sseCalls.map((c) => c.event);
    expect(sseEvents).not.toContain("claude_account_unauthenticated");
    expect(sseEvents).not.toContain("agent_auth_failed");
    expect(rig.refresher._inspectForTest("claude-default").emittedUnauthenticated).toBe(false);
    expect(rig.refresher._inspectForTest("claude-default").hasTimer).toBe(true);
  });

  it("does not emit claude_account_unauthenticated twice across repeated revoked outcomes", async () => {
    const now = 1_700_000_000_000;
    const nearExpiry = now + 5 * 60 * 1000;
    const rig = buildRig({
      accounts: [makeAccount("claude-default")],
      initialExpiries: { "claude-default": nearExpiry },
      initialNow: now,
    });
    rigs.push(rig);
    rig.spawnHandle.effects = [
      { stderr: "invalid_grant" }, { stderr: "invalid_grant" },
      { stderr: "invalid_grant" }, { stderr: "invalid_grant" },
    ];

    await rig.refresher.refreshNow("claude-default");
    await rig.refresher.refreshNow("claude-default");

    const perAccount = rig.sseCalls.filter((c) => c.event === "claude_account_unauthenticated");
    expect(perAccount.length).toBe(1);
  });

  it("emits claude_account_authenticated when a previously-revoked account rotates successfully", async () => {
    const now = 1_700_000_000_000;
    const nearExpiry = now + 5 * 60 * 1000;
    const rotatedTo = now + 8 * 60 * 60 * 1000;
    const rig = buildRig({
      accounts: [makeAccount("claude-default")],
      initialExpiries: { "claude-default": nearExpiry },
      initialNow: now,
    });
    rigs.push(rig);
    rig.spawnHandle.effects = [
      { stderr: "invalid_grant" }, { stderr: "invalid_grant" },
      { rotateTo: rotatedTo },
    ];

    await rig.refresher.refreshNow("claude-default");
    expect(rig.sseCalls.some((c) => c.event === "claude_account_unauthenticated")).toBe(true);

    const [result] = await rig.refresher.refreshNow("claude-default");
    expect(result!.outcome).toBe("rotated_tier1");
    expect(rig.sseCalls.some((c) => c.event === "claude_account_authenticated")).toBe(true);
    expect(rig.refresher._inspectForTest("claude-default").emittedUnauthenticated).toBe(false);
  });

  it("emits account_reauthenticated on the revoked → recovered transition (drives the picker un-stick)", async () => {
    const now = 1_700_000_000_000;
    const nearExpiry = now + 5 * 60 * 1000;
    const rotatedTo = now + 8 * 60 * 60 * 1000;
    const rig = buildRig({
      accounts: [makeAccount("claude-default")],
      initialExpiries: { "claude-default": nearExpiry },
      initialNow: now,
    });
    rigs.push(rig);
    rig.spawnHandle.effects = [
      { stderr: "invalid_grant" }, { stderr: "invalid_grant" },
      { rotateTo: rotatedTo },
    ];

    const reauthEvents: string[] = [];
    rig.refresher.on("account_reauthenticated", (accountId: string) => {
      reauthEvents.push(accountId);
    });

    await rig.refresher.refreshNow("claude-default");
    expect(reauthEvents).toEqual([]);

    await rig.refresher.refreshNow("claude-default");
    expect(reauthEvents).toEqual(["claude-default"]);
  });

  it("does NOT emit account_reauthenticated on a routine healthy rotation (no prior revoke)", async () => {
    const now = 1_700_000_000_000;
    const nearExpiry = now + 5 * 60 * 1000;
    const rotatedTo = now + 8 * 60 * 60 * 1000;
    const rig = buildRig({
      accounts: [makeAccount("claude-default")],
      initialExpiries: { "claude-default": nearExpiry },
      initialNow: now,
    });
    rigs.push(rig);
    rig.spawnHandle.effects = [{ rotateTo: rotatedTo }];

    const reauthEvents: string[] = [];
    rig.refresher.on("account_reauthenticated", (accountId: string) => {
      reauthEvents.push(accountId);
    });

    const [result] = await rig.refresher.refreshNow("claude-default");
    expect(result!.outcome).toBe("rotated_tier1");
    expect(reauthEvents).toEqual([]);
  });

  it("single-flight: two concurrent refreshNow calls spawn the CLI exactly once", async () => {
    const now = 1_700_000_000_000;
    const future = now + 8 * 60 * 60 * 1000;
    const rotatedTo = now + 16 * 60 * 60 * 1000;
    const rig = buildRig({
      accounts: [makeAccount("claude-default")],
      initialExpiries: { "claude-default": future },
      initialNow: now,
    });
    rigs.push(rig);
    rig.spawnHandle.effects = [{ rotateTo: rotatedTo, delayMs: 25 }];

    const [a, b] = await Promise.all([
      rig.refresher.refreshNow("claude-default"),
      rig.refresher.refreshNow("claude-default"),
    ]);
    expect(rig.spawnHandle.invocations.length).toBe(1);
    expect(a[0]!.outcome).toBe("rotated_tier1");
    expect(b[0]!.outcome).toBe("rotated_tier1");
  });

  it("per-account isolation: failures on one account don't affect the other", async () => {
    const now = 1_700_000_000_000;
    const nearExpiry = now + 5 * 60 * 1000;
    const healthy = now + 8 * 60 * 60 * 1000;
    const rig = buildRig({
      accounts: [makeAccount("acct-a"), makeAccount("acct-b", { isPrimary: false })],
      initialExpiries: { "acct-a": nearExpiry, "acct-b": healthy },
      initialNow: now,
    });
    rigs.push(rig);
    rig.spawnHandle.effects = [
      { stderr: "invalid_grant" }, { stderr: "invalid_grant" },
      {},
    ];

    const results = await rig.refresher.refreshNow();
    const byId: Record<string, RefreshResult> = {};
    for (const r of results) byId[r.accountId] = r;
    expect(byId["acct-a"]!.outcome).toBe("revoked");
    expect(byId["acct-b"]!.outcome).toBe("noop");
    expect(rig.refresher._inspectForTest("acct-a").emittedUnauthenticated).toBe(true);
    expect(rig.refresher._inspectForTest("acct-b").emittedUnauthenticated).toBe(false);
  });

  it("start() schedules per known account and stop() cancels all pending timers", () => {
    vi.useFakeTimers();
    try {
      const now = 1_700_000_000_000;
      const future = now + 8 * 60 * 60 * 1000;
      const rig = buildRig({
        accounts: [makeAccount("acct-a"), makeAccount("acct-b")],
        initialExpiries: { "acct-a": future, "acct-b": future },
        initialNow: now,
      });
      rigs.push(rig);

      rig.refresher.start();
      expect(rig.refresher._inspectForTest("acct-a").hasTimer).toBe(true);
      expect(rig.refresher._inspectForTest("acct-b").hasTimer).toBe(true);

      rig.refresher.stop();
      expect(rig.refresher._inspectForTest("acct-a").hasTimer).toBe(false);
      expect(rig.refresher._inspectForTest("acct-b").hasTimer).toBe(false);

      vi.advanceTimersByTime(10 * 60 * 60 * 1000);
      expect(rig.spawnHandle.invocations.length).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("start() is a no-op in local runtime mode", () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-refresh-local-"));
    const accounts = [makeAccount("claude-default")];
    const pam = makeProviderAccountManager({ rootDir, accounts });
    const accountRoot = pam.resolveCredentialRoot("claude", "claude-default");
    fs.mkdirSync(accountRoot, { recursive: true });
    writeCredentials(accountRoot, { expiresAt: Date.now() + 60 * 60 * 1000 });

    const spawnHandle = makeFakeSpawn((env) => env.HOME ?? "");
    const refresher = new ClaudeOAuthRefresher({
      credentialsDir: rootDir,
      providerAccountManager: pam,
      repushAccountToken: () => {},
      sseBroadcast: () => {},
      runtimeMode: "local",
      spawn: spawnHandle.spawn as unknown as ClaudeOAuthRefresherDeps["spawn"],
    });
    refresher.start();
    expect(refresher._knownAccountsForTest().length).toBe(0);
    expect(spawnHandle.invocations.length).toBe(0);
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it("marks missing source credentials unauthenticated once and recovers after re-auth", async () => {
    const now = 1_700_000_000_000;
    const rig = buildRig({
      accounts: [makeAccount("claude-default")],
      initialNow: now,
    });
    rigs.push(rig);

    const unauthenticated: string[] = [];
    const reauthenticated: string[] = [];
    rig.refresher.on("account_unauthenticated", (accountId: string) => unauthenticated.push(accountId));
    rig.refresher.on("account_reauthenticated", (accountId: string) => reauthenticated.push(accountId));

    const [result] = await rig.refresher.refreshNow("claude-default");
    await rig.refresher.refreshNow("claude-default");
    expect(result!.outcome).toBe("missing_credentials");
    expect(rig.spawnHandle.invocations.length).toBe(0);
    expect(rig.repushCalls.length).toBe(0);
    expect(unauthenticated).toEqual(["claude-default"]);
    expect(rig.sseCalls).toContainEqual({
      event: "agent_auth_failed",
      data: { loginId: "anthropic-oauth", accountId: "claude-default", reason: "missing_credentials" },
    });
    expect(rig.sseCalls.filter((call) => call.event === "agent_auth_failed")).toHaveLength(1);

    writeCredentials(
      path.join(rig.rootDir, "provider-accounts", "claude", "claude-default"),
      { expiresAt: now + 8 * 60 * 60 * 1000 },
    );
    await rig.refresher.refreshNow("claude-default");
    expect(reauthenticated).toEqual(["claude-default"]);
    expect(rig.repushCalls).toEqual([{ agentId: "claude", accountId: "claude-default" }]);
    expect(rig.refresher._inspectForTest("claude-default").emittedUnauthenticated).toBe(false);
  });

  describe("ensureFresh", () => {
    it("is a no-op (no CLI spawn) and returns true when the token is healthy", async () => {
      const now = 1_700_000_000_000;
      const future = now + 8 * 60 * 60 * 1000;
      const rig = buildRig({
        accounts: [makeAccount("claude-default")],
        initialExpiries: { "claude-default": future },
        initialNow: now,
      });
      rigs.push(rig);

      const ok = await rig.refresher.ensureFresh("claude-default");
      expect(ok).toBe(true);
      expect(rig.spawnHandle.invocations.length).toBe(0);
    });

    it("heals a within-margin token via a single-flight refresh and returns true", async () => {
      const now = 1_700_000_000_000;
      const nearExpiry = now + 10 * 60 * 1000;
      const rotatedTo = now + 8 * 60 * 60 * 1000;
      const rig = buildRig({
        accounts: [makeAccount("claude-default")],
        initialExpiries: { "claude-default": nearExpiry },
        initialNow: now,
      });
      rigs.push(rig);
      rig.spawnHandle.effects = [{ rotateTo: rotatedTo }];

      const ok = await rig.refresher.ensureFresh("claude-default");
      expect(ok).toBe(true);
      expect(rig.spawnHandle.invocations.length).toBe(1);
      expect(rig.repushCalls).toEqual([{ agentId: "claude", accountId: "claude-default" }]);
    });

    it("returns false when an expired token can't be refreshed (revoked)", async () => {
      const now = 1_700_000_000_000;
      const expired = now - 60 * 1000;
      const rig = buildRig({
        accounts: [makeAccount("claude-default")],
        initialExpiries: { "claude-default": expired },
        initialNow: now,
      });
      rigs.push(rig);
      rig.spawnHandle.effects = [
        { stderr: "invalid_grant" },
        { stderr: "invalid_grant" },
      ];

      const ok = await rig.refresher.ensureFresh("claude-default");
      expect(ok).toBe(false);
    });

    it("returns false when there is no source token", async () => {
      const now = 1_700_000_000_000;
      const rig = buildRig({
        accounts: [makeAccount("claude-default")],
        initialNow: now,
      });
      rigs.push(rig);

      const ok = await rig.refresher.ensureFresh("claude-default");
      expect(ok).toBe(false);
      expect(rig.spawnHandle.invocations.length).toBe(0);
    });

    it("forced: probes a healthy token with tier 2 instead of short-circuiting", async () => {
      const now = 1_700_000_000_000;
      const future = now + 8 * 60 * 60 * 1000;
      const rig = buildRig({
        accounts: [makeAccount("claude-default")],
        initialExpiries: { "claude-default": future },
        initialNow: now,
      });
      rigs.push(rig);
      rig.spawnHandle.effects = [{}, {}];

      const ok = await rig.refresher.ensureFresh("claude-default", { force: true });
      expect(ok).toBe(true);
      expect(rig.spawnHandle.invocations.length).toBe(2);
      expect(rig.spawnHandle.invocations[0]!.args).toContain("status");
      expect(rig.spawnHandle.invocations[1]!.args).toContain("--print");
    });

    it("forced: a probe that rotates repushes the new token to pinned sessions", async () => {
      const now = 1_700_000_000_000;
      const future = now + 8 * 60 * 60 * 1000;
      const rig = buildRig({
        accounts: [makeAccount("claude-default")],
        initialExpiries: { "claude-default": future },
        initialNow: now,
      });
      rigs.push(rig);
      rig.spawnHandle.effects = [{ rotateTo: now + 12 * 60 * 60 * 1000 }];

      const ok = await rig.refresher.ensureFresh("claude-default", { force: true });
      expect(ok).toBe(true);
      expect(rig.repushCalls).toEqual([{ agentId: "claude", accountId: "claude-default" }]);
    });

    it("forced: reports NOT healed when the probe finds a revoked grant", async () => {
      const now = 1_700_000_000_000;
      const future = now + 8 * 60 * 60 * 1000;
      const rig = buildRig({
        accounts: [makeAccount("claude-default")],
        initialExpiries: { "claude-default": future },
        initialNow: now,
      });
      rigs.push(rig);
      rig.spawnHandle.effects = [{ stderr: "invalid_grant" }, { stderr: "invalid_grant" }];

      const ok = await rig.refresher.ensureFresh("claude-default", { force: true });
      expect(ok).toBe(false);
    });

    it("forced: a live-token probe does not push the account into refresh backoff", async () => {
      const now = 1_700_000_000_000;
      const future = now + 8 * 60 * 60 * 1000;
      const rig = buildRig({
        accounts: [makeAccount("claude-default")],
        initialExpiries: { "claude-default": future },
        initialNow: now,
      });
      rigs.push(rig);
      rig.spawnHandle.effects = [{}, {}];

      await rig.refresher.ensureFresh("claude-default", { force: true });
      expect(rig.refresher._inspectForTest("claude-default").failureCount).toBe(0);
    });

    it("unforced: still short-circuits on a healthy token (proactive sweep unchanged)", async () => {
      const now = 1_700_000_000_000;
      const future = now + 8 * 60 * 60 * 1000;
      const rig = buildRig({
        accounts: [makeAccount("claude-default")],
        initialExpiries: { "claude-default": future },
        initialNow: now,
      });
      rigs.push(rig);

      expect(await rig.refresher.ensureFresh("claude-default", { force: false })).toBe(true);
      expect(await rig.refresher.ensureFresh("claude-default")).toBe(true);
      expect(rig.spawnHandle.invocations.length).toBe(0);
    });

    it("is a no-op returning true in local runtime mode", async () => {
      const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-ensure-local-"));
      const accounts = [makeAccount("claude-default")];
      const pam = makeProviderAccountManager({ rootDir, accounts });
      const accountRoot = pam.resolveCredentialRoot("claude", "claude-default");
      fs.mkdirSync(accountRoot, { recursive: true });
      writeCredentials(accountRoot, { expiresAt: 1 });
      const spawnHandle = makeFakeSpawn((env) => env.HOME ?? "");
      const refresher = new ClaudeOAuthRefresher({
        credentialsDir: rootDir,
        providerAccountManager: pam,
        repushAccountToken: () => {},
        sseBroadcast: () => {},
        runtimeMode: "local",
        spawn: spawnHandle.spawn as unknown as ClaudeOAuthRefresherDeps["spawn"],
      });

      const ok = await refresher.ensureFresh("claude-default");
      expect(ok).toBe(true);
      expect(spawnHandle.invocations.length).toBe(0);
      fs.rmSync(rootDir, { recursive: true, force: true });
    });
  });

  describe("harvest before spend", () => {
    it("adopts a pinned session's newer token and never spawns the CLI", async () => {
      const now = 1_700_000_000_000;
      const rig = buildRig({
        accounts: [makeAccount("acct-1")],
        initialExpiries: { "acct-1": now + 10 * 60 * 1000 },
        initialNow: now,
      });
      rigs.push(rig);
      const rotatedTo = now + 8 * 60 * 60 * 1000;
      writeSessionToken(rig.rootDir, "sess-a", { expiresAt: rotatedTo, accountId: "acct-1" });

      const [result] = await rig.refresher.refreshNow("acct-1");

      expect(result!.outcome).toBe("harvested_session");
      expect(result!.afterExpiresAt).toBe(rotatedTo);
      expect(rig.spawnHandle.invocations.length).toBe(0);
      expect(fs.readFileSync(accountTokenFile(rig.rootDir, "acct-1"), "utf8")).toContain(`sess_tok_${rotatedTo}`);
      expect(rig.repushCalls).toEqual([{ agentId: "claude", accountId: "acct-1" }]);
    });

    it("takes the newest copy when several sessions hold rotations", async () => {
      const now = 1_700_000_000_000;
      const rig = buildRig({
        accounts: [makeAccount("acct-1")],
        initialExpiries: { "acct-1": now + 10 * 60 * 1000 },
        initialNow: now,
      });
      rigs.push(rig);
      const newest = now + 9 * 60 * 60 * 1000;
      writeSessionToken(rig.rootDir, "sess-a", { expiresAt: now + 2 * 60 * 60 * 1000, accountId: "acct-1" });
      writeSessionToken(rig.rootDir, "sess-b", { expiresAt: newest, accountId: "acct-1" });
      writeSessionToken(rig.rootDir, "sess-c", { expiresAt: now + 3 * 60 * 60 * 1000, accountId: "acct-1" });

      const [result] = await rig.refresher.refreshNow("acct-1");

      expect(result!.outcome).toBe("harvested_session");
      expect(result!.afterExpiresAt).toBe(newest);
      expect(fs.readFileSync(accountTokenFile(rig.rootDir, "acct-1"), "utf8")).toContain(`sess_tok_${newest}`);
    });

    it("ignores a session copy that is behind the source", async () => {
      const now = 1_700_000_000_000;
      const sourceExpiry = now + 10 * 60 * 1000;
      const rig = buildRig({
        accounts: [makeAccount("acct-1")],
        initialExpiries: { "acct-1": sourceExpiry },
        initialNow: now,
      });
      rigs.push(rig);
      writeSessionToken(rig.rootDir, "sess-a", { expiresAt: now + 5 * 60 * 1000, accountId: "acct-1" });
      rig.spawnHandle.effects = [{ rotateTo: now + 8 * 60 * 60 * 1000 }];

      const [result] = await rig.refresher.refreshNow("acct-1");

      expect(result!.outcome).toBe("rotated_tier1");
      expect(rig.spawnHandle.invocations.length).toBe(1);
      expect(fs.readFileSync(accountTokenFile(rig.rootDir, "acct-1"), "utf8")).not.toContain("sess_tok_");
    });

    it("ignores a newer copy whose subtree marker names another account", async () => {
      const now = 1_700_000_000_000;
      const rig = buildRig({
        accounts: [makeAccount("acct-1")],
        initialExpiries: { "acct-1": now + 10 * 60 * 1000 },
        initialNow: now,
      });
      rigs.push(rig);
      writeSessionToken(rig.rootDir, "sess-a", { expiresAt: now + 8 * 60 * 60 * 1000, accountId: "acct-2" });
      rig.spawnHandle.effects = [{ rotateTo: now + 6 * 60 * 60 * 1000 }];

      const [result] = await rig.refresher.refreshNow("acct-1");

      expect(result!.outcome).toBe("rotated_tier1");
      expect(fs.readFileSync(accountTokenFile(rig.rootDir, "acct-1"), "utf8")).not.toContain("sess_tok_");
    });

    it("ignores a newer copy in a subtree with no recorded account at all", async () => {
      const now = 1_700_000_000_000;
      const rig = buildRig({
        accounts: [makeAccount("acct-1")],
        initialExpiries: { "acct-1": now + 10 * 60 * 1000 },
        initialNow: now,
      });
      rigs.push(rig);
      writeSessionToken(rig.rootDir, "sess-a", { expiresAt: now + 8 * 60 * 60 * 1000, accountId: null });
      rig.spawnHandle.effects = [{ rotateTo: now + 6 * 60 * 60 * 1000 }];

      const [result] = await rig.refresher.refreshNow("acct-1");

      expect(result!.outcome).toBe("rotated_tier1");
      expect(fs.readFileSync(accountTokenFile(rig.rootDir, "acct-1"), "utf8")).not.toContain("sess_tok_");
    });

    it("skips a session whose subtree escapes into another account's root", async () => {
      const now = 1_700_000_000_000;
      const rig = buildRig({
        accounts: [makeAccount("acct-1"), makeAccount("acct-2")],
        initialExpiries: {
          "acct-1": now + 10 * 60 * 1000,
          "acct-2": now + 8 * 60 * 60 * 1000,
        },
        initialNow: now,
      });
      rigs.push(rig);

      const sessionDir = path.join(rig.rootDir, "sessions", "sess-a");
      fs.mkdirSync(sessionDir, { recursive: true });
      writeSessionAccountMarker(rig.rootDir, "sess-a", "claude", "acct-1");
      fs.symlinkSync(
        path.join(rig.rootDir, "provider-accounts", "claude", "acct-2", ".claude"),
        path.join(sessionDir, ".claude"),
      );
      rig.spawnHandle.effects = [{ rotateTo: now + 6 * 60 * 60 * 1000 }];

      const [result] = await rig.refresher.refreshNow("acct-1");

      expect(result!.outcome).toBe("rotated_tier1");
      const acct1 = fs.readFileSync(accountTokenFile(rig.rootDir, "acct-1"), "utf8");
      const acct2 = fs.readFileSync(accountTokenFile(rig.rootDir, "acct-2"), "utf8");
      const acct2Token = (JSON.parse(acct2) as { claudeAiOauth: { accessToken: string } })
        .claudeAiOauth.accessToken;
      expect(acct1).not.toContain(acct2Token);
    });

    it("leaves a blanked source on disk and still reports missing_credentials", async () => {
      const now = 1_700_000_000_000;
      const rig = buildRig({ accounts: [makeAccount("acct-1")], initialNow: now });
      rigs.push(rig);
      const accountRoot = path.join(rig.rootDir, "provider-accounts", "claude", "acct-1");
      writeBlankedCredentials(accountRoot);
      writeSessionToken(rig.rootDir, "sess-a", { expiresAt: now + 8 * 60 * 60 * 1000, accountId: "acct-1" });

      const [result] = await rig.refresher.refreshNow("acct-1");

      expect(result!.outcome).toBe("missing_credentials");
      expect(result!.reason).toContain("blanked");
      expect(fs.existsSync(path.join(accountRoot, ".claude", ".credentials.json"))).toBe(true);
    });
  });

  describe("failure logging", () => {
    it("names a blanked source distinctly from a missing one", async () => {
      const now = 1_700_000_000_000;
      const rig = buildRig({ accounts: [makeAccount("acct-1")], initialNow: now });
      rigs.push(rig);

      const [missing] = await rig.refresher.refreshNow("acct-1");
      expect(missing!.outcome).toBe("missing_credentials");
      expect(missing!.reason).toContain("missing");

      writeBlankedCredentials(path.join(rig.rootDir, "provider-accounts", "claude", "acct-1"));
      const logs = captureLogs();
      const [blanked] = await rig.refresher.refreshNow("acct-1");
      logs.restore();

      expect(blanked!.outcome).toBe("missing_credentials");
      expect(blanked!.reason).toContain("blanked");
      expect(logs.lines.some((line) => line.includes("missing_credentials — waiting for auth_complete")
        && line.includes("source=blanked"))).toBe(true);
    });

    it("logs a redacted excerpt of the CLI output on an unclassified failure", async () => {
      const now = 1_700_000_000_000;
      const rig = buildRig({
        accounts: [makeAccount("acct-1")],
        initialExpiries: { "acct-1": now + 10 * 60 * 1000 },
        initialNow: now,
      });
      rigs.push(rig);
      rig.spawnHandle.effects = [
        {},
        { stderr: "claude v2.1.0\nError: token refresh did not complete\n"
            + `Authorization: Bearer ${FAKE_OAUTH_TOKEN}\n` },
      ];

      const logs = captureLogs();
      const [result] = await rig.refresher.refreshNow("acct-1");
      logs.restore();

      expect(result!.outcome).toBe("unknown_failure");
      expect(result!.reason).toContain("token refresh did not complete");
      expect(result!.reason).not.toContain(FAKE_OAUTH_TOKEN);
      const failureLine = logs.lines.find((line) => line.includes("unknown_failure failure_count=1"));
      expect(failureLine).toBeDefined();
      expect(failureLine).toContain("— short backoff reason=\"");
      expect(failureLine).not.toContain(FAKE_OAUTH_TOKEN);
    });
  });
});

describe("summarizeRefreshFailure", () => {
  it("prefers lines that carry a failure signal", () => {
    const summary = summarizeRefreshFailure(
      "starting up\nloading config\nError: 429 rate_limit_exceeded\ndone",
    );
    expect(summary).toBe("Error: 429 rate_limit_exceeded");
  });

  it("falls back to the tail when nothing looks like a failure", () => {
    expect(summarizeRefreshFailure("quiet\noutput")).toBe("quiet | output");
    expect(summarizeRefreshFailure("   \n  ")).toBe("no CLI output");
  });

  it("redacts credentials in every shape the CLI emits them", () => {
    const opaque = "A".repeat(48);
    const summary = summarizeRefreshFailure(
      `Error: {"accessToken":"abc123","refreshToken":"${FAKE_OAUTH_TOKEN}"} `
        + `authorization: Bearer ${opaque}`,
    );
    expect(summary).toContain("Error:");
    expect(summary).not.toContain("abc123");
    expect(summary).not.toContain(FAKE_OAUTH_TOKEN);
    expect(summary).not.toContain(opaque);
  });

  it("drops credential-bearing headers whole, whatever the value looks like", () => {
    const summary = summarizeRefreshFailure(
      "x-api-key: abc123\nAuthorization: Basic dXNlcjpwdw==",
    );
    expect(summary).not.toContain("abc123");
    expect(summary).not.toContain("dXNlcjpwdw==");
    expect(summary).toContain("x-api-key: [redacted]");
  });

  it("keeps the failure line and drops noise around it", () => {
    const summary = summarizeRefreshFailure(
      "POST /v1/oauth/token\nAuthorization: Bearer abcdef\nError: 401 invalid_grant",
    );
    expect(summary).toBe("Error: 401 invalid_grant");
  });

  it("caps the excerpt so one runaway line cannot flood the log", () => {
    expect(summarizeRefreshFailure(`Error: ${"x".repeat(5_000)}`).length).toBeLessThanOrEqual(300);
  });
});
