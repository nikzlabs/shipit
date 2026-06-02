/**
 * Unit tests for ClaudeOAuthRefresher (docs/153).
 *
 * Strategy: stand the refresher up on a temp credentials root, inject a fake
 * spawn that we can drive deterministically. Each spawn invocation has a chance
 * to (a) write a fresh credentials file to disk, simulating CLI-driven OAuth
 * rotation, (b) write content to the debug-file arg, simulating the
 * `--debug api` log capture, and (c) emit stdout/stderr text. We assert on
 * RefreshResult outcomes, observable file mutations, repush callback invocations,
 * SSE broadcasts, and scheduling state via `_inspectForTest`.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";

import { ClaudeOAuthRefresher } from "./oauth-refresher.js";
import type { ClaudeOAuthRefresherDeps, RefreshResult } from "./oauth-refresher.js";
import type { ProviderAccountManager } from "../../provider-account-manager.js";
import type { ProviderAccount, AgentId } from "../../../shared/types.js";

// ---- helpers ----

function makeAccount(id: string, overrides: Partial<ProviderAccount> = {}): ProviderAccount {
  return {
    id,
    provider: "claude" as AgentId,
    label: id,
    isPrimary: true,
    status: "ready",
    plan: "max-5x",
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function makeProviderAccountManager(opts: {
  rootDir: string;
  accounts: ProviderAccount[];
}): ProviderAccountManager {
  return {
    list: (provider?: AgentId): ProviderAccount[] => {
      if (provider && provider !== "claude") return [];
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

interface SpawnEffect {
  /** If set, write a new credentials file with this expiresAt before exit. */
  rotateTo?: number;
  /** Content to write to the `--debug-file` arg, if any. */
  debugLog?: string;
  /** Content to push to stderr. */
  stderr?: string;
  /** Content to push to stdout. */
  stdout?: string;
  /** Exit code. Defaults to 0. */
  exitCode?: number;
  /** Delay (ms) before exit. Defaults to 0 (sync). */
  delayMs?: number;
}

