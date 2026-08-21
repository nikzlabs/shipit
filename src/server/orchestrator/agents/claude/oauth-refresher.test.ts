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

import { ClaudeOAuthRefresher, summarizeRefreshFailure } from "./oauth-refresher.js";
import type { ClaudeOAuthRefresherDeps, RefreshResult } from "./oauth-refresher.js";
import type { ProviderAccountManager } from "../../provider-account-manager.js";
import { writeSessionAccountMarker } from "../../session-credentials-scaffold.js";
import type { CredentialRoute, AgentId } from "../../../shared/types.js";

// ---- helpers ----

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

/**
 * A credential-shaped string for the redaction tests. Assembled rather than
 * written out so the repository's own secret scanner does not have to be told
 * about a fake — the value only has to LOOK like what the `--debug api` capture
 * carries.
 */
const FAKE_OAUTH_TOKEN = ["sk", "ant", "oat01", "F".repeat(40)].join("-");

/** The account root's own token file — what every session is served from. */
function accountTokenFile(rootDir: string, accountId: string): string {
  return path.join(rootDir, "provider-accounts", "claude", accountId, ".claude", ".credentials.json");
}

/**
 * What the CLI leaves behind when it is asked to refresh with a grant the OAuth
 * server has already spent: the file stays, every token in it is erased. It
 * still parses as a credential, which is why the ordinary write-back guard
 * refuses to overwrite it.
 */
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

/**
 * A session's credential subtree: its own copy of the token, plus the docs/260
 * marker recording WHOSE copy it is. `accountId: null` writes no marker, which
 * is a pre-260 subtree — an identity the harvest is not allowed to guess at.
 */
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

