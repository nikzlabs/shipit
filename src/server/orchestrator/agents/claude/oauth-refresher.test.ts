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

function accountRootOf(rootDir: string, accountId: string): string {
  return path.join(rootDir, "provider-accounts", "claude", accountId);
}

function accountTokenFile(rootDir: string, accountId: string): string {
  return path.join(accountRootOf(rootDir, accountId), ".claude", ".credentials.json");
}

function readSourceCredentials(rootDir: string, accountId: string): SeenCredentials {
  const raw = fs.readFileSync(accountTokenFile(rootDir, accountId), "utf8");
  return (JSON.parse(raw) as { claudeAiOauth: SeenCredentials }).claudeAiOauth;
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
  // What the CLI does to the credential file it runs against on invalid_grant.
  blank?: boolean;
  sideEffect?: () => void;
  // Never exits by itself; the test emits "exit" on the child.
  hang?: boolean;
  // What Node reports for a binary that is not on the PATH: an error, and no exit.
  failsToStart?: boolean;
  spawnThrows?: boolean;
  debugLog?: string;
  stderr?: string;
  stdout?: string;
  exitCode?: number;
  delayMs?: number;
}

interface SeenCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

interface FakeSpawnHandle {
  invocations: { args: string[]; home: string; credentials: SeenCredentials | null }[];
  children: ChildProcess[];
  effects: SpawnEffect[];
  spawn: (cmd: string, args?: readonly string[], opts?: { env?: Record<string, string> }) => ChildProcess;
}