interface FakeSpawnHandle {
  invocations: { args: string[]; accountRoot: string }[];
  /** Queue of per-invocation effects. Index N applies to invocation N. */
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
      // Fire on next macrotask so the caller sees the unresolved promise
      // first (important for single-flight tests).
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
  accounts: ProviderAccount[];
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

// ---- tests ----

describe("ClaudeOAuthRefresher", () => {
  let rigs: TestRig[] = [];
  afterEach(() => {
    for (const rig of rigs) cleanupRig(rig);
    rigs = [];
  });

  it("noop when token is healthy and tier1 doesn't rotate", async () => {
    const now = 1_700_000_000_000;
    const future = now + 8 * 60 * 60 * 1000; // 8h out
    const rig = buildRig({
      accounts: [makeAccount("claude-default")],
      initialExpiries: { "claude-default": future },
      initialNow: now,
    });
    rigs.push(rig);
    rig.spawnHandle.effects = [{ /* no rotation, no debug log */ }];

    const [result] = await rig.refresher.refreshNow("claude-default");
    expect(result!.outcome).toBe("noop");
    expect(rig.spawnHandle.invocations.length).toBe(1); // tier1 only
    expect(rig.spawnHandle.invocations[0]!.args).toContain("status");
    expect(rig.repushCalls.length).toBe(0);
    // Failure counter not incremented on noop.
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
    expect(rig.spawnHandle.invocations.length).toBe(1); // tier2 not invoked
    expect(rig.repushCalls).toEqual([{ agentId: "claude", accountId: "claude-default" }]);
  });

  it("falls through to tier2 when tier1 doesn't rotate and token is near expiry", async () => {
    const now = 1_700_000_000_000;
    const nearExpiry = now + 10 * 60 * 1000; // 10m out, less than 30m margin
    const rotatedTo = now + 8 * 60 * 60 * 1000;
    const rig = buildRig({
      accounts: [makeAccount("claude-default")],
      initialExpiries: { "claude-default": nearExpiry },
      initialNow: now,
    });
    rigs.push(rig);
    rig.spawnHandle.effects = [
      { /* tier1 noop */ },
      { rotateTo: rotatedTo }, // tier2 rotates
    ];

    const [result] = await rig.refresher.refreshNow("claude-default");
    expect(result!.outcome).toBe("rotated_tier2");
    expect(rig.spawnHandle.invocations.length).toBe(2);
    // Tier2 args must include `--print`, `--model`, `--no-session-persistence`.
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
      { stderr: "HTTP 429 rate_limit_error" }, // tier1
      { stderr: "HTTP 429 rate_limit_error" }, // tier2
    ];

    const [result] = await rig.refresher.refreshNow("claude-default");
    expect(result!.outcome).toBe("rate_limited");
    expect(rig.repushCalls.length).toBe(0);
    expect(rig.refresher._inspectForTest("claude-default").failureCount).toBe(1);
    expect(rig.refresher._inspectForTest("claude-default").hasTimer).toBe(true);
    // No agent_auth_failed SSE on rate-limit, only on revoked. (docs/155 Phase 2b
    // unified the refresher's legacy `auth_required` emit into the
    // `agent_auth_failed` family.)
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
    // docs/155 Phase 2b — refresher signals "this account is dead, show
    // sign-in" via the unified `agent_auth_failed` event with
    // `reason: "revoked"`. Replaces the legacy `auth_required` broadcast.
    expect(sseEvents).toContain("agent_auth_failed");
    const failed = rig.sseCalls.find((c) => c.event === "agent_auth_failed");
    expect(failed!.data).toEqual({ agentId: "claude", reason: "revoked" });

    const perAccount = rig.sseCalls.find((c) => c.event === "claude_account_unauthenticated");
    expect(perAccount!.data).toEqual({ accountId: "claude-default" });

    expect(rig.refresher._inspectForTest("claude-default").emittedUnauthenticated).toBe(true);
    // After revoked we do NOT reschedule a tick on the failure path (auth_complete will rearm).
    expect(rig.refresher._inspectForTest("claude-default").hasTimer).toBe(false);
  });

  it("classifies runtime 401 invalid-credentials output as revoked instead of unknown_failure", async () => {
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
    expect(result!.outcome).toBe("revoked");
    expect(result!.reason).toBe("401 invalid authentication credentials");

    const sseEvents = rig.sseCalls.map((c) => c.event);
    expect(sseEvents).toContain("claude_account_unauthenticated");
    expect(sseEvents).toContain("agent_auth_failed");
    expect(rig.sseCalls.find((c) => c.event === "agent_auth_failed")!.data)
      .toEqual({ agentId: "claude", reason: "revoked" });
    expect(rig.refresher._inspectForTest("claude-default").emittedUnauthenticated).toBe(true);
    expect(rig.refresher._inspectForTest("claude-default").hasTimer).toBe(false);
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
      { stderr: "invalid_grant" }, { stderr: "invalid_grant" }, // first refreshNow
      { stderr: "invalid_grant" }, { stderr: "invalid_grant" }, // second refreshNow
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
      { stderr: "invalid_grant" }, { stderr: "invalid_grant" }, // revoked
      { rotateTo: rotatedTo }, // recovered (e.g., user re-authed; refresh-now nudged)
    ];

    await rig.refresher.refreshNow("claude-default");
    expect(rig.sseCalls.some((c) => c.event === "claude_account_unauthenticated")).toBe(true);

    const [result] = await rig.refresher.refreshNow("claude-default");
    expect(result!.outcome).toBe("rotated_tier1");
    expect(rig.sseCalls.some((c) => c.event === "claude_account_authenticated")).toBe(true);
    expect(rig.refresher._inspectForTest("claude-default").emittedUnauthenticated).toBe(false);
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
    // First (and only) invocation delays so the second caller sees an in-flight.
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
    // acct-a tier1 + tier2 both fail with invalid_grant → revoked
    // acct-b tier1 is read-only and the token is healthy → noop
    rig.spawnHandle.effects = [
      { stderr: "invalid_grant" }, { stderr: "invalid_grant" }, // acct-a
      { /* tier1 noop on healthy */ },                          // acct-b
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

      // After stop(), advancing time must not trigger any spawn.
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

  it("returns missing_credentials when the source file is absent", async () => {
    const now = 1_700_000_000_000;
    const rig = buildRig({
      accounts: [makeAccount("claude-default")],
      initialNow: now,
      // No initialExpiries → no file written.
    });
    rigs.push(rig);

    const [result] = await rig.refresher.refreshNow("claude-default");
    expect(result!.outcome).toBe("missing_credentials");
    expect(rig.spawnHandle.invocations.length).toBe(0);
    expect(rig.repushCalls.length).toBe(0);
  });
});