/** Collect `console.log` lines for the tests that assert on log SHAPE. */
function captureLogs(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.map((arg) => (typeof arg === "string" ? arg : String(arg))).join(" "));
  });
  return { lines, restore: () => spy.mockRestore() };
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
    // docs/150-multiple-provider-subscriptions req 19 — names the revoked account; the client has no
    // provider-wide slot left to absorb an unqualified failure.
    expect(failed!.data).toEqual({ loginId: "anthropic-oauth", accountId: "claude-default", reason: "revoked" });

    const perAccount = rig.sseCalls.find((c) => c.event === "claude_account_unauthenticated");
    expect(perAccount!.data).toEqual({ accountId: "claude-default" });

    expect(rig.refresher._inspectForTest("claude-default").emittedUnauthenticated).toBe(true);
    // After revoked we do NOT reschedule a tick on the failure path (auth_complete will rearm).
    expect(rig.refresher._inspectForTest("claude-default").hasTimer).toBe(false);
  });

  it("classifies runtime 401 invalid-credentials output as unknown_failure (NOT revoked) and keeps retrying", async () => {
    // Regression: a 401 on the tier-2 API attempt is the ROUTINE pre-refresh
    // state of an expired access token (`--debug api` captures it verbatim
    // before refresh-on-use fires). When the refresh then fails transiently
    // (network blip, timeout), classifying the 401 phrase as `revoked` signed
    // the user out daily and stopped the schedule. Only invalid_grant proves
    // the refresh token is dead.
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

    // No sign-out: no SSEs, backoff timer armed so the next tick retries.
    const sseEvents = rig.sseCalls.map((c) => c.event);
    expect(sseEvents).not.toContain("claude_account_unauthenticated");
    expect(sseEvents).not.toContain("agent_auth_failed");
    expect(rig.refresher._inspectForTest("claude-default").emittedUnauthenticated).toBe(false);
    expect(rig.refresher._inspectForTest("claude-default").hasTimer).toBe(true);
  });

  it("classifies expired-token 401 + refresh 429 as rate_limited (NOT revoked)", async () => {
    // The daily-logout shape: token already past expiry, tier-2's first API
    // attempt 401s ("authentication_error" in the debug capture), then the
    // OAuth refresh itself gets rate-limited. The 401 text is incidental —
    // the correct classification is rate_limited with backoff.
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
      { stderr: "invalid_grant" }, { stderr: "invalid_grant" }, // revoked
      { rotateTo: rotatedTo }, // recovered
    ];

    const reauthEvents: string[] = [];
    rig.refresher.on("account_reauthenticated", (accountId: string) => {
      reauthEvents.push(accountId);
    });

    await rig.refresher.refreshNow("claude-default");
    // Revoked tick must NOT signal recovery.
    expect(reauthEvents).toEqual([]);

    await rig.refresher.refreshNow("claude-default");
    // The recovery tick fires exactly one reauth signal for the account.
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

  it("marks missing source credentials unauthenticated once and recovers after re-auth", async () => {
    const now = 1_700_000_000_000;
    const rig = buildRig({
      accounts: [makeAccount("claude-default")],
      initialNow: now,
      // No initialExpiries → no file written.
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

  // ---- ensureFresh (docs/179) — proactive pre-read heal ----

  describe("ensureFresh", () => {
    it("is a no-op (no CLI spawn) and returns true when the token is healthy", async () => {
      const now = 1_700_000_000_000;
      const future = now + 8 * 60 * 60 * 1000; // 8h out, well beyond the margin
      const rig = buildRig({
        accounts: [makeAccount("claude-default")],
        initialExpiries: { "claude-default": future },
        initialNow: now,
      });
      rigs.push(rig);

      const ok = await rig.refresher.ensureFresh("claude-default");
      expect(ok).toBe(true);
      expect(rig.spawnHandle.invocations.length).toBe(0); // never touched the CLI
    });

    it("heals a within-margin token via a single-flight refresh and returns true", async () => {
      const now = 1_700_000_000_000;
      const nearExpiry = now + 10 * 60 * 1000; // 10m out, inside the 45m margin
      const rotatedTo = now + 8 * 60 * 60 * 1000;
      const rig = buildRig({
        accounts: [makeAccount("claude-default")],
        initialExpiries: { "claude-default": nearExpiry },
        initialNow: now,
      });
      rigs.push(rig);
      rig.spawnHandle.effects = [{ rotateTo: rotatedTo }]; // tier1 rotates

      const ok = await rig.refresher.ensureFresh("claude-default");
      expect(ok).toBe(true);
      expect(rig.spawnHandle.invocations.length).toBe(1);
      expect(rig.repushCalls).toEqual([{ agentId: "claude", accountId: "claude-default" }]);
    });

    it("returns false when an expired token can't be refreshed (revoked)", async () => {
      const now = 1_700_000_000_000;
      const expired = now - 60 * 1000; // already expired
      const rig = buildRig({
        accounts: [makeAccount("claude-default")],
        initialExpiries: { "claude-default": expired },
        initialNow: now,
      });
      rigs.push(rig);
      rig.spawnHandle.effects = [
        { stderr: "invalid_grant" }, // tier1
        { stderr: "invalid_grant" }, // tier2
      ];

      const ok = await rig.refresher.ensureFresh("claude-default");
      expect(ok).toBe(false); // token still expired after a failed heal
    });

    it("returns false when there is no source token", async () => {
      const now = 1_700_000_000_000;
      const rig = buildRig({
        accounts: [makeAccount("claude-default")],
        initialNow: now,
        // no initialExpiries → no file
      });
      rigs.push(rig);

      const ok = await rig.refresher.ensureFresh("claude-default");
      expect(ok).toBe(false);
      expect(rig.spawnHandle.invocations.length).toBe(0);
    });

    // ---- forced heal (docs/179 — the runtime-401 recovery path) ----
    //
    // The production failure this covers: six `auth healed` events in six hours
    // with ZERO refresher log lines beside them. `expiresAt` still had margin,
    // so the unforced short-circuit answered `true` having spawned nothing, the
    // executor re-dispatched on byte-identical credentials, and it 401'd again.

    it("forced: probes a healthy token with tier 2 instead of short-circuiting", async () => {
      const now = 1_700_000_000_000;
      const future = now + 8 * 60 * 60 * 1000; // 8h out — the unforced path returns true with no spawn
      const rig = buildRig({
        accounts: [makeAccount("claude-default")],
        initialExpiries: { "claude-default": future },
        initialNow: now,
      });
      rigs.push(rig);
      rig.spawnHandle.effects = [{ /* tier1: read-only, no rotation */ }, { /* tier2: no rotation */ }];

      const ok = await rig.refresher.ensureFresh("claude-default", { force: true });
      expect(ok).toBe(true); // live token — the recovery's repush is what repairs the session
      expect(rig.spawnHandle.invocations.length).toBe(2);
      expect(rig.spawnHandle.invocations[0]!.args).toContain("status");
      expect(rig.spawnHandle.invocations[1]!.args).toContain("--print"); // tier 2 ran
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
      // Future expiry — the timestamp says healthy, the grant is dead. This is
      // the exact state expiry cannot detect and a live 401 proves.
      const future = now + 8 * 60 * 60 * 1000;
      const rig = buildRig({
        accounts: [makeAccount("claude-default")],
        initialExpiries: { "claude-default": future },
        initialNow: now,
      });
      rigs.push(rig);
      rig.spawnHandle.effects = [{ stderr: "invalid_grant" }, { stderr: "invalid_grant" }];

      const ok = await rig.refresher.ensureFresh("claude-default", { force: true });
      expect(ok).toBe(false); // caller surfaces the sign-in card instead of burning the retry
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
      rig.spawnHandle.effects = [{ /* tier1 */ }, { /* tier2, no rotation */ }];

      await rig.refresher.ensureFresh("claude-default", { force: true });
      // The tick ran tier 2 as a probe, not as a due refresh: a token that was
      // never near expiry must not count as a failed rotation, or every 401 in
      // any session would derail this account's expiry-derived schedule.
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
      // Even with an EXPIRED token, local mode must not spawn the CLI.
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

  // ---- harvest before spend ----
  //
  // A session's resident CLI refreshes on its own clock, between turns. Because
  // Anthropic's refresh tokens are single-use, the copy on the account root is
  // dead the moment it does — so a tick that spends it cannot succeed, and the
  // spend is what makes the CLI blank the source and take the account down.
  // Every tick therefore reconciles with the sessions first.

  describe("harvest before spend", () => {
    it("adopts a pinned session's newer token and never spawns the CLI", async () => {
      const now = 1_700_000_000_000;
      const rig = buildRig({
        accounts: [makeAccount("acct-1")],
        // Inside the 45m margin, so without a harvest this tick reaches the
        // billable tier-2 spend of a refresh token the session already used.
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
      // The session's actual token bytes reached the source, not just an expiry.
      expect(fs.readFileSync(accountTokenFile(rig.rootDir, "acct-1"), "utf8")).toContain(`sess_tok_${rotatedTo}`);
      // And every OTHER pinned session gets it (docs/142 A3).
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
      // A stale copy must never be published over the source.
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
      // The subtree holds acct-2's bearer — publishing it to acct-1 would leave
      // both accounts authenticating as one subscription.
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

    // A `<sessionDir>/.claude` symlink into an account root (pre-docs/150 req 19
    // provisioning) makes the session path a second name for THAT account's
    // credential. Reading through one would compare account B's own source
    // against A's and copy it in — no race required, so the harvest checks that
    // a candidate's token file physically lives in its own subtree.
    it("skips a session whose subtree escapes into another account's root", async () => {
      const now = 1_700_000_000_000;
      const rig = buildRig({
        accounts: [makeAccount("acct-1"), makeAccount("acct-2")],
        initialExpiries: {
          "acct-1": now + 10 * 60 * 1000,
          "acct-2": now + 8 * 60 * 60 * 1000, // acct-2's own token is much newer
        },
        initialNow: now,
      });
      rigs.push(rig);

      // The subtree is marked to acct-1, but its `.claude` is acct-2's root.
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
      // acct-2's bearer never reached acct-1's root.
      const acct1 = fs.readFileSync(accountTokenFile(rig.rootDir, "acct-1"), "utf8");
      const acct2 = fs.readFileSync(accountTokenFile(rig.rootDir, "acct-2"), "utf8");
      const acct2Token = (JSON.parse(acct2) as { claudeAiOauth: { accessToken: string } })
        .claudeAiOauth.accessToken;
      expect(acct1).not.toContain(acct2Token);
    });

    // Diagnosis only, deliberately: a file this reader believes is empty may be
    // a partial write or a shape it has not been taught, and the account is
    // unusable either way. Nothing deletes or repairs it.
    it("leaves a blanked source on disk and still reports missing_credentials", async () => {
      const now = 1_700_000_000_000;
      const rig = buildRig({ accounts: [makeAccount("acct-1")], initialNow: now });
      rigs.push(rig);
      const accountRoot = path.join(rig.rootDir, "provider-accounts", "claude", "acct-1");
      writeBlankedCredentials(accountRoot);
      // Even with a live session copy sitting right there, the harvest cannot
      // publish over a credential-shaped source (the planning#449 guard).
      writeSessionToken(rig.rootDir, "sess-a", { expiresAt: now + 8 * 60 * 60 * 1000, accountId: "acct-1" });

      const [result] = await rig.refresher.refreshNow("acct-1");

      expect(result!.outcome).toBe("missing_credentials");
      expect(result!.reason).toContain("blanked");
      expect(fs.existsSync(path.join(accountRoot, ".claude", ".credentials.json"))).toBe(true);
    });
  });

  // ---- failure diagnosability ----

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
      // The `--debug api` capture carries live credentials; nothing token-shaped
      // may reach a log line or a RefreshResult.
      expect(result!.reason).not.toContain(FAKE_OAUTH_TOKEN);
      const failureLine = logs.lines.find((line) => line.includes("unknown_failure failure_count=1"));
      expect(failureLine).toBeDefined();
      // The sentence runbooks grep for is unchanged; the field is appended.
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
    const opaque = "A".repeat(48); // a bare token with no key or prefix to spot it by
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
    // `Basic dXNlcjpwdw==` is short, base64-padded and carries no recognizable
    // prefix: no token pattern catches it, so the header must go by NAME.
    const summary = summarizeRefreshFailure(
      "x-api-key: abc123\nAuthorization: Basic dXNlcjpwdw==",
    );
    expect(summary).not.toContain("abc123");
    expect(summary).not.toContain("dXNlcjpwdw==");
    // The header name stays — which credential was sent is the diagnostic
    // value; only the value itself has to go.
    expect(summary).toContain("x-api-key: [redacted]");
  });

  it("keeps the failure line and drops noise around it", () => {
    // A real capture is mostly headers. The signal filter is what keeps the
    // excerpt about the failure rather than about the request.
    const summary = summarizeRefreshFailure(
      "POST /v1/oauth/token\nAuthorization: Bearer abcdef\nError: 401 invalid_grant",
    );
    expect(summary).toBe("Error: 401 invalid_grant");
  });

  it("caps the excerpt so one runaway line cannot flood the log", () => {
    expect(summarizeRefreshFailure(`Error: ${"x".repeat(5_000)}`).length).toBeLessThanOrEqual(300);
  });
});