function makeFakeSpawn(getAccountRoot: (env: Record<string, string>) => string): FakeSpawnHandle {
  const handle: FakeSpawnHandle = {
    invocations: [],
    children: [],
    effects: [],
    spawn: (() => undefined as unknown) as FakeSpawnHandle["spawn"],
  };

  handle.spawn = ((cmd, args, opts) => {
    const argArr = Array.from(args ?? []);
    const accountRoot = opts?.env ? getAccountRoot(opts.env) : "";
    let credentials: SeenCredentials | null = null;
    try {
      const raw = fs.readFileSync(path.join(accountRoot, ".claude", ".credentials.json"), "utf8");
      credentials = (JSON.parse(raw) as { claudeAiOauth: SeenCredentials }).claudeAiOauth;
    } catch { /* no credential in this HOME */ }
    handle.invocations.push({ args: argArr, home: accountRoot, credentials });
    const idx = handle.invocations.length - 1;
    const effect = handle.effects[idx] ?? { exitCode: 0 };
    if (effect.spawnThrows) throw new Error("spawn EAGAIN");

    const child = new EventEmitter() as ChildProcess;
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    (child as unknown as { stdout: EventEmitter }).stdout = stdout;
    (child as unknown as { stderr: EventEmitter }).stderr = stderr;
    (child as unknown as { kill: (sig?: string) => boolean }).kill = () => true;
    handle.children.push(child);

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
      effect.sideEffect?.();
      if (effect.rotateTo !== undefined && accountRoot) {
        writeCredentials(accountRoot, { expiresAt: effect.rotateTo });
      }
      if (effect.blank && accountRoot) writeBlankedCredentials(accountRoot);
      child.emit("exit", effect.exitCode ?? 0, null);
    };
    if (effect.hang) return child;
    if (effect.failsToStart) {
      setTimeout(() => child.emit("error", Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" })), 0);
      return child;
    }
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
  lateRotationWaitMs?: number;
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
    lateRotationWaitMs: opts.lateRotationWaitMs ?? 0,
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

  it("noop without a CLI spawn when the token is healthy", async () => {
    const now = 1_700_000_000_000;
    const future = now + 8 * 60 * 60 * 1000;
    const rig = buildRig({
      accounts: [makeAccount("claude-default")],
      initialExpiries: { "claude-default": future },
      initialNow: now,
    });
    rigs.push(rig);

    const [result] = await rig.refresher.refreshNow("claude-default");
    expect(result!.outcome).toBe("noop");
    expect(rig.spawnHandle.invocations.length).toBe(0);
    expect(rig.repushCalls.length).toBe(0);
    expect(rig.refresher._inspectForTest("claude-default").failureCount).toBe(0);
  });

  it("rotates via tier1 and repushes to pinned sessions", async () => {
    const now = 1_700_000_000_000;
    const future = now + 40 * 60 * 1000;
    const rotatedTo = now + 8 * 60 * 60 * 1000;
    const rig = buildRig({
      accounts: [makeAccount("claude-default")],
      initialExpiries: { "claude-default": future },
      initialNow: now,
    });
    rigs.push(rig);
    const original = readSourceCredentials(rig.rootDir, "claude-default");
    rig.spawnHandle.effects = [{ rotateTo: rotatedTo }];

    const [result] = await rig.refresher.refreshNow("claude-default");
    expect(result!.outcome).toBe("rotated_tier1");
    expect(result!.afterExpiresAt).toBe(rotatedTo);
    expect(rig.spawnHandle.invocations.length).toBe(1);
    expect(rig.repushCalls).toEqual([{ agentId: "claude", accountId: "claude-default" }]);
    // The CLI rotated a private copy; the refresher installed the result into the source.
    expect(rig.spawnHandle.invocations[0]!.home).not.toBe(accountRootOf(rig.rootDir, "claude-default"));
    const installed = readSourceCredentials(rig.rootDir, "claude-default");
    expect(installed.expiresAt).toBe(rotatedTo);
    expect(installed.accessToken).not.toBe(original.accessToken);
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

    // A new sign-in: the rejected grant is never probed again.
    writeCredentials(accountRootOf(rig.rootDir, "claude-default"), { expiresAt: nearExpiry });
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

    writeCredentials(accountRootOf(rig.rootDir, "claude-default"), { expiresAt: nearExpiry });
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
    const future = now + 40 * 60 * 1000;
    const rotatedTo = now + 8 * 60 * 60 * 1000;
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

    it("heals a token at its last chance via a single-flight refresh and returns true", async () => {
      const now = 1_700_000_000_000;
      const nearExpiry = now + 4 * 60 * 1000;
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

    it("leaves a valid token to the schedule: a turn start before the last chance runs no tick", async () => {
      const now = 1_700_000_000_000;
      const rig = buildRig({
        accounts: [makeAccount("claude-default")],
        initialExpiries: { "claude-default": now + 40 * 60 * 1000 },
        initialNow: now,
      });
      rigs.push(rig);
      rig.spawnHandle.effects = [{}, {}];

      const [scheduled] = await rig.refresher.refreshNow("claude-default");
      expect(scheduled!.outcome).toBe("not_rotated");
      const spawnsAfterScheduledTick = rig.spawnHandle.invocations.length;

      rig.setNow(now + 10 * 60 * 1000);
      expect(await rig.refresher.ensureFresh("claude-default")).toBe(true);
      expect(rig.spawnHandle.invocations.length).toBe(spawnsAfterScheduledTick);
      expect(rig.refresher._inspectForTest("claude-default").failureCount).toBe(1);
    });

    it("does not spend the schedule's backoff at turn starts in the last minutes", async () => {
      const now = 1_700_000_000_000;
      const rig = buildRig({
        accounts: [makeAccount("claude-default")],
        initialExpiries: { "claude-default": now + 6 * 60 * 1000 },
        initialNow: now,
      });
      rigs.push(rig);
      rig.spawnHandle.effects = Array.from({ length: 6 }, () => ({ stderr: "HTTP 429 rate_limit_error" }));

      for (let turn = 0; turn < 5; turn++) await rig.refresher.ensureFresh("claude-default");
      expect(rig.spawnHandle.invocations.length).toBe(2);
      expect(rig.refresher._inspectForTest("claude-default").failureCount).toBe(1);

      // A session's 401 is not a turn start: it probes at once.
      await rig.refresher.ensureFresh("claude-default", { force: true });
      expect(rig.spawnHandle.invocations.length).toBe(4);
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
      // It tests the token as it is: the copy keeps the real expiry.
      expect(rig.spawnHandle.invocations[0]!.home).not.toBe(accountRootOf(rig.rootDir, "claude-default"));
      expect(rig.spawnHandle.invocations[0]!.credentials!.expiresAt).toBe(future);
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

    describe("forced: a probe that did not complete", () => {
      const now = 1_700_000_000_000;
      const NO_VERDICT = "forced probe did not complete — no verdict on the token";
      const FOUND_LIVE = "forced validity probe found a live token that needed no rotation";
      const EXPIRY_SCHEDULE_MS = (8 * 60 - 45) * 60 * 1000;

      function forcedRig(): TestRig {
        const rig = buildRig({
          accounts: [makeAccount("claude-default")],
          initialExpiries: { "claude-default": now + 8 * 60 * 60 * 1000 },
          initialNow: now,
        });
        rigs.push(rig);
        return rig;
      }

      // The heal's answer, the tick's result (a second call joins the forced tick) and the log.
      async function forcedHeal(rig: TestRig, drive?: () => Promise<void>): Promise<{
        healed: boolean;
        result: Awaited<ReturnType<TestRig["refresher"]["refreshNow"]>>[number];
        noVerdict: string[];
      }> {
        const logs = captureLogs();
        try {
          const heal = rig.refresher.ensureFresh("claude-default", { force: true });
          const tick = rig.refresher.refreshNow("claude-default");
          await drive?.();
          const healed = await heal;
          const [result] = await tick;
          return { healed, result, noVerdict: logs.lines.filter((line) => line.includes(NO_VERDICT)) };
        } finally {
          logs.restore();
        }
      }

      it("says so when the CLI cannot start, and changes neither the heal nor the schedule", async () => {
        const rig = forcedRig();
        rig.spawnHandle.effects = [{ failsToStart: true }, { failsToStart: true }];
        const timeouts = vi.spyOn(globalThis, "setTimeout");

        const { healed, result, noVerdict } = await forcedHeal(rig);
        const delays = timeouts.mock.calls.map((call) => call[1]);
        timeouts.mockRestore();

        const reason = "[error] spawn claude ENOENT | [error] spawn claude ENOENT";
        expect(noVerdict).toEqual([`[claude-oauth-refresh] account=claude-default ${NO_VERDICT} reason="${reason}"`]);
        expect(result!.reason).toBe(reason);
        expect(result!.outcome).toBe("noop");
        expect(healed).toBe(true);
        expect(rig.refresher._inspectForTest("claude-default").failureCount).toBe(0);
        // The account's timer is the last one set: the expiry schedule, and no backoff.
        expect(delays.at(-1)).toBe(EXPIRY_SCHEDULE_MS);
        expect(rig.sseCalls).toEqual([]);
      });

      it("says so when the spawn of tier 2 throws", async () => {
        const rig = forcedRig();
        rig.spawnHandle.effects = [{}, { spawnThrows: true }];

        const { healed, result, noVerdict } = await forcedHeal(rig);

        expect(noVerdict.length).toBe(1);
        expect(result!.reason).toBe("[spawn-failed] spawn EAGAIN");
        expect(healed).toBe(true);
      });

      it.each([
        { ending: "is killed after its timeout", exits: true },
        { ending: "does not end after the kill", exits: false },
      ])("says so when tier 2 $ending", async ({ exits }) => {
        vi.useFakeTimers();
        try {
          const rig = forcedRig();
          rig.spawnHandle.effects = [{}, { hang: true }];

          const { healed, result, noVerdict } = await forcedHeal(rig, async () => {
            await vi.advanceTimersByTimeAsync(60_000);
            if (exits) rig.spawnHandle.children[1]!.emit("exit", null, "SIGKILL");
            else await vi.advanceTimersByTimeAsync(5_000);
          });

          expect(noVerdict.length).toBe(1);
          expect(result!.reason).toBe("[timeout] claude CLI did not exit in time");
          expect(healed).toBe(true);
        } finally {
          vi.useRealTimers();
        }
      });

      it("writes no line when tier 2 completed, also after a tier 1 that timed out", async () => {
        const healthy = forcedRig();
        // Output that reads as the refresher's notes: the run's end decides, not its text.
        healthy.spawnHandle.effects = [{}, { stderr: "[timeout] claude CLI did not exit in time\n[error] spawn claude ENOENT\n" }];
        const ran = await forcedHeal(healthy);

        expect(ran.noVerdict).toEqual([]);
        expect(ran.result!.reason).toBe(FOUND_LIVE);

        vi.useFakeTimers();
        try {
          const rig = forcedRig();
          rig.spawnHandle.effects = [{ hang: true }, {}];

          const { healed, result, noVerdict } = await forcedHeal(rig, async () => {
            await vi.advanceTimersByTimeAsync(35_000);
            await vi.advanceTimersByTimeAsync(1);
          });

          expect(rig.spawnHandle.invocations.length).toBe(2);
          expect(noVerdict).toEqual([]);
          expect(result!.reason).toBe(FOUND_LIVE);
          expect(healed).toBe(true);
        } finally {
          vi.useRealTimers();
        }
      });

      it("redacts the reason", async () => {
        const rig = forcedRig();
        // On the line that the reason keeps: a line with no failure signal is dropped, token or not.
        rig.spawnHandle.effects = [
          { stderr: `Error: request failed with Bearer ${FAKE_OAUTH_TOKEN}\n` },
          { failsToStart: true },
        ];

        const { result, noVerdict } = await forcedHeal(rig);

        expect(noVerdict.length).toBe(1);
        expect(noVerdict[0]).toContain("Error: request failed with Bearer [redacted]");
        expect(noVerdict[0]).not.toContain(FAKE_OAUTH_TOKEN);
        expect(result!.reason).not.toContain(FAKE_OAUTH_TOKEN);
      });
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

  describe("private probe copy", () => {
    const now = 1_700_000_000_000;
    const inMargin = now + 40 * 60 * 1000;

    function marginRig(lateRotationWaitMs?: number): TestRig {
      const rig = buildRig({
        accounts: [makeAccount("acct-1")],
        initialExpiries: { "acct-1": inMargin },
        initialNow: now,
        lateRotationWaitMs,
      });
      rigs.push(rig);
      return rig;
    }

    it("runs both tiers in a private copy and removes it, never in the account root", async () => {
      const rig = marginRig();
      const sourceBefore = fs.readFileSync(accountTokenFile(rig.rootDir, "acct-1"), "utf8");
      rig.spawnHandle.effects = [{}, {}];

      await rig.refresher.refreshNow("acct-1");

      expect(rig.spawnHandle.invocations.length).toBe(2);
      for (const invocation of rig.spawnHandle.invocations) {
        expect(invocation.home).not.toBe(accountRootOf(rig.rootDir, "acct-1"));
        expect(fs.existsSync(invocation.home)).toBe(false);
      }
      expect(fs.readFileSync(accountTokenFile(rig.rootDir, "acct-1"), "utf8")).toBe(sourceBefore);
    });

    it("gives the CLI a copy that holds the source's tokens and claims a short life", async () => {
      const rig = marginRig();
      const source = readSourceCredentials(rig.rootDir, "acct-1");
      rig.spawnHandle.effects = [{}, {}];

      await rig.refresher.refreshNow("acct-1");

      const copy = rig.spawnHandle.invocations[0]!.credentials!;
      expect(copy.accessToken).toBe(source.accessToken);
      expect(copy.refreshToken).toBe(source.refreshToken);
      // Well inside the CLI's 5-minute window, which the source (40 minutes left) is not.
      expect(copy.expiresAt).toBeLessThanOrEqual(now + 60_000);
      expect(readSourceCredentials(rig.rootDir, "acct-1").expiresAt).toBe(inMargin);
    });

    it("puts the debug flags before the subcommand", async () => {
      const rig = marginRig();
      rig.spawnHandle.effects = [{ rotateTo: now + 8 * 60 * 60 * 1000 }];

      await rig.refresher.refreshNow("acct-1");

      const args = rig.spawnHandle.invocations[0]!.args;
      expect(args.indexOf("--debug")).toBeGreaterThanOrEqual(0);
      expect(args.indexOf("--debug")).toBeLessThan(args.indexOf("auth"));
      expect(args.indexOf("--debug-file")).toBeLessThan(args.indexOf("auth"));
    });

    it("a rejected grant blanks only the copy: revoked, source intact, no tier 2", async () => {
      const rig = marginRig();
      const sourceBefore = fs.readFileSync(accountTokenFile(rig.rootDir, "acct-1"), "utf8");
      rig.spawnHandle.effects = [{ blank: true }];

      const [result] = await rig.refresher.refreshNow("acct-1");

      expect(result!.outcome).toBe("revoked");
      expect(result!.reason).toBe("invalid_grant");
      expect(rig.spawnHandle.invocations.length).toBe(1);
      expect(fs.readFileSync(accountTokenFile(rig.rootDir, "acct-1"), "utf8")).toBe(sourceBefore);
      expect(rig.sseCalls.map((c) => c.event)).toContain("claude_account_unauthenticated");
    });

    it("does not spend a grant that it knows is dead a second time", async () => {
      const rig = marginRig();
      rig.spawnHandle.effects = [{ blank: true }];
      await rig.refresher.refreshNow("acct-1");

      const [again] = await rig.refresher.refreshNow("acct-1");
      expect(again!.outcome).toBe("revoked");
      expect(await rig.refresher.ensureFresh("acct-1")).toBe(false);
      expect(await rig.refresher.ensureFresh("acct-1", { force: true })).toBe(false);
      expect(rig.spawnHandle.invocations.length).toBe(1);
      expect(rig.sseCalls.filter((c) => c.event === "claude_account_unauthenticated").length).toBe(1);

      writeCredentials(accountRootOf(rig.rootDir, "acct-1"), { expiresAt: now + 8 * 60 * 60 * 1000 });
      const [signedIn] = await rig.refresher.refreshNow("acct-1");
      expect(signedIn!.outcome).toBe("noop");
      expect(rig.sseCalls.map((c) => c.event)).toContain("claude_account_authenticated");
      expect(await rig.refresher.ensureFresh("acct-1")).toBe(true);
    });

    it("harvests a session that spent the grant first, and does not report the account revoked", async () => {
      const rig = marginRig();
      const rotatedTo = now + 8 * 60 * 60 * 1000;
      rig.spawnHandle.effects = [{
        blank: true,
        sideEffect: () => writeSessionToken(rig.rootDir, "sess-a", { expiresAt: rotatedTo, accountId: "acct-1" }),
      }];

      const [result] = await rig.refresher.refreshNow("acct-1");

      expect(result!.outcome).toBe("harvested_session");
      expect(readSourceCredentials(rig.rootDir, "acct-1").accessToken).toBe(`sess_tok_${rotatedTo}`);
      expect(rig.sseCalls.map((c) => c.event)).not.toContain("claude_account_unauthenticated");
      expect(rig.repushCalls).toEqual([{ agentId: "claude", accountId: "acct-1" }]);
    });

    it("harvests a session rotation that is written after the probe was rejected", async () => {
      const rig = marginRig(200);
      const rotatedTo = now + 8 * 60 * 60 * 1000;
      rig.spawnHandle.effects = [{
        blank: true,
        sideEffect: () => setTimeout(
          () => writeSessionToken(rig.rootDir, "sess-a", { expiresAt: rotatedTo, accountId: "acct-1" }),
          50,
        ),
      }];

      const [result] = await rig.refresher.refreshNow("acct-1");

      expect(result!.outcome).toBe("harvested_session");
      expect(readSourceCredentials(rig.rootDir, "acct-1").accessToken).toBe(`sess_tok_${rotatedTo}`);
      expect(rig.sseCalls.map((c) => c.event)).not.toContain("claude_account_unauthenticated");
      expect(rig.spawnHandle.invocations.length).toBe(1);
    });

    it("does not report the grant revoked when the source changes after the probe was rejected", async () => {
      const rig = marginRig(200);
      rig.spawnHandle.effects = [{
        blank: true,
        // A session's rotation that its write-back watch published.
        sideEffect: () => setTimeout(
          () => writeCredentials(accountRootOf(rig.rootDir, "acct-1"), { expiresAt: now + 8 * 60 * 60 * 1000 }),
          50,
        ),
      }];

      const [result] = await rig.refresher.refreshNow("acct-1");

      expect(result!.outcome).toBe("noop");
      expect(rig.sseCalls.map((c) => c.event)).not.toContain("claude_account_unauthenticated");
      expect(rig.spawnHandle.invocations.length).toBe(1);
    });

    it("installs the rotation beside a key that another writer changed during the probe", async () => {
      const rig = marginRig();
      const rotatedTo = now + 8 * 60 * 60 * 1000;
      const sourceFile = accountTokenFile(rig.rootDir, "acct-1");
      rig.spawnHandle.effects = [{
        rotateTo: rotatedTo,
        sideEffect: () => {
          const source = JSON.parse(fs.readFileSync(sourceFile, "utf8")) as Record<string, unknown>;
          fs.writeFileSync(sourceFile, JSON.stringify({ ...source, mcpOAuth: { server: "kept" } }), "utf8");
        },
      }];

      const [result] = await rig.refresher.refreshNow("acct-1");

      expect(result!.outcome).toBe("rotated_tier1");
      expect(readSourceCredentials(rig.rootDir, "acct-1").expiresAt).toBe(rotatedTo);
      const installed = JSON.parse(fs.readFileSync(sourceFile, "utf8")) as { mcpOAuth?: unknown };
      expect(installed.mcpOAuth).toEqual({ server: "kept" });
    });

    it("installs over a source that another CLI blanked because this probe won the grant", async () => {
      const rig = marginRig();
      const rotatedTo = now + 8 * 60 * 60 * 1000;
      rig.spawnHandle.effects = [{
        rotateTo: rotatedTo,
        sideEffect: () => writeBlankedCredentials(accountRootOf(rig.rootDir, "acct-1")),
      }];

      const [result] = await rig.refresher.refreshNow("acct-1");

      expect(result!.outcome).toBe("rotated_tier1");
      expect(readSourceCredentials(rig.rootDir, "acct-1").expiresAt).toBe(rotatedTo);
      expect(rig.sseCalls.map((c) => c.event)).not.toContain("agent_auth_failed");
    });

    it("installs new tokens also when the copy's expiry cannot be read", async () => {
      const rig = marginRig();
      rig.spawnHandle.effects = [{
        sideEffect: () => fs.writeFileSync(
          path.join(rig.spawnHandle.invocations[0]!.home, ".claude", ".credentials.json"),
          JSON.stringify({ claudeAiOauth: { accessToken: "tok_rotated", refreshToken: "rfk_rotated" } }),
          "utf8",
        ),
      }];

      await rig.refresher.refreshNow("acct-1");

      expect(readSourceCredentials(rig.rootDir, "acct-1").accessToken).toBe("tok_rotated");
      expect(rig.spawnHandle.invocations.length).toBe(1);
    });

    it("keeps a source that changed while the probe ran", async () => {
      const rig = marginRig();
      const signedInUntil = now + 7 * 60 * 60 * 1000;
      let signedIn: SeenCredentials | null = null;
      rig.spawnHandle.effects = [{
        rotateTo: now + 8 * 60 * 60 * 1000,
        sideEffect: () => {
          writeCredentials(accountRootOf(rig.rootDir, "acct-1"), { expiresAt: signedInUntil });
          signedIn = readSourceCredentials(rig.rootDir, "acct-1");
        },
      }];

      await rig.refresher.refreshNow("acct-1");

      expect(readSourceCredentials(rig.rootDir, "acct-1")).toEqual(signedIn);
    });

    it("does not report a sign-in revoked because the token it replaced was rejected", async () => {
      const rig = marginRig();
      rig.spawnHandle.effects = [{
        blank: true,
        // No later than the token it replaces, so the expiry cannot show the replacement.
        sideEffect: () => writeCredentials(accountRootOf(rig.rootDir, "acct-1"), { expiresAt: inMargin }),
      }];

      const [result] = await rig.refresher.refreshNow("acct-1");

      expect(result!.outcome).toBe("noop");
      expect(rig.sseCalls.map((c) => c.event)).not.toContain("claude_account_unauthenticated");
      expect(rig.refresher._inspectForTest("acct-1").hasTimer).toBe(true);
    });

    it("keeps a rotation that it could not install, and installs it on the next tick without a spawn", async () => {
      const rig = marginRig();
      const rotatedTo = now + 8 * 60 * 60 * 1000;
      const sourceBefore = fs.readFileSync(accountTokenFile(rig.rootDir, "acct-1"), "utf8");
      rig.spawnHandle.effects = [{ rotateTo: rotatedTo }];
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      const readOnly = (): never => {
        throw Object.assign(new Error("EROFS: read-only file system"), { code: "EROFS" });
      };
      const rename = vi.spyOn(fs, "renameSync").mockImplementationOnce(readOnly);
      // The cleanup of the staging file fails for the same reason.
      const remove = vi.spyOn(fs, "rmSync").mockImplementationOnce(readOnly);

      const [failed] = await rig.refresher.refreshNow("acct-1");
      rename.mockRestore();
      remove.mockRestore();
      errors.mockRestore();

      expect(failed!.outcome).toBe("not_rotated");
      expect(fs.readFileSync(accountTokenFile(rig.rootDir, "acct-1"), "utf8")).toBe(sourceBefore);
      expect(fs.existsSync(rig.spawnHandle.invocations[0]!.home)).toBe(true);

      const [retried] = await rig.refresher.refreshNow("acct-1");

      expect(retried!.outcome).toBe("rotated_tier1");
      expect(readSourceCredentials(rig.rootDir, "acct-1").expiresAt).toBe(rotatedTo);
      expect(rig.spawnHandle.invocations.length).toBe(1);
      expect(fs.existsSync(rig.spawnHandle.invocations[0]!.home)).toBe(false);
    });

    it("after a timeout, waits for the CLI's exit before it reads the copy", async () => {
      vi.useFakeTimers();
      try {
        const rig = marginRig();
        const rotatedTo = now + 8 * 60 * 60 * 1000;
        rig.spawnHandle.effects = [{ hang: true }];

        const tick = rig.refresher.refreshNow("acct-1");
        await vi.advanceTimersByTimeAsync(30_000);
        rig.spawnHandle.children[0]!.emit("error", new Error("kill EPERM"));
        await vi.advanceTimersByTimeAsync(0);
        // Signalled, but not gone: tier 2 has not started on a copy that can still change.
        expect(rig.spawnHandle.invocations.length).toBe(1);

        writeCredentials(rig.spawnHandle.invocations[0]!.home, { expiresAt: rotatedTo });
        rig.spawnHandle.children[0]!.emit("exit", null, "SIGKILL");
        const [result] = await tick;

        expect(result!.outcome).toBe("rotated_tier1");
        expect(readSourceCredentials(rig.rootDir, "acct-1").expiresAt).toBe(rotatedTo);
        expect(rig.spawnHandle.invocations.length).toBe(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("goes on after the kill grace when the CLI never exits", async () => {
      vi.useFakeTimers();
      try {
        const rig = marginRig();
        rig.spawnHandle.effects = [{ hang: true }, {}];

        const tick = rig.refresher.refreshNow("acct-1");
        await vi.advanceTimersByTimeAsync(30_000);
        expect(rig.spawnHandle.invocations.length).toBe(1);
        await vi.advanceTimersByTimeAsync(5_000);
        expect(rig.spawnHandle.invocations.length).toBe(2);
        await vi.advanceTimersByTimeAsync(1);
        const [result] = await tick;

        expect(result!.outcome).toBe("not_rotated");
      } finally {
        vi.useRealTimers();
      }
    });

    it("keeps a rotation while the source cannot be read, and does not end the account for it", async () => {
      const rig = marginRig();
      const rotatedTo = now + 8 * 60 * 60 * 1000;
      const sourceFile = accountTokenFile(rig.rootDir, "acct-1");
      const sourceBefore = fs.readFileSync(sourceFile, "utf8");
      // Another writer is part-way through the file when the probe ends.
      rig.spawnHandle.effects = [{ rotateTo: rotatedTo, sideEffect: () => fs.writeFileSync(sourceFile, "{", "utf8") }];

      await rig.refresher.refreshNow("acct-1");
      const [stillUnreadable] = await rig.refresher.refreshNow("acct-1");

      expect(stillUnreadable!.outcome).toBe("unknown_failure");
      expect(rig.sseCalls.map((c) => c.event)).not.toContain("agent_auth_failed");
      expect(rig.refresher._inspectForTest("acct-1").hasTimer).toBe(true);
      expect(fs.existsSync(rig.spawnHandle.invocations[0]!.home)).toBe(true);

      fs.writeFileSync(sourceFile, sourceBefore, "utf8");
      const [installed] = await rig.refresher.refreshNow("acct-1");

      expect(installed!.outcome).toBe("rotated_tier1");
      expect(readSourceCredentials(rig.rootDir, "acct-1").expiresAt).toBe(rotatedTo);
      expect(rig.spawnHandle.invocations.length).toBe(1);
    });

    it("keeps a copy that it cannot read after a probe, and judges it again before any new spawn", async () => {
      const rig = marginRig();
      const rotatedTo = now + 8 * 60 * 60 * 1000;
      const copyFile = (): string => path.join(rig.spawnHandle.invocations[0]!.home, ".claude", ".credentials.json");
      rig.spawnHandle.effects = [{ sideEffect: () => fs.writeFileSync(copyFile(), "{", "utf8") }];

      const [unreadable] = await rig.refresher.refreshNow("acct-1");

      expect(unreadable!.outcome).toBe("not_rotated");
      expect(rig.spawnHandle.invocations.length).toBe(1);
      expect(fs.existsSync(copyFile())).toBe(true);

      writeCredentials(rig.spawnHandle.invocations[0]!.home, { expiresAt: rotatedTo });
      const [installed] = await rig.refresher.refreshNow("acct-1");

      expect(installed!.outcome).toBe("rotated_tier1");
      expect(readSourceCredentials(rig.rootDir, "acct-1").expiresAt).toBe(rotatedTo);
      expect(rig.spawnHandle.invocations.length).toBe(1);
    });

    it("reports the grant revoked when a kept copy turns out to be blanked, without a new spawn", async () => {
      const rig = marginRig();
      const home = (): string => rig.spawnHandle.invocations[0]!.home;
      rig.spawnHandle.effects = [{
        sideEffect: () => fs.writeFileSync(path.join(home(), ".claude", ".credentials.json"), "{", "utf8"),
      }];
      await rig.refresher.refreshNow("acct-1");

      writeBlankedCredentials(home());
      const [result] = await rig.refresher.refreshNow("acct-1");

      expect(result!.outcome).toBe("revoked");
      expect(rig.spawnHandle.invocations.length).toBe(1);
      expect(rig.sseCalls.map((c) => c.event)).toContain("claude_account_unauthenticated");
    });

    it("releases a kept rotation that it cannot read when a sign-in replaces the source", async () => {
      const rig = marginRig();
      rig.spawnHandle.effects = [{ rotateTo: now + 8 * 60 * 60 * 1000 }];
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      const rename = vi.spyOn(fs, "renameSync").mockImplementationOnce(() => {
        throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
      });
      await rig.refresher.refreshNow("acct-1");
      rename.mockRestore();
      errors.mockRestore();
      const keptHome = rig.spawnHandle.invocations[0]!.home;
      expect(fs.existsSync(keptHome)).toBe(true);

      fs.writeFileSync(path.join(keptHome, ".claude", ".credentials.json"), "{", "utf8");
      writeCredentials(accountRootOf(rig.rootDir, "acct-1"), { expiresAt: now + 8 * 60 * 60 * 1000 });
      const [afterSignIn] = await rig.refresher.refreshNow("acct-1");

      expect(afterSignIn!.outcome).toBe("noop");
      expect(fs.existsSync(keptHome)).toBe(false);
    });

    it("remembers a rejected grant also when the credential has no access token", async () => {
      const rig = marginRig();
      fs.writeFileSync(
        accountTokenFile(rig.rootDir, "acct-1"),
        JSON.stringify({ claudeAiOauth: { accessToken: "", refreshToken: "rfk_only", expiresAt: inMargin } }),
        "utf8",
      );
      rig.spawnHandle.effects = [{ blank: true }];

      const [first] = await rig.refresher.refreshNow("acct-1");
      const [second] = await rig.refresher.refreshNow("acct-1");

      expect(first!.outcome).toBe("revoked");
      expect(second!.outcome).toBe("revoked");
      expect(await rig.refresher.ensureFresh("acct-1")).toBe(false);
      expect(rig.spawnHandle.invocations.length).toBe(1);
    });
  });

  describe("private run (session naming)", () => {
    const now = 1_700_000_000_000;
    const inMargin = now + 40 * 60 * 1000;
    const rotatedTo = now + 8 * 60 * 60 * 1000;

    function marginRig(lateRotationWaitMs?: number): TestRig {
      const rig = buildRig({
        accounts: [makeAccount("acct-1")],
        initialExpiries: { "acct-1": inMargin },
        initialNow: now,
        lateRotationWaitMs,
      });
      rigs.push(rig);
      return rig;
    }

    function readCopy(home: string): SeenCredentials {
      const raw = fs.readFileSync(path.join(home, ".claude", ".credentials.json"), "utf8");
      return (JSON.parse(raw) as { claudeAiOauth: SeenCredentials }).claudeAiOauth;
    }

    function events(rig: TestRig): string[] {
      return rig.sseCalls.map((c) => c.event);
    }

    it("runs in a copy with the source's tokens and real expiry, and removes it", async () => {
      const rig = marginRig();
      const sourceBefore = fs.readFileSync(accountTokenFile(rig.rootDir, "acct-1"), "utf8");
      let seenHome = "";
      let seen: SeenCredentials | null = null;

      const value = await rig.refresher.runInPrivateCopy("acct-1", async (home) => {
        seenHome = home;
        seen = readCopy(home);
        return "named";
      });

      expect(value).toBe("named");
      expect(seenHome).not.toBe(accountRootOf(rig.rootDir, "acct-1"));
      expect(seen).toEqual(readSourceCredentials(rig.rootDir, "acct-1"));
      expect(fs.existsSync(seenHome)).toBe(false);
      expect(fs.readFileSync(accountTokenFile(rig.rootDir, "acct-1"), "utf8")).toBe(sourceBefore);
    });

    it("installs a rotation that the run made, keeps the source's other keys, and pushes it", async () => {
      const rig = marginRig();
      const sourceFile = accountTokenFile(rig.rootDir, "acct-1");
      const logs = captureLogs();

      await rig.refresher.runInPrivateCopy("acct-1", async (home) => {
        writeCredentials(home, { expiresAt: rotatedTo });
        const source = JSON.parse(fs.readFileSync(sourceFile, "utf8")) as Record<string, unknown>;
        fs.writeFileSync(sourceFile, JSON.stringify({ ...source, mcpOAuth: { server: "kept" } }), "utf8");
      });
      logs.restore();

      expect(readSourceCredentials(rig.rootDir, "acct-1").expiresAt).toBe(rotatedTo);
      expect((JSON.parse(fs.readFileSync(sourceFile, "utf8")) as { mcpOAuth?: unknown }).mcpOAuth)
        .toEqual({ server: "kept" });
      expect(rig.repushCalls).toEqual([{ agentId: "claude", accountId: "acct-1" }]);
      expect(logs.lines.some((line) => line.includes("rotated_private_run"))).toBe(true);
    });

    it("reports a copy that the run blanked as a rejected grant, which no tick spends again", async () => {
      const rig = marginRig();
      const sourceBefore = fs.readFileSync(accountTokenFile(rig.rootDir, "acct-1"), "utf8");

      await rig.refresher.runInPrivateCopy("acct-1", async (home) => writeBlankedCredentials(home));

      expect(events(rig)).toContain("claude_account_unauthenticated");
      expect(fs.readFileSync(accountTokenFile(rig.rootDir, "acct-1"), "utf8")).toBe(sourceBefore);
      const [tick] = await rig.refresher.refreshNow("acct-1");
      expect(tick!.outcome).toBe("revoked");
      expect(await rig.refresher.ensureFresh("acct-1")).toBe(false);
      expect(rig.spawnHandle.invocations.length).toBe(0);
    });

    it("does not judge a blanked copy while another run, which can hold the new grant, is open", async () => {
      const rig = marginRig();
      let finishWinner = (): void => {};
      const winnerGate = new Promise<void>((resolve) => { finishWinner = resolve; });
      const winner = rig.refresher.runInPrivateCopy("acct-1", async (home) => {
        await winnerGate;
        writeCredentials(home, { expiresAt: rotatedTo });
      });

      await rig.refresher.runInPrivateCopy("acct-1", async (home) => writeBlankedCredentials(home));
      finishWinner();
      await winner;

      expect(readSourceCredentials(rig.rootDir, "acct-1").expiresAt).toBe(rotatedTo);
      expect(events(rig)).not.toContain("claude_account_unauthenticated");
    });

    it("does not report a sign-in revoked because the run's copy of the old token was rejected", async () => {
      const rig = marginRig();

      await rig.refresher.runInPrivateCopy("acct-1", async (home) => {
        writeBlankedCredentials(home);
        writeCredentials(accountRootOf(rig.rootDir, "acct-1"), { expiresAt: inMargin });
      });

      expect(events(rig)).not.toContain("claude_account_unauthenticated");
      expect(await rig.refresher.ensureFresh("acct-1")).toBe(true);
    });

    it("does not report a rejection while a kept rotation holds the grant's successor", async () => {
      const rig = marginRig();
      rig.spawnHandle.effects = [{ rotateTo: rotatedTo }];
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      const rename = vi.spyOn(fs, "renameSync").mockImplementationOnce(() => {
        throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
      });
      await rig.refresher.refreshNow("acct-1");
      rename.mockRestore();
      errors.mockRestore();

      await rig.refresher.runInPrivateCopy("acct-1", async (home) => writeBlankedCredentials(home));

      expect(events(rig)).not.toContain("claude_account_unauthenticated");
      const [installed] = await rig.refresher.refreshNow("acct-1");
      expect(installed!.outcome).toBe("rotated_tier1");
      expect(readSourceCredentials(rig.rootDir, "acct-1").expiresAt).toBe(rotatedTo);
    });

    it("harvests a session that spent the grant first, and does not report the account revoked", async () => {
      const rig = marginRig();

      await rig.refresher.runInPrivateCopy("acct-1", async (home) => {
        writeBlankedCredentials(home);
        writeSessionToken(rig.rootDir, "sess-a", { expiresAt: rotatedTo, accountId: "acct-1" });
      });

      expect(readSourceCredentials(rig.rootDir, "acct-1").accessToken).toBe(`sess_tok_${rotatedTo}`);
      expect(events(rig)).not.toContain("claude_account_unauthenticated");
    });

    it("harvests a session rotation that is written after the run's grant was rejected", async () => {
      const rig = marginRig(200);

      await rig.refresher.runInPrivateCopy("acct-1", async (home) => {
        writeBlankedCredentials(home);
        setTimeout(() => writeSessionToken(rig.rootDir, "sess-a", { expiresAt: rotatedTo, accountId: "acct-1" }), 50);
      });

      expect(readSourceCredentials(rig.rootDir, "acct-1").accessToken).toBe(`sess_tok_${rotatedTo}`);
      expect(events(rig)).not.toContain("claude_account_unauthenticated");
    });

    it("does not report the grant revoked when the source changes after the run's grant was rejected", async () => {
      const rig = marginRig(200);

      await rig.refresher.runInPrivateCopy("acct-1", async (home) => {
        writeBlankedCredentials(home);
        setTimeout(() => writeCredentials(accountRootOf(rig.rootDir, "acct-1"), { expiresAt: rotatedTo }), 50);
      });

      expect(events(rig)).not.toContain("claude_account_unauthenticated");
      expect(await rig.refresher.ensureFresh("acct-1")).toBe(true);
    });

    it("judges a rejection of a signed-in token although a rotation of the old one is kept", async () => {
      const rig = marginRig();
      rig.spawnHandle.effects = [{ rotateTo: rotatedTo }];
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      const rename = vi.spyOn(fs, "renameSync").mockImplementationOnce(() => {
        throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
      });
      await rig.refresher.refreshNow("acct-1");
      rename.mockRestore();
      errors.mockRestore();
      writeCredentials(accountRootOf(rig.rootDir, "acct-1"), { expiresAt: inMargin });

      await rig.refresher.runInPrivateCopy("acct-1", async (home) => writeBlankedCredentials(home));

      expect(events(rig)).toContain("claude_account_unauthenticated");
      const [tick] = await rig.refresher.refreshNow("acct-1");
      expect(tick!.outcome).toBe("revoked");
      expect(rig.spawnHandle.invocations.length).toBe(1);
    });

    it("judges a rejection when two runs end together", async () => {
      const rig = marginRig();
      let finishBoth = (): void => {};
      const gate = new Promise<void>((resolve) => { finishBoth = resolve; });
      const runs = [1, 2].map(() => rig.refresher.runInPrivateCopy("acct-1", async (home) => {
        await gate;
        writeBlankedCredentials(home);
      }));

      finishBoth();
      await Promise.all(runs);

      expect(events(rig)).toContain("claude_account_unauthenticated");
      expect(await rig.refresher.ensureFresh("acct-1")).toBe(false);
    });

    it("judges a rejection of a new token while a run waits on the rejection of the old one", async () => {
      const rig = marginRig(200);
      const waiting = rig.refresher.runInPrivateCopy("acct-1", async (home) => writeBlankedCredentials(home));
      await new Promise((resolve) => setTimeout(resolve, 20));
      // A sign-in, whose token the next run's grant is also rejected for.
      writeCredentials(accountRootOf(rig.rootDir, "acct-1"), { expiresAt: inMargin });

      await rig.refresher.runInPrivateCopy("acct-1", async (home) => writeBlankedCredentials(home));
      await waiting;

      expect(events(rig)).toContain("claude_account_unauthenticated");
      expect(await rig.refresher.ensureFresh("acct-1")).toBe(false);
    });

    it("does not make a run that installed a rotation wait on a rejection that it answers", async () => {
      vi.useFakeTimers();
      try {
        const rig = marginRig(5_000);
        let finishWinner = (): void => {};
        const winnerGate = new Promise<void>((resolve) => { finishWinner = resolve; });
        const winner = rig.refresher.runInPrivateCopy("acct-1", async (home) => {
          await winnerGate;
          writeCredentials(home, { expiresAt: rotatedTo });
          return "named";
        });
        await rig.refresher.runInPrivateCopy("acct-1", async (home) => writeBlankedCredentials(home));

        finishWinner();
        let returned = false;
        const watched = (async () => {
          await winner;
          returned = true;
        })();
        await vi.advanceTimersByTimeAsync(0);

        expect(returned).toBe(true);
        await watched;
        expect(readSourceCredentials(rig.rootDir, "acct-1").expiresAt).toBe(rotatedTo);
        expect(events(rig)).not.toContain("claude_account_unauthenticated");
      } finally {
        vi.useRealTimers();
      }
    });

    it("keeps a rotation that it could not install, and the next tick installs it without a spawn", async () => {
      const rig = marginRig();
      let home = "";
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      const rename = vi.spyOn(fs, "renameSync").mockImplementationOnce(() => {
        throw Object.assign(new Error("EROFS: read-only file system"), { code: "EROFS" });
      });

      await rig.refresher.runInPrivateCopy("acct-1", async (copyHome) => {
        home = copyHome;
        writeCredentials(copyHome, { expiresAt: rotatedTo });
      });
      rename.mockRestore();
      errors.mockRestore();

      expect(readSourceCredentials(rig.rootDir, "acct-1").expiresAt).toBe(inMargin);
      expect(fs.existsSync(home)).toBe(true);
      const [tick] = await rig.refresher.refreshNow("acct-1");
      expect(tick!.outcome).toBe("rotated_tier1");
      expect(readSourceCredentials(rig.rootDir, "acct-1").expiresAt).toBe(rotatedTo);
      expect(rig.spawnHandle.invocations.length).toBe(0);
      expect(fs.existsSync(home)).toBe(false);
    });

    it("a tick waits for an open run before it probes", async () => {
      const rig = marginRig();
      rig.spawnHandle.effects = [{}, {}];
      let finishRun = (): void => {};
      const gate = new Promise<void>((resolve) => { finishRun = resolve; });
      const run = rig.refresher.runInPrivateCopy("acct-1", async (home) => {
        await gate;
        writeCredentials(home, { expiresAt: rotatedTo });
      });

      const tick = rig.refresher.refreshNow("acct-1");
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(rig.spawnHandle.invocations.length).toBe(0);
      finishRun();
      await run;
      const [result] = await tick;

      expect(result!.outcome).toBe("noop");
      expect(rig.spawnHandle.invocations.length).toBe(0);
      expect(readSourceCredentials(rig.rootDir, "acct-1").expiresAt).toBe(rotatedTo);
    });

    it("a tick stops waiting for a run that hangs, and does not probe past it", async () => {
      vi.useFakeTimers();
      try {
        const rig = marginRig();
        rig.spawnHandle.effects = [{ blank: true }];
        let finishRun = (): void => {};
        const gate = new Promise<void>((resolve) => { finishRun = resolve; });
        // The run has spent the grant and holds its successor, but has not ended.
        const run = rig.refresher.runInPrivateCopy("acct-1", async (home) => {
          writeCredentials(home, { expiresAt: rotatedTo });
          await gate;
        });

        const tick = rig.refresher.refreshNow("acct-1");
        await vi.advanceTimersByTimeAsync(30_000);
        await vi.advanceTimersByTimeAsync(10);
        const [result] = await tick;

        expect(result!.outcome).toBe("not_rotated");
        expect(rig.spawnHandle.invocations.length).toBe(0);
        expect(events(rig)).not.toContain("claude_account_unauthenticated");
        finishRun();
        await run;
        expect(readSourceCredentials(rig.rootDir, "acct-1").expiresAt).toBe(rotatedTo);
      } finally {
        vi.useRealTimers();
      }
    });

    it("judges a rejection when the last open run ends without a rotation", async () => {
      const rig = marginRig();
      let finishOther = (): void => {};
      const otherGate = new Promise<void>((resolve) => { finishOther = resolve; });
      const other = rig.refresher.runInPrivateCopy("acct-1", async () => {
        await otherGate;
      });

      await rig.refresher.runInPrivateCopy("acct-1", async (home) => writeBlankedCredentials(home));
      expect(events(rig)).not.toContain("claude_account_unauthenticated");
      finishOther();
      await other;

      expect(events(rig)).toContain("claude_account_unauthenticated");
      expect(await rig.refresher.ensureFresh("acct-1")).toBe(false);
    });

    it("keeps a newer rotation that it could not install in place of one kept for a replaced token", async () => {
      const rig = marginRig();
      rig.spawnHandle.effects = [{ rotateTo: rotatedTo }];
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      const failRename = (): void => {
        vi.spyOn(fs, "renameSync").mockImplementationOnce(() => {
          throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
        });
      };
      failRename();
      await rig.refresher.refreshNow("acct-1");
      const olderHome = rig.spawnHandle.invocations[0]!.home;
      // A sign-in replaces the token that the kept rotation came from.
      writeCredentials(accountRootOf(rig.rootDir, "acct-1"), { expiresAt: inMargin });
      let newer: SeenCredentials | null = null;
      failRename();

      await rig.refresher.runInPrivateCopy("acct-1", async (home) => {
        writeCredentials(home, { expiresAt: rotatedTo + 1 });
        newer = readCopy(home);
      });
      vi.mocked(fs.renameSync).mockRestore();
      errors.mockRestore();

      expect(fs.existsSync(olderHome)).toBe(false);
      const [tick] = await rig.refresher.refreshNow("acct-1");
      expect(tick!.outcome).toBe("rotated_tier1");
      expect(readSourceCredentials(rig.rootDir, "acct-1")).toEqual(newer);
    });

    it("keeps a kept rotation when a later copy of the same credential cannot be read", async () => {
      const rig = marginRig();
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      vi.spyOn(fs, "renameSync").mockImplementationOnce(() => {
        throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
      });
      let successor: SeenCredentials | null = null;
      await rig.refresher.runInPrivateCopy("acct-1", async (home) => {
        writeCredentials(home, { expiresAt: rotatedTo });
        successor = readCopy(home);
      });
      vi.mocked(fs.renameSync).mockRestore();
      let unreadableHome = "";

      await rig.refresher.runInPrivateCopy("acct-1", async (home) => {
        unreadableHome = home;
        fs.writeFileSync(path.join(home, ".claude", ".credentials.json"), "{", "utf8");
      });
      errors.mockRestore();

      const [tick] = await rig.refresher.refreshNow("acct-1");
      expect(tick!.outcome).toBe("rotated_tier1");
      expect(readSourceCredentials(rig.rootDir, "acct-1")).toEqual(successor);
      fs.rmSync(unreadableHome, { recursive: true, force: true });
    });

    it("keeps a newer kept rotation when an earlier run ends while the source cannot be read", async () => {
      const rig = marginRig();
      const sourceFile = accountTokenFile(rig.rootDir, "acct-1");
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      let finishEarlier = (): void => {};
      const earlierGate = new Promise<void>((resolve) => { finishEarlier = resolve; });
      let earlierHome = "";
      const earlier = rig.refresher.runInPrivateCopy("acct-1", async (home) => {
        earlierHome = home;
        await earlierGate;
        writeCredentials(home, { expiresAt: rotatedTo });
        fs.writeFileSync(sourceFile, "{", "utf8");
      });
      // A sign-in replaces the token that the earlier run copied.
      writeCredentials(accountRootOf(rig.rootDir, "acct-1"), { expiresAt: inMargin });
      const signedIn = fs.readFileSync(sourceFile, "utf8");
      vi.spyOn(fs, "renameSync").mockImplementationOnce(() => {
        throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
      });
      let successor: SeenCredentials | null = null;
      await rig.refresher.runInPrivateCopy("acct-1", async (home) => {
        writeCredentials(home, { expiresAt: rotatedTo + 1 });
        successor = readCopy(home);
      });
      vi.mocked(fs.renameSync).mockRestore();

      finishEarlier();
      await earlier;
      errors.mockRestore();
      fs.writeFileSync(sourceFile, signedIn, "utf8");

      const [tick] = await rig.refresher.refreshNow("acct-1");
      expect(tick!.outcome).toBe("rotated_tier1");
      expect(readSourceCredentials(rig.rootDir, "acct-1")).toEqual(successor);
      fs.rmSync(earlierHome, { recursive: true, force: true });
    });

    it("does not let a rejection of a replaced token hide one of the token that replaced it", async () => {
      const rig = marginRig();
      let finishOld = (): void => {};
      const oldGate = new Promise<void>((resolve) => { finishOld = resolve; });
      const oldRun = rig.refresher.runInPrivateCopy("acct-1", async (home) => {
        await oldGate;
        writeBlankedCredentials(home);
      });
      await rig.refresher.runInPrivateCopy("acct-1", async (home) => writeCredentials(home, { expiresAt: rotatedTo }));

      await rig.refresher.runInPrivateCopy("acct-1", async (home) => writeBlankedCredentials(home));
      finishOld();
      await oldRun;

      expect(events(rig)).toContain("claude_account_unauthenticated");
      expect(await rig.refresher.ensureFresh("acct-1")).toBe(false);
    });

    it("waits for a tick in flight before it copies the source", async () => {
      const rig = marginRig();
      rig.spawnHandle.effects = [{ rotateTo: rotatedTo, delayMs: 20 }];
      let seen: SeenCredentials | null = null;

      const tick = rig.refresher.refreshNow("acct-1");
      await rig.refresher.runInPrivateCopy("acct-1", async (home) => {
        seen = readCopy(home);
      });
      await tick;

      expect(seen!.expiresAt).toBe(rotatedTo);
    });

    it("refuses to run when the source cannot be read, and does not quote it", async () => {
      const rig = marginRig();
      // JSON.parse quotes a short input like this one in its error message.
      fs.writeFileSync(accountTokenFile(rig.rootDir, "acct-1"), "tok_secret_part", "utf8");
      const run = vi.fn(async () => "named");

      const attempt = rig.refresher.runInPrivateCopy("acct-1", run);

      await expect(attempt).rejects.toThrow("could not be copied");
      await attempt.catch((err: unknown) => expect(String(err)).not.toContain("tok_secret_part"));
      expect(run).not.toHaveBeenCalled();
    });
  });

  describe("retry schedule", () => {
    const now = 1_700_000_000_000;

    // The last chance is 7 minutes before expiry, sooner than the backoff in each row.
    it.each([
      { failure: "rate-limited", stderr: "HTTP 429 rate_limit_error", ticks: 1, expiresInMin: 8.5, clamped: 90_000, backoff: 120_000 },
      { failure: "unclassified", stderr: "", ticks: 2, expiresInMin: 9.5, clamped: 150_000, backoff: 300_000 },
    ])("clamps the backoff to the last chance before the sessions refresh after $failure failures", async (row) => {
      const rig = buildRig({
        accounts: [makeAccount("acct-1")],
        initialExpiries: { "acct-1": now + row.expiresInMin * 60 * 1000 },
        initialNow: now,
      });
      rigs.push(rig);
      rig.spawnHandle.effects = Array.from({ length: row.ticks * 2 }, () => ({ stderr: row.stderr }));
      const timeouts = vi.spyOn(globalThis, "setTimeout");

      for (let tick = 0; tick < row.ticks; tick++) await rig.refresher.refreshNow("acct-1");
      const delays = timeouts.mock.calls.map((call) => call[1]);
      timeouts.mockRestore();

      expect(rig.refresher._inspectForTest("acct-1").failureCount).toBe(row.ticks);
      expect(delays).toContain(row.clamped);
      expect(delays).not.toContain(row.backoff);
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
        initialExpiries: { "acct-1": now - 60 * 1000 },
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

    it("reports a valid token that was not rotated as not_rotated, with the time left", async () => {
      const now = 1_700_000_000_000;
      const rig = buildRig({
        accounts: [makeAccount("acct-1")],
        initialExpiries: { "acct-1": now + 40 * 60 * 1000 },
        initialNow: now,
      });
      rigs.push(rig);
      rig.spawnHandle.effects = [{}, { stderr: "Error: token refresh did not complete" }];

      const logs = captureLogs();
      const [result] = await rig.refresher.refreshNow("acct-1");
      logs.restore();

      expect(result!.outcome).toBe("not_rotated");
      expect(result!.reason).toContain("token refresh did not complete");
      const line = logs.lines.find((entry) => entry.includes("not_rotated failure_count=1"));
      expect(line).toBeDefined();
      expect(line).toContain("expires_in=40m — token still valid, retry scheduled reason=\"");
      expect(logs.lines.some((entry) => entry.includes("unknown_failure"))).toBe(false);
      expect(rig.refresher._inspectForTest("acct-1").hasTimer).toBe(true);
    });

    it("names a CLI that cannot start", async () => {
      const now = 1_700_000_000_000;
      const rig = buildRig({
        accounts: [makeAccount("acct-1")],
        initialExpiries: { "acct-1": now + 40 * 60 * 1000 },
        initialNow: now,
      });
      rigs.push(rig);
      rig.spawnHandle.effects = [{ failsToStart: true }, { failsToStart: true }];

      const logs = captureLogs();
      const [result] = await rig.refresher.refreshNow("acct-1");
      logs.restore();

      expect(result!.outcome).toBe("not_rotated");
      expect(result!.reason).toBe("[error] spawn claude ENOENT | [error] spawn claude ENOENT");
      expect(logs.lines.find((entry) => entry.includes("not_rotated failure_count=1")))
        .toContain("reason=\"[error] spawn claude ENOENT");
      expect(rig.sseCalls).toEqual([]);
    });

    it("names what stopped the private copy", async () => {
      const now = 1_700_000_000_000;
      const rig = buildRig({
        accounts: [makeAccount("acct-1")],
        initialExpiries: { "acct-1": now + 40 * 60 * 1000 },
        initialNow: now,
      });
      rigs.push(rig);
      vi.stubEnv("TMPDIR", path.join(rig.rootDir, "no-such-directory"));

      let result: Awaited<ReturnType<typeof rig.refresher.refreshNow>>[number];
      try {
        [result] = await rig.refresher.refreshNow("acct-1");
      } finally {
        vi.unstubAllEnvs();
      }

      expect(result!.outcome).toBe("not_rotated");
      expect(result!.reason).toBe("[probe-home-failed] ENOENT");
      expect(rig.spawnHandle.invocations.length).toBe(0);
    });

    it("keeps tier 1's stdout, which names the account, out of the reason", async () => {
      const now = 1_700_000_000_000;
      const rig = buildRig({
        accounts: [makeAccount("acct-1")],
        initialExpiries: { "acct-1": now - 60 * 1000 },
        initialNow: now,
      });
      rigs.push(rig);
      rig.spawnHandle.effects = [
        { stdout: '{\n  "loggedIn": true,\n  "email": "person@example.com",\n  "orgName": "Example Org"\n}' },
        {},
      ];

      const logs = captureLogs();
      const [result] = await rig.refresher.refreshNow("acct-1");
      logs.restore();

      expect(result!.outcome).toBe("unknown_failure");
      expect(result!.reason).not.toContain("example");
      expect(logs.lines.join("\n")).not.toContain("example");
    });

    it("does not read a debug timestamp's milliseconds as an HTTP 429", async () => {
      const now = 1_700_000_000_000;
      const rig = buildRig({
        accounts: [makeAccount("acct-1")],
        initialExpiries: { "acct-1": now - 60 * 1000 },
        initialNow: now,
      });
      rigs.push(rig);
      rig.spawnHandle.effects = [
        {},
        { debugLog: "2026-10-11T07:55:36.429Z [DEBUG] Cleared proxy agent cache\n" },
      ];

      const [result] = await rig.refresher.refreshNow("acct-1");

      expect(result!.outcome).toBe("unknown_failure");
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

  it("picks the line that explains the failure out of the CLI's debug noise", () => {
    const summary = summarizeRefreshFailure([
      "[ERROR] OAuth refresh failed (expected): Request failed with status code 400",
      "[ERROR] Failed to save config with lock: Error: ENOENT: no such file or directory, lstat '/x/.claude.json'",
      "[DEBUG] Failed to stat directory /etc/claude-code/.claude/output-styles: ENOENT: no such file or directory",
      "[DEBUG] Error log sink initialized",
    ].join("\n"));
    expect(summary).toBe("[ERROR] OAuth refresh failed (expected): Request failed with status code 400");
  });

  it("keeps a refresher's own note that says ENOENT, and still drops the CLI's lines that do", () => {
    const summary = summarizeRefreshFailure([
      "[ERROR] Failed to save config with lock: Error: ENOENT: no such file or directory, lstat '/x/.claude.json'",
      "[DEBUG] Failed to stat directory /etc/claude-code/.claude/output-styles: ENOENT: no such file or directory",
      "[error] spawn claude ENOENT",
    ].join("\n"));
    expect(summary).toBe("[error] spawn claude ENOENT");
    expect(summarizeRefreshFailure("[probe-home-failed] ENOENT")).toBe("[probe-home-failed] ENOENT");
  });

  it("redacts a kept note as it does every other line", () => {
    const summary = summarizeRefreshFailure(
      `[error] spawn claude ENOENT {"accessToken":"abc123"} Bearer ${FAKE_OAUTH_TOKEN}`,
    );
    expect(summary).toContain("[error] spawn claude ENOENT");
    expect(summary).not.toContain("abc123");
    expect(summary).not.toContain(FAKE_OAUTH_TOKEN);
  });

  it("reads a note only from a lower-case tag and a space at the start of a line", () => {
    const missingFile = "ENOENT: no such file or directory, open '/x/settings.json'";
    expect(summarizeRefreshFailure(`[ERROR] Error: ${missingFile}`)).toBe("no CLI output");
    expect(summarizeRefreshFailure(`Unhandled in the [error] handler: ${missingFile}`)).toBe("no CLI output");
    expect(summarizeRefreshFailure(`[stdin]:1 Error: ${missingFile}`)).toBe("no CLI output");
  });

  it("gives each of the three lines a share, so a long line cannot hide the last one", () => {
    // Short words: one long run of letters is redacted as a possible token.
    const filler = "ab ".repeat(70);
    const summary = summarizeRefreshFailure([
      `Error: first ${filler}`,
      `Error: second ${filler}`,
      `Error: third ${filler}`,
    ].join("\n"));
    expect(summary).toContain("Error: first");
    expect(summary).toContain("Error: second");
    expect(summary).toContain("Error: third");
    expect(summary.length).toBeLessThanOrEqual(300);
  });

  it("caps the excerpt so one runaway line cannot flood the log", () => {
    expect(summarizeRefreshFailure(`Error: ${"x".repeat(5_000)}`).length).toBeLessThanOrEqual(300);
  });
});
