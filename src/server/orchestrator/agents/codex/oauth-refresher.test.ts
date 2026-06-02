/**
 * Unit tests for CodexOAuthRefresher (docs/154).
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";

import { CodexOAuthRefresher } from "./oauth-refresher.js";
import type { CodexOAuthRefresherDeps, CodexRefreshResult } from "./oauth-refresher.js";
import type { ProviderAccountManager } from "../../provider-account-manager.js";
import type { AgentId, ProviderAccount } from "../../../shared/types.js";

function makeAccount(id: string, overrides: Partial<ProviderAccount> = {}): ProviderAccount {
  return {
    id,
    provider: "codex" as AgentId,
    label: id,
    isPrimary: true,
    status: "ready",
    plan: "plus",
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
      if (provider && provider !== "codex") return [];
      return opts.accounts;
    },
    resolveCredentialRoot: (provider: AgentId, accountId: string): string => {
      return path.join(opts.rootDir, "provider-accounts", provider, accountId);
    },
  } as unknown as ProviderAccountManager;
}

function jwtWithExp(expMs: number): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(expMs / 1000) })).toString("base64url");
  return `${header}.${payload}.sig`;
}

function writeAuth(accountRoot: string, payload: { freshness: number; mode?: "jwt" | "last_refresh" }): void {
  const dir = path.join(accountRoot, ".codex");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "auth.json");
  const mode = payload.mode ?? "jwt";
  const body =
    mode === "last_refresh"
      ? { last_refresh: new Date(payload.freshness).toISOString() }
      : { tokens: { access_token: jwtWithExp(payload.freshness) } };
  fs.writeFileSync(file, JSON.stringify(body), "utf8");
}

interface SpawnEffect {
  rotateTo?: number;
  rotateMode?: "jwt" | "last_refresh";
  stderr?: string;
  stdout?: string;
  exitCode?: number;
  delayMs?: number;
}

interface FakeSpawnHandle {
  invocations: { cmd: string; args: string[]; accountRoot: string }[];
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
    handle.invocations.push({ cmd, args: argArr, accountRoot });
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
      if (effect.rotateTo !== undefined && accountRoot) {
        writeAuth(accountRoot, { freshness: effect.rotateTo, mode: effect.rotateMode });
      }
      child.emit("exit", effect.exitCode ?? 0, null);
    };
    if (effect.delayMs && effect.delayMs > 0) setTimeout(fire, effect.delayMs);
    else setTimeout(fire, 0);
    return child;
  }) as FakeSpawnHandle["spawn"];

  return handle;
}

interface TestRig {
  rootDir: string;
  refresher: CodexOAuthRefresher;
  spawnHandle: FakeSpawnHandle;
  repushCalls: { agentId: AgentId; accountId: string }[];
  sseCalls: { event: string; data: unknown }[];
}

function buildRig(opts: {
  accounts: ProviderAccount[];
  initialFreshness?: Record<string, number>;
  initialMode?: "jwt" | "last_refresh";
  initialNow?: number;
  safetyMarginMs?: number;
}): TestRig {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-refresh-test-"));
  const pam = makeProviderAccountManager({ rootDir, accounts: opts.accounts });
  for (const acc of opts.accounts) {
    const accountRoot = pam.resolveCredentialRoot("codex", acc.id);
    fs.mkdirSync(accountRoot, { recursive: true });
    const initial = opts.initialFreshness?.[acc.id];
    if (initial !== undefined) writeAuth(accountRoot, { freshness: initial, mode: opts.initialMode });
  }

  const repushCalls: { agentId: AgentId; accountId: string }[] = [];
  const sseCalls: { event: string; data: unknown }[] = [];
  const spawnHandle = makeFakeSpawn((env) => env.HOME ?? "");
  const deps: CodexOAuthRefresherDeps = {
    credentialsDir: rootDir,
    providerAccountManager: pam,
    repushAccountToken: (agentId, accountId) => {
      repushCalls.push({ agentId, accountId });
    },
    sseBroadcast: (event, data) => {
      sseCalls.push({ event, data });
    },
    runtimeMode: "containerized",
    now: () => opts.initialNow ?? 1_700_000_000_000,
    spawn: spawnHandle.spawn as unknown as CodexOAuthRefresherDeps["spawn"],
  };
  if (opts.safetyMarginMs !== undefined) deps.safetyMarginMs = opts.safetyMarginMs;

  return {
    rootDir,
    refresher: new CodexOAuthRefresher(deps),
    spawnHandle,
    repushCalls,
    sseCalls,
  };
}

function cleanupRig(rig: TestRig): void {
  rig.refresher.stop();
  fs.rmSync(rig.rootDir, { recursive: true, force: true });
}

describe("CodexOAuthRefresher", () => {
  let rigs: TestRig[] = [];
  afterEach(() => {
    for (const rig of rigs) cleanupRig(rig);
    rigs = [];
  });

  it("noop when token is healthy and tier1 does not rotate", async () => {
    const now = 1_700_000_000_000;
    const future = now + 14 * 24 * 60 * 60 * 1000;
    const rig = buildRig({
      accounts: [makeAccount("codex-default")],
      initialFreshness: { "codex-default": future },
      initialNow: now,
    });
    rigs.push(rig);
    rig.spawnHandle.effects = [{}];

    const [result] = await rig.refresher.refreshNow("codex-default");
    expect(result!.outcome).toBe("noop");
    expect(rig.spawnHandle.invocations).toHaveLength(1);
    expect(rig.spawnHandle.invocations[0]!.cmd).toBe("codex");
    expect(rig.spawnHandle.invocations[0]!.args).toEqual(["login", "status"]);
    expect(rig.repushCalls).toEqual([]);
  });

  it("rotates via tier1 when JWT exp advances", async () => {
    const now = 1_700_000_000_000;
    const future = now + 60 * 60 * 1000;
    const rotatedTo = now + 14 * 24 * 60 * 60 * 1000;
    const rig = buildRig({
      accounts: [makeAccount("codex-default")],
      initialFreshness: { "codex-default": future },
      initialNow: now,
    });
    rigs.push(rig);
    rig.spawnHandle.effects = [{ rotateTo: rotatedTo }];

    const [result] = await rig.refresher.refreshNow("codex-default");
    expect(result!.outcome).toBe("rotated_tier1");
    expect(result!.afterFreshness).toBe(Math.floor(rotatedTo / 1000) * 1000);
    expect(rig.spawnHandle.invocations).toHaveLength(1);
    expect(rig.repushCalls).toEqual([{ agentId: "codex", accountId: "codex-default" }]);
  });

  it("falls through to tier2 and treats last_refresh advancing as rotation", async () => {
    const now = 1_700_000_000_000;
    const nearExpiry = now + 5 * 60 * 1000;
    const rotatedTo = now + 30 * 60 * 1000;
    const rig = buildRig({
      accounts: [makeAccount("codex-default")],
      initialFreshness: { "codex-default": nearExpiry },
      initialNow: now,
      initialMode: "last_refresh",
    });
    rigs.push(rig);
    rig.spawnHandle.effects = [
      {},
      { rotateTo: rotatedTo, rotateMode: "last_refresh" },
    ];

    const [result] = await rig.refresher.refreshNow("codex-default");
    expect(result!.outcome).toBe("rotated_tier2");
    expect(rig.spawnHandle.invocations).toHaveLength(2);
    expect(rig.spawnHandle.invocations[1]!.args).toEqual(["exec", "--skip-git-repo-check", "ok"]);
    expect(rig.repushCalls).toEqual([{ agentId: "codex", accountId: "codex-default" }]);
  });

  it("classifies 429 output as rate_limited and schedules backoff", async () => {
    const now = 1_700_000_000_000;
    const rig = buildRig({
      accounts: [makeAccount("codex-default")],
      initialFreshness: { "codex-default": now + 5 * 60 * 1000 },
      initialNow: now,
    });
    rigs.push(rig);
    rig.spawnHandle.effects = [
      { stderr: "HTTP 429 rate_limit" },
      { stderr: "HTTP 429 rate_limit" },
    ];

    const [result] = await rig.refresher.refreshNow("codex-default");
    expect(result!.outcome).toBe("rate_limited");
    expect(rig.refresher._inspectForTest("codex-default").failureCount).toBe(1);
    expect(rig.refresher._inspectForTest("codex-default").hasTimer).toBe(true);
    expect(rig.sseCalls.find((c) => c.event === "agent_auth_failed")).toBeUndefined();
  });

  it("classifies invalid_grant as revoked and emits Codex auth events once", async () => {
    const now = 1_700_000_000_000;
    const rig = buildRig({
      accounts: [makeAccount("codex-default")],
      initialFreshness: { "codex-default": now + 5 * 60 * 1000 },
      initialNow: now,
    });
    rigs.push(rig);
    rig.spawnHandle.effects = [
      { stderr: "invalid_grant" }, { stderr: "invalid_grant" },
      { stderr: "invalid_grant" }, { stderr: "invalid_grant" },
    ];

    const [result] = await rig.refresher.refreshNow("codex-default");
    await rig.refresher.refreshNow("codex-default");
    expect(result!.outcome).toBe("revoked");
    expect(rig.sseCalls.filter((c) => c.event === "codex_account_unauthenticated")).toHaveLength(1);
    expect(rig.sseCalls).toContainEqual({
      event: "agent_auth_failed",
      data: { agentId: "codex", reason: "revoked" },
    });
  });

  it("emits codex_account_authenticated after a previously revoked account rotates", async () => {
    const now = 1_700_000_000_000;
    const rig = buildRig({
      accounts: [makeAccount("codex-default")],
      initialFreshness: { "codex-default": now + 5 * 60 * 1000 },
      initialNow: now,
    });
    rigs.push(rig);
    rig.spawnHandle.effects = [
      { stderr: "invalid_grant" }, { stderr: "invalid_grant" },
      { rotateTo: now + 14 * 24 * 60 * 60 * 1000 },
    ];

    await rig.refresher.refreshNow("codex-default");
    const [result] = await rig.refresher.refreshNow("codex-default");
    expect(result!.outcome).toBe("rotated_tier1");
    expect(rig.sseCalls.some((c) => c.event === "codex_account_authenticated")).toBe(true);
  });

  it("single-flight: concurrent calls share one Codex CLI invocation", async () => {
    const now = 1_700_000_000_000;
    const rig = buildRig({
      accounts: [makeAccount("codex-default")],
      initialFreshness: { "codex-default": now + 60 * 60 * 1000 },
      initialNow: now,
    });
    rigs.push(rig);
    rig.spawnHandle.effects = [{ rotateTo: now + 14 * 24 * 60 * 60 * 1000, delayMs: 25 }];

    const [a, b] = await Promise.all([
      rig.refresher.refreshNow("codex-default"),
      rig.refresher.refreshNow("codex-default"),
    ]);
    expect(rig.spawnHandle.invocations).toHaveLength(1);
    expect(a[0]!.outcome).toBe("rotated_tier1");
    expect(b[0]!.outcome).toBe("rotated_tier1");
  });

  it("per-account isolation: revoked account does not affect healthy account", async () => {
    const now = 1_700_000_000_000;
    const rig = buildRig({
      accounts: [makeAccount("acct-a"), makeAccount("acct-b", { isPrimary: false })],
      initialFreshness: {
        "acct-a": now + 5 * 60 * 1000,
        "acct-b": now + 60 * 60 * 1000,
      },
      initialNow: now,
    });
    rigs.push(rig);
    rig.spawnHandle.effects = [
      { stderr: "invalid_grant" }, { stderr: "invalid_grant" },
      {},
    ];

    const results = await rig.refresher.refreshNow();
    const byId: Record<string, CodexRefreshResult> = {};
    for (const r of results) byId[r.accountId] = r;
    expect(byId["acct-a"]!.outcome).toBe("revoked");
    expect(byId["acct-b"]!.outcome).toBe("noop");
    expect(rig.refresher._inspectForTest("acct-a").emittedUnauthenticated).toBe(true);
    expect(rig.refresher._inspectForTest("acct-b").emittedUnauthenticated).toBe(false);
  });

  it("start schedules known accounts and stop cancels timers", () => {
    vi.useFakeTimers();
    try {
      const now = 1_700_000_000_000;
      const rig = buildRig({
        accounts: [makeAccount("acct-a"), makeAccount("acct-b")],
        initialFreshness: {
          "acct-a": now + 60 * 60 * 1000,
          "acct-b": now + 60 * 60 * 1000,
        },
        initialNow: now,
      });
      rigs.push(rig);

      rig.refresher.start();
      expect(rig.refresher._inspectForTest("acct-a").hasTimer).toBe(true);
      expect(rig.refresher._inspectForTest("acct-b").hasTimer).toBe(true);
      rig.refresher.stop();
      expect(rig.refresher._inspectForTest("acct-a").hasTimer).toBe(false);
      expect(rig.refresher._inspectForTest("acct-b").hasTimer).toBe(false);
      vi.advanceTimersByTime(2 * 60 * 60 * 1000);
      expect(rig.spawnHandle.invocations).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("start is a no-op in local runtime mode", () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-refresh-local-"));
    const accounts = [makeAccount("codex-default")];
    const pam = makeProviderAccountManager({ rootDir, accounts });
    const accountRoot = pam.resolveCredentialRoot("codex", "codex-default");
    writeAuth(accountRoot, { freshness: Date.now() + 60 * 60 * 1000 });
    const spawnHandle = makeFakeSpawn((env) => env.HOME ?? "");
    const refresher = new CodexOAuthRefresher({
      credentialsDir: rootDir,
      providerAccountManager: pam,
      repushAccountToken: () => {},
      sseBroadcast: () => {},
      runtimeMode: "local",
      spawn: spawnHandle.spawn as unknown as CodexOAuthRefresherDeps["spawn"],
    });

    refresher.start();
    expect(refresher._knownAccountsForTest()).toEqual([]);
    expect(spawnHandle.invocations).toHaveLength(0);
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it("returns missing_credentials when source auth.json is absent", async () => {
    const rig = buildRig({
      accounts: [makeAccount("codex-default")],
    });
    rigs.push(rig);

    const [result] = await rig.refresher.refreshNow("codex-default");
    expect(result!.outcome).toBe("missing_credentials");
    expect(rig.spawnHandle.invocations).toHaveLength(0);
    expect(rig.repushCalls).toEqual([]);
  });
});
