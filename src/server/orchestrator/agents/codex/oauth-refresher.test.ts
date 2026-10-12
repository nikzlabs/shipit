import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";

import {
  classifyCodexRefreshOutput,
  CodexOAuthRefresher,
  CODEX_REFRESH_COMMAND,
  CODEX_REFRESH_MESSAGES,
} from "./oauth-refresher.js";
import type { CodexOAuthRefresherDeps, CodexRefreshResult } from "./oauth-refresher.js";
import type { ProviderAccountManager } from "../../provider-account-manager.js";
import { writeSessionAccountMarker } from "../../session-credentials-scaffold.js";
import { killProcessTree } from "../../../shared/kill-child.js";
import type { AgentId, CredentialRoute } from "../../../shared/types.js";

// The fake child has no pid, so the real function would return before it signals.
vi.mock("../../../shared/kill-child.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  killProcessTree: vi.fn((child: ChildProcess, signal: NodeJS.Signals) => child.kill(signal)),
}));

const NOW = 1_700_000_000_000;
const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;
const ACCOUNT_EMAIL = "owner@example.invalid";

function makeAccount(id: string, overrides: Partial<CredentialRoute> = {}): CredentialRoute {
  return {
    id,
    serviceId: "openai",
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
      if (serviceId && serviceId !== "openai") return [];
      return opts.accounts;
    },
    resolveCredentialRoot: (provider: AgentId, accountId: string): string => {
      return path.join(opts.rootDir, "provider-accounts", provider, accountId);
    },
  } as unknown as ProviderAccountManager;
}

function jwtWithExp(expMs: number, mark: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(expMs / 1000), mark })).toString("base64url");
  return `${header}.${payload}.sig`;
}

interface AuthPayload {
  freshness: number;
  mode?: "jwt" | "last_refresh";
  // Two files with one mark hold one credential.
  mark?: string;
}

function writeAuthFile(file: string, payload: AuthPayload): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const mark = payload.mark ?? String(payload.freshness);
  // "last_refresh": tokens whose expiry cannot be read, so the file's own timestamp orders them.
  const body =
    payload.mode === "last_refresh"
      ? {
          tokens: { access_token: `opaque-${mark}`, refresh_token: `rt_${mark}` },
          last_refresh: new Date(payload.freshness).toISOString(),
        }
      : { tokens: { access_token: jwtWithExp(payload.freshness, mark), refresh_token: `rt_${mark}` } };
  fs.writeFileSync(file, JSON.stringify(body), "utf8");
}

function accountRootOf(rootDir: string, accountId: string): string {
  return path.join(rootDir, "provider-accounts", "codex", accountId);
}

function accountAuthFile(rootDir: string, accountId: string): string {
  return path.join(accountRootOf(rootDir, accountId), ".codex", "auth.json");
}

function writeAuth(accountRoot: string, payload: AuthPayload): void {
  writeAuthFile(path.join(accountRoot, ".codex", "auth.json"), payload);
}

function writeSessionAuth(
  rootDir: string,
  sessionId: string,
  opts: { freshness: number; accountId: string | null },
): void {
  writeAuthFile(path.join(rootDir, "sessions", sessionId, ".codex", "auth.json"), {
    freshness: opts.freshness,
    mark: `session-${sessionId}`,
  });
  if (opts.accountId !== null) writeSessionAccountMarker(rootDir, sessionId, "codex", opts.accountId);
}

function sourceMark(rootDir: string, accountId: string): string {
  const auth = JSON.parse(fs.readFileSync(accountAuthFile(rootDir, accountId), "utf8")) as {
    tokens: { refresh_token: string };
  };
  return auth.tokens.refresh_token;
}

// What Codex CLI 0.159.2 writes to stderr when the token host refuses a refresh (color codes included).
function refusalLine(status: string, code: string | null, stamp = "2026-10-11T17:55:15.177930Z"): string {
  const dim = "\x1b[2m";
  const off = "\x1b[0m";
  return `${dim}${stamp}${off} \x1b[31mERROR${off} ${dim}codex_login::auth::manager${off}${dim}:${off} `
    + `Failed to refresh token \x1b[3mstatus${off}${dim}=${off}${status} \x1b[3mdetail${off}${dim}=${off}`
    + `TokenErrorDetail { error_code: ${code ? `Some("${code}")` : "None"}, error_message: Some("probe"), .. }\n`;
}

const REUSED = refusalLine("401 Unauthorized", "refresh_token_reused");
const INVALIDATED = refusalLine("401 Unauthorized", "refresh_token_invalidated");
const EXPIRED = refusalLine("401 Unauthorized", "refresh_token_expired");
const RATE_LIMITED = refusalLine("429 Too Many Requests", "rate_limit_exceeded");
const SERVER_ERROR = refusalLine("500 Internal Server Error", null);

function captureLogs(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.map((arg) => (typeof arg === "string" ? arg : String(arg))).join(" "));
  });
  return { lines, restore: () => spy.mockRestore() };
}

interface SpawnEffect {
  rotateTo?: number;
  rotateMode?: "jwt" | "last_refresh";
  rotateMark?: string;
  stderr?: string;
  // Arrives between the CLI's exit and the close of its pipes.
  stderrAfterExit?: string;
  // Lines that are JSON, but no message.
  junkStdout?: string;
  // The answer arrives in two pieces.
  splitAnswer?: boolean;
  ignoresKill?: boolean;
  delayMs?: number;
  // Runs when the CLI has its refresh request, before it answers.
  onRefresh?: () => void;
  // Runs when the CLI has written the file, before it answers.
  afterRotate?: () => void;
  // In place of a rotation: a file with a later expiry and no usable token.
  writesTokenlessFile?: number;
  spawnThrows?: boolean;
  // The child reports an error and never starts.
  failsToStart?: boolean;
  // The CLI ends before it answers `initialize`.
  exitsBeforeInit?: boolean;
  rpcError?: string;
  // The CLI ends without an answer.
  noReply?: boolean;
  // The CLI neither answers nor ends.
  hang?: boolean;
  // The CLI sends a request of its own, with the id of the awaited answer, before it answers.
  serverRequestFirst?: boolean;
}

interface Invocation {
  cmd: string;
  args: string[];
  accountRoot: string;
  cwd: string | undefined;
  env: Record<string, string | undefined>;
  // What the refresher's own listeners threw: in production that ends the orchestrator.
  listenerErrors: unknown[];
  sent: { id?: number; method?: string; params?: unknown }[];
}

interface FakeSpawnHandle {
  invocations: Invocation[];
  effects: SpawnEffect[];
  spawn: (cmd: string, args?: readonly string[], opts?: { cwd?: string; env?: Record<string, string> }) => ChildProcess;
}

// Speaks the app-server's side of the exchange: answers `initialize`, then `account/read`.
function makeFakeSpawn(): FakeSpawnHandle {
  const handle: FakeSpawnHandle = {
    invocations: [],
    effects: [],
    spawn: (() => undefined as unknown) as FakeSpawnHandle["spawn"],
  };

  handle.spawn = ((cmd, args, opts) => {
    const env = opts?.env ?? {};
    const accountRoot = env.HOME ?? "";
    const invocation: Invocation = { cmd, args: Array.from(args ?? []), accountRoot, cwd: opts?.cwd, env, listenerErrors: [], sent: [] };
    handle.invocations.push(invocation);
    const effect = handle.effects[handle.invocations.length - 1] ?? {};
    if (effect.spawnThrows) throw new Error("spawn EAGAIN");

    const child = new EventEmitter() as ChildProcess;
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const stdin = new EventEmitter() as EventEmitter & { write: (line: string) => boolean; end: () => void };
    let ended = false;
    const exit = (): void => {
      if (ended) return;
      ended = true;
      child.emit("exit", 0, null);
      if (effect.stderrAfterExit) stderr.emit("data", Buffer.from(effect.stderrAfterExit, "utf8"));
      child.emit("close", 0, null);
    };
    const say = (message: unknown): void => {
      const line = `${JSON.stringify(message)}\n`;
      const cut = effect.splitAnswer ? Math.floor(line.length / 2) : line.length;
      stdout.emit("data", Buffer.from(line.slice(0, cut), "utf8"));
      if (cut < line.length) stdout.emit("data", Buffer.from(line.slice(cut), "utf8"));
    };
    const answerRefresh = (): void => {
      if (ended) return;
      effect.onRefresh?.();
      if (effect.stderr) stderr.emit("data", Buffer.from(effect.stderr, "utf8"));
      if (effect.rotateTo !== undefined) {
        writeAuth(accountRoot, { freshness: effect.rotateTo, mode: effect.rotateMode, mark: effect.rotateMark });
        effect.afterRotate?.();
      }
      if (effect.writesTokenlessFile !== undefined) {
        const idOnly = { tokens: { id_token: jwtWithExp(effect.writesTokenlessFile, "id-only") } };
        fs.writeFileSync(path.join(accountRoot, ".codex", "auth.json"), JSON.stringify(idOnly), "utf8");
      }
      if (effect.junkStdout) {
        try {
          stdout.emit("data", Buffer.from(effect.junkStdout, "utf8"));
        } catch (err) {
          invocation.listenerErrors.push(err);
        }
      }
      if (effect.hang) return;
      if (effect.noReply) {
        exit();
        return;
      }
      say(
        effect.rpcError
          ? { id: 1, error: { code: -32601, message: effect.rpcError } }
          : { id: 1, result: { account: { type: "chatgpt", email: ACCOUNT_EMAIL, planType: "pro" } } },
      );
    };
    stdin.write = (line: string): boolean => {
      const message = JSON.parse(line) as Invocation["sent"][number];
      invocation.sent.push(message);
      if (message.id === 0) setTimeout(() => (effect.exitsBeforeInit ? exit() : say({ id: 0, result: { userAgent: "fake" } })), 0);
      if (message.method === "account/read") {
        if (effect.serverRequestFirst) say({ id: 1, method: "item/tool/call", params: {} });
        setTimeout(answerRefresh, effect.delayMs ?? 0);
      }
      return true;
    };
    stdin.end = (): void => {
      setTimeout(exit, 0);
    };
    const kill = (): boolean => {
      if (!effect.ignoresKill) setTimeout(exit, 0);
      return true;
    };
    Object.assign(child, { stdin, stdout, stderr, kill });
    if (effect.failsToStart) {
      setTimeout(() => child.emit("error", Object.assign(new Error("spawn codex ENOENT"), { code: "ENOENT" })), 0);
    }
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
  clock: { now: number };
}

function buildRig(opts: {
  accounts: CredentialRoute[];
  initialFreshness?: Record<string, number>;
  initialMode?: "jwt" | "last_refresh";
  initialNow?: number;
  safetyMarginMs?: number;
  lateRotationWaitMs?: number;
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
  const spawnHandle = makeFakeSpawn();
  const clock = { now: opts.initialNow ?? NOW };
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
    now: () => clock.now,
    spawn: spawnHandle.spawn as unknown as CodexOAuthRefresherDeps["spawn"],
    lateRotationWaitMs: opts.lateRotationWaitMs ?? 0,
  };
  if (opts.safetyMarginMs !== undefined) deps.safetyMarginMs = opts.safetyMarginMs;

  return {
    rootDir,
    refresher: new CodexOAuthRefresher(deps),
    spawnHandle,
    repushCalls,
    sseCalls,
    clock,
  };
}

function cleanupRig(rig: TestRig): void {
  rig.refresher.stop();
  fs.rmSync(rig.rootDir, { recursive: true, force: true });
}

describe("classifyCodexRefreshOutput", () => {
  it("reads the token host's refusal code from the CLI's status line", () => {
    expect(classifyCodexRefreshOutput(REUSED)).toEqual({ kind: "rejected", code: "refresh_token_reused" });
    expect(classifyCodexRefreshOutput(INVALIDATED)).toEqual({ kind: "rejected", code: "refresh_token_invalidated" });
    expect(classifyCodexRefreshOutput(EXPIRED)).toEqual({ kind: "rejected", code: "refresh_token_expired" });
    expect(classifyCodexRefreshOutput(refusalLine("400 Bad Request", "invalid_grant")))
      .toEqual({ kind: "rejected", code: "invalid_grant" });
  });

  it("does not read a 401 that is not about the grant as a rejected grant", () => {
    expect(classifyCodexRefreshOutput(refusalLine("401 Unauthorized", "invalid_client"))).toEqual({ kind: "none" });
    expect(classifyCodexRefreshOutput(refusalLine("401 Unauthorized", null))).toEqual({ kind: "none" });
  });

  it("reads the messages that the CLI prints outside app-server", () => {
    const line = (reason: string): string =>
      `2026-10-11T17:17:50.693965Z ERROR codex_login::auth::manager: Failed to refresh token: `
      + `Your access token could not be refreshed because your refresh token ${reason}. Please log out and sign in again.\n`;
    expect(classifyCodexRefreshOutput(line("was already used"))).toEqual({ kind: "rejected", code: "refresh_token_reused" });
    expect(classifyCodexRefreshOutput(line("was revoked"))).toEqual({ kind: "rejected", code: "refresh_token_invalidated" });
    expect(classifyCodexRefreshOutput(line("has expired"))).toEqual({ kind: "rejected", code: "refresh_token_expired" });
  });

  it("reads a 429 only from the refresh's status, not from a timestamp", () => {
    expect(classifyCodexRefreshOutput(RATE_LIMITED)).toEqual({ kind: "rate_limited" });
    expect(classifyCodexRefreshOutput(
      "ERROR codex_login::auth::manager: Failed to refresh token: Failed to refresh token: 429 Too Many Requests: Rate limit reached\n",
    )).toEqual({ kind: "rate_limited" });
    expect(classifyCodexRefreshOutput(refusalLine("500 Internal Server Error", null, "2026-10-11T17:20:52.178429Z")))
      .toEqual({ kind: "none" });
    expect(classifyCodexRefreshOutput(SERVER_ERROR.replace('Some("probe")', 'Some("upstream answered 429")')))
      .toEqual({ kind: "none" });
    expect(classifyCodexRefreshOutput(SERVER_ERROR)).toEqual({ kind: "none" });
  });

  it("does not read a 401 from the model API, or a refusal named in other output, as a rejected grant", () => {
    expect(classifyCodexRefreshOutput(
      "ERROR codex_core::client: unexpected status 401 Unauthorized: token_expired, url: https://chatgpt.com/backend-api/codex/responses\n",
    )).toEqual({ kind: "none" });
    expect(classifyCodexRefreshOutput(
      'ERROR codex_core::client: request failed status=400 Bad Request detail=ApiError { error_code: Some("invalid_grant") }\n',
    )).toEqual({ kind: "none" });
    expect(classifyCodexRefreshOutput("ERROR codex_core::client: request failed status=429 Too Many Requests\n"))
      .toEqual({ kind: "none" });
    expect(classifyCodexRefreshOutput("the docs say invalid_grant and refresh_token_reused mean a sign-in\n"))
      .toEqual({ kind: "none" });
  });
});

describe("CodexOAuthRefresher", () => {
  let rigs: TestRig[] = [];
  afterEach(() => {
    for (const rig of rigs) cleanupRig(rig);
    rigs = [];
    vi.unstubAllEnvs();
  });

  const marginRig = (opts: { lateRotationWaitMs?: number; freshness?: number } = {}): TestRig => {
    const rig = buildRig({
      accounts: [makeAccount("codex-default")],
      initialFreshness: { "codex-default": opts.freshness ?? NOW + 40 * MINUTE },
      ...(opts.lateRotationWaitMs !== undefined ? { lateRotationWaitMs: opts.lateRotationWaitMs } : {}),
    });
    rigs.push(rig);
    return rig;
  };

  describe("on-demand refresh", () => {
    it("refreshes with one account/read call to app-server", async () => {
      const rig = marginRig();
      const rotatedTo = NOW + 10 * DAY;
      rig.spawnHandle.effects = [{ rotateTo: rotatedTo }];

      const [result] = await rig.refresher.refreshNow("codex-default");

      expect(result!.outcome).toBe("rotated");
      expect(result!.afterFreshness).toBe(Math.floor(rotatedTo / 1000) * 1000);
      expect(rig.spawnHandle.invocations).toHaveLength(1);
      const [invocation] = rig.spawnHandle.invocations;
      expect(invocation!.cmd).toBe("codex");
      expect(invocation!.args).toEqual([...CODEX_REFRESH_COMMAND]);
      expect(invocation!.sent).toEqual([
        CODEX_REFRESH_MESSAGES.initialize,
        CODEX_REFRESH_MESSAGES.initialized,
        CODEX_REFRESH_MESSAGES.refresh,
      ]);
      expect(CODEX_REFRESH_MESSAGES.refresh.params).toEqual({ refreshToken: true });
      expect(rig.repushCalls).toEqual([{ agentId: "codex", accountId: "codex-default" }]);
    });

    it("points the CLI at the account's own home, whatever the orchestrator's environment says", async () => {
      vi.stubEnv("CODEX_HOME", "/somewhere/else/.codex");
      vi.stubEnv("CODEX_API_KEY", "key-from-the-environment");
      const rig = marginRig();
      rig.spawnHandle.effects = [{ rotateTo: NOW + 10 * DAY }];

      await rig.refresher.refreshNow("codex-default");

      const accountRoot = accountRootOf(rig.rootDir, "codex-default");
      const [invocation] = rig.spawnHandle.invocations;
      expect(invocation!.cwd).toBe(accountRoot);
      expect(invocation!.env.HOME).toBe(accountRoot);
      expect(invocation!.env.CODEX_HOME).toBe(path.join(accountRoot, ".codex"));
      expect(invocation!.env.CODEX_API_KEY).toBeUndefined();
    });

    it("does not start the CLI for a token outside the margin", async () => {
      const rig = marginRig({ freshness: NOW + 9 * DAY });

      const [result] = await rig.refresher.refreshNow("codex-default");

      expect(result!.outcome).toBe("noop");
      expect(rig.spawnHandle.invocations).toHaveLength(0);
      expect(rig.repushCalls).toEqual([]);
    });

    it("treats last_refresh advancing as rotation", async () => {
      const rig = buildRig({
        accounts: [makeAccount("codex-default")],
        initialFreshness: { "codex-default": NOW + 5 * MINUTE },
        initialMode: "last_refresh",
      });
      rigs.push(rig);
      rig.spawnHandle.effects = [{ rotateTo: NOW + 30 * MINUTE, rotateMode: "last_refresh" }];

      const [result] = await rig.refresher.refreshNow("codex-default");

      expect(result!.outcome).toBe("rotated");
      expect(rig.repushCalls).toEqual([{ agentId: "codex", accountId: "codex-default" }]);
    });

    it("does not take a request from the CLI for the answer it waits for", async () => {
      const rig = marginRig();
      rig.spawnHandle.effects = [{ serverRequestFirst: true, rotateTo: NOW + 10 * DAY, delayMs: 30 }];

      const [result] = await rig.refresher.refreshNow("codex-default");

      expect(result!.outcome).toBe("rotated");
    });

    it("reads new tokens as a rotation when their expiry is the same", async () => {
      const freshness = NOW + 40 * MINUTE;
      const rig = marginRig({ freshness });
      rig.spawnHandle.effects = [{ rotateTo: freshness, rotateMark: "same-expiry" }];

      const [result] = await rig.refresher.refreshNow("codex-default");

      expect(result!.outcome).toBe("rotated");
      expect(rig.repushCalls).toEqual([{ agentId: "codex", accountId: "codex-default" }]);
    });

    it("reads an answer that arrives in pieces, and ignores output that is no message", async () => {
      const rig = marginRig();
      rig.spawnHandle.effects = [{ rotateTo: NOW + 10 * DAY, splitAnswer: true, junkStdout: 'null\n42\n"text"\nnot json\n' }];

      // Raced, so that a listener that throws is an assertion here and not a test that never ends.
      const result = await Promise.race([
        rig.refresher.refreshNow("codex-default"),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 1_000)),
      ]);

      expect(rig.spawnHandle.invocations[0]!.listenerErrors).toEqual([]);
      expect(result?.[0]?.outcome).toBe("rotated");
    });

    it("reads a refusal that arrives after the CLI's exit", async () => {
      const rig = marginRig();
      rig.spawnHandle.effects = [{ stderrAfterExit: INVALIDATED }];

      const [result] = await rig.refresher.refreshNow("codex-default");

      expect(result!.outcome).toBe("revoked");
    });

    it("reports a CLI that ends without an answer, and one that answers with an error", async () => {
      const rig = marginRig();
      rig.spawnHandle.effects = [{ noReply: true }, { rpcError: `Method not found for ${ACCOUNT_EMAIL}` }];

      const [ended] = await rig.refresher.refreshNow("codex-default");
      const [refused] = await rig.refresher.refreshNow("codex-default");

      expect(ended!.outcome).toBe("unknown_failure");
      expect(ended!.reason).toContain("[no-reply]");
      expect(refused!.outcome).toBe("unknown_failure");
      expect(refused!.reason).toContain("[rpc-error] account/read failed with code -32601");
      expect(refused!.reason).not.toContain(ACCOUNT_EMAIL);
    });

    it("reports a CLI that cannot start, and one that ends before the first answer", async () => {
      const rig = marginRig();
      rig.spawnHandle.effects = [{ spawnThrows: true }, { failsToStart: true }, { exitsBeforeInit: true }];
      const reasons: (string | undefined)[] = [];

      for (let run = 0; run < 3; run++) {
        // Raced, so that a call that never settles is an assertion here and not a test that never ends.
        const result = await Promise.race([
          rig.refresher.refreshNow("codex-default"),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 1_000)),
        ]);
        reasons.push(result?.[0]?.reason);
      }

      expect(reasons[0]).toContain("[spawn-failed] spawn EAGAIN");
      expect(reasons[1]).toContain("[error] spawn codex ENOENT");
      expect(reasons[2]).toContain("[no-reply]");
    });

    it("does not read a later expiry without tokens as a rotation, or as a heal", async () => {
      const rig = marginRig();
      rig.spawnHandle.effects = [{ writesTokenlessFile: NOW + 10 * DAY }];
      const forced = marginRig({ freshness: NOW + 9 * DAY });
      forced.spawnHandle.effects = [{ writesTokenlessFile: NOW + 10 * DAY }];

      const [result] = await rig.refresher.refreshNow("codex-default");

      expect(result!.outcome).toBe("unknown_failure");
      expect(rig.repushCalls).toEqual([]);
      expect(await forced.refresher.ensureFresh("codex-default", { force: true })).toBe(false);
    });

    it("kills a CLI that does not answer, and goes on when the CLI ignores the kill", async () => {
      vi.useFakeTimers();
      try {
        const rig = marginRig();
        rig.spawnHandle.effects = [{ hang: true }, { hang: true, ignoresKill: true }];
        vi.mocked(killProcessTree).mockClear();

        const stopped = rig.refresher.refreshNow("codex-default");
        await vi.advanceTimersByTimeAsync(31_000);
        // Before the await: without the kill, only the 5 s fallback ends this call.
        expect(vi.mocked(killProcessTree)).toHaveBeenCalledTimes(1);
        expect(vi.mocked(killProcessTree).mock.calls[0]![1]).toBe("SIGKILL");
        const [result] = await stopped;

        expect(result!.outcome).toBe("unknown_failure");
        expect(result!.reason).toContain("[timeout]");

        const ignored = rig.refresher.refreshNow("codex-default");
        await vi.advanceTimersByTimeAsync(40_000);
        expect((await ignored)[0]!.reason).toContain("[timeout]");
        expect(vi.mocked(killProcessTree)).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not act on an answer that arrives after it gave up", async () => {
      vi.useFakeTimers();
      try {
        const rig = marginRig();
        rig.spawnHandle.effects = [{ ignoresKill: true, delayMs: 45_000 }];
        vi.mocked(killProcessTree).mockClear();

        const pending = rig.refresher.refreshNow("codex-default");
        await vi.advanceTimersByTimeAsync(36_000);
        expect((await pending)[0]!.reason).toContain("[timeout]");
        await vi.advanceTimersByTimeAsync(30_000);

        expect(vi.mocked(killProcessTree)).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("logs why a refresh failed, without a token and without the account's email", async () => {
      const rig = marginRig();
      const bearer = jwtWithExp(NOW + DAY, "leaked");
      rig.spawnHandle.effects = [{
        stderr: `${SERVER_ERROR}Authorization: Bearer ${bearer}\nERROR codex_login: refresh failed for ${ACCOUNT_EMAIL}\n`,
      }];
      const logs = captureLogs();
      let result: CodexRefreshResult | undefined;
      try {
        [result] = await rig.refresher.refreshNow("codex-default");
      } finally {
        logs.restore();
      }

      expect(result!.outcome).toBe("unknown_failure");
      const line = logs.lines.find((entry) => entry.includes("unknown_failure failure_count=1 — short backoff"));
      expect(line).toContain('reason="');
      expect(line).toContain("status=500 Internal Server Error");
      expect(line).toContain("refresh failed for [email]");
      for (const text of [line!, result!.reason!]) {
        expect(text).not.toContain(bearer);
        expect(text).not.toContain(ACCOUNT_EMAIL);
      }
      // Nothing of the CLI's answers, which name the account, also when the CLI logged nothing.
      const [silent] = await rig.refresher.refreshNow("codex-default");
      expect(silent!.reason).toBe("no CLI output");
    });

    it("classifies a 429 from the token host as rate_limited and schedules backoff", async () => {
      const rig = marginRig();
      rig.spawnHandle.effects = [{ stderr: RATE_LIMITED }];

      const [result] = await rig.refresher.refreshNow("codex-default");

      expect(result!.outcome).toBe("rate_limited");
      expect(rig.refresher._inspectForTest("codex-default").failureCount).toBe(1);
      expect(rig.refresher._inspectForTest("codex-default").hasTimer).toBe(true);
      expect(rig.sseCalls.find((c) => c.event === "agent_auth_failed")).toBeUndefined();
    });
  });

  describe("a rejected grant", () => {
    it("reports revoked once, and does not spend the rejected grant again", async () => {
      const rig = marginRig();
      rig.spawnHandle.effects = [{ stderr: REUSED }];

      const [result] = await rig.refresher.refreshNow("codex-default");
      const [again] = await rig.refresher.refreshNow("codex-default");

      expect(result!.outcome).toBe("revoked");
      expect(result!.reason).toBe("refresh_token_reused");
      expect(again!.outcome).toBe("revoked");
      expect(again!.reason).toBe("refresh_token_reused");
      expect(rig.spawnHandle.invocations).toHaveLength(1);
      expect(rig.sseCalls.filter((c) => c.event === "codex_account_unauthenticated")).toHaveLength(1);
      expect(rig.sseCalls).toContainEqual({
        event: "agent_auth_failed",
        data: { loginId: "openai-chatgpt", accountId: "codex-default", reason: "revoked" },
      });
    });

    it("does not read a rejected credential with time left as a new sign-in", async () => {
      const rig = marginRig({ freshness: NOW + 9 * DAY });
      rig.spawnHandle.effects = [{ stderr: INVALIDATED }];

      expect(await rig.refresher.ensureFresh("codex-default", { force: true })).toBe(false);
      const [later] = await rig.refresher.refreshNow("codex-default");

      expect(later!.outcome).toBe("revoked");
      expect(rig.spawnHandle.invocations).toHaveLength(1);
      expect(rig.sseCalls.some((c) => c.event === "codex_account_authenticated")).toBe(false);
      expect(rig.refresher._inspectForTest("codex-default").emittedUnauthenticated).toBe(true);
    });

    it("refreshes again after a new sign-in, and reports the account authenticated", async () => {
      const rig = marginRig();
      rig.spawnHandle.effects = [{ stderr: EXPIRED }, { rotateTo: NOW + 10 * DAY }];
      const reauthEvents: string[] = [];
      rig.refresher.on("account_reauthenticated", (accountId: string) => reauthEvents.push(accountId));

      await rig.refresher.refreshNow("codex-default");
      expect(reauthEvents).toEqual([]);
      writeAuth(accountRootOf(rig.rootDir, "codex-default"), { freshness: NOW + 30 * MINUTE, mark: "signed-in" });
      const [result] = await rig.refresher.refreshNow("codex-default");

      expect(result!.outcome).toBe("rotated");
      expect(rig.spawnHandle.invocations).toHaveLength(2);
      expect(rig.sseCalls.some((c) => c.event === "codex_account_authenticated")).toBe(true);
      expect(reauthEvents).toEqual(["codex-default"]);
    });

    it("harvests a session rotation that is written after the refusal", async () => {
      const rig = marginRig({ lateRotationWaitMs: 300 });
      const rotatedTo = NOW + 10 * DAY;
      rig.spawnHandle.effects = [{
        stderr: REUSED,
        onRefresh: () => {
          setTimeout(() => writeSessionAuth(rig.rootDir, "sess-a", { freshness: rotatedTo, accountId: "codex-default" }), 50);
        },
      }];

      const [result] = await rig.refresher.refreshNow("codex-default");

      expect(result!.outcome).toBe("harvested_session");
      expect(sourceMark(rig.rootDir, "codex-default")).toBe("rt_session-sess-a");
      expect(rig.sseCalls.find((c) => c.event === "agent_auth_failed")).toBeUndefined();
      expect(rig.repushCalls).toEqual([{ agentId: "codex", accountId: "codex-default" }]);
    });

    it("does not report a source that was replaced during the wait", async () => {
      const freshness = NOW + 40 * MINUTE;
      const rig = marginRig({ lateRotationWaitMs: 300, freshness });
      rig.spawnHandle.effects = [{
        stderr: REUSED,
        onRefresh: () => {
          // The same expiry, so that only the credential's identity tells the two apart.
          setTimeout(() => writeAuth(accountRootOf(rig.rootDir, "codex-default"), { freshness, mark: "published" }), 50);
        },
      }];

      const [result] = await rig.refresher.refreshNow("codex-default");

      expect(result!.outcome).toBe("noop");
      expect(rig.sseCalls.find((c) => c.event === "agent_auth_failed")).toBeUndefined();
      expect(rig.refresher._inspectForTest("codex-default").hasTimer).toBe(true);
    });

    it("does not wait for a session when the server says the grant itself is invalid", async () => {
      const rig = marginRig({ lateRotationWaitMs: 1_500 });
      rig.spawnHandle.effects = [{ stderr: INVALIDATED }];

      const started = Date.now();
      const [result] = await rig.refresher.refreshNow("codex-default");

      expect(result!.outcome).toBe("revoked");
      expect(result!.reason).toBe("refresh_token_invalidated");
      expect(Date.now() - started).toBeLessThan(1_000);
    });

    it("per-account isolation: a revoked account does not affect a healthy account", async () => {
      const rig = buildRig({
        accounts: [makeAccount("acct-a"), makeAccount("acct-b", { isPrimary: false })],
        initialFreshness: { "acct-a": NOW + 5 * MINUTE, "acct-b": NOW + 9 * DAY },
      });
      rigs.push(rig);
      rig.spawnHandle.effects = [{ stderr: REUSED }];

      const results = await rig.refresher.refreshNow();
      const byId: Record<string, CodexRefreshResult> = {};
      for (const r of results) byId[r.accountId] = r;

      expect(byId["acct-a"]!.outcome).toBe("revoked");
      expect(byId["acct-b"]!.outcome).toBe("noop");
      expect(rig.refresher._inspectForTest("acct-a").emittedUnauthenticated).toBe(true);
      expect(rig.refresher._inspectForTest("acct-b").emittedUnauthenticated).toBe(false);
    });
  });

  describe("harvest before spend", () => {
    it("adopts a pinned session's newer token and never starts the CLI", async () => {
      const rig = marginRig();
      const rotatedTo = NOW + 10 * DAY;
      writeSessionAuth(rig.rootDir, "sess-a", { freshness: rotatedTo, accountId: "codex-default" });

      const [result] = await rig.refresher.refreshNow("codex-default");

      expect(result!.outcome).toBe("harvested_session");
      expect(result!.afterFreshness).toBe(Math.floor(rotatedTo / 1000) * 1000);
      expect(rig.spawnHandle.invocations).toHaveLength(0);
      expect(sourceMark(rig.rootDir, "codex-default")).toBe("rt_session-sess-a");
      expect(rig.repushCalls).toEqual([{ agentId: "codex", accountId: "codex-default" }]);
    });

    it("ignores a session copy that is behind the source", async () => {
      const rig = marginRig();
      writeSessionAuth(rig.rootDir, "sess-a", { freshness: NOW + 5 * MINUTE, accountId: "codex-default" });
      rig.spawnHandle.effects = [{ rotateTo: NOW + 10 * DAY }];

      const [result] = await rig.refresher.refreshNow("codex-default");

      expect(result!.outcome).toBe("rotated");
      expect(sourceMark(rig.rootDir, "codex-default")).not.toContain("session-");
    });

    it("ignores a newer copy whose marker names another account, or no account", async () => {
      const rig = marginRig();
      writeSessionAuth(rig.rootDir, "sess-a", { freshness: NOW + 10 * DAY, accountId: "acct-2" });
      writeSessionAuth(rig.rootDir, "sess-b", { freshness: NOW + 11 * DAY, accountId: null });
      rig.spawnHandle.effects = [{ rotateTo: NOW + 8 * DAY }];

      const [result] = await rig.refresher.refreshNow("codex-default");

      expect(result!.outcome).toBe("rotated");
      expect(sourceMark(rig.rootDir, "codex-default")).not.toContain("session-");
    });

    it("skips a session whose subtree escapes into another account's root", async () => {
      const rig = buildRig({
        accounts: [makeAccount("acct-1"), makeAccount("acct-2")],
        initialFreshness: { "acct-1": NOW + 10 * MINUTE, "acct-2": NOW + 10 * DAY },
      });
      rigs.push(rig);
      const sessionDir = path.join(rig.rootDir, "sessions", "sess-a");
      fs.mkdirSync(sessionDir, { recursive: true });
      writeSessionAccountMarker(rig.rootDir, "sess-a", "codex", "acct-1");
      fs.symlinkSync(path.join(accountRootOf(rig.rootDir, "acct-2"), ".codex"), path.join(sessionDir, ".codex"));
      rig.spawnHandle.effects = [{ rotateTo: NOW + 8 * DAY }];

      const [result] = await rig.refresher.refreshNow("acct-1");

      expect(result!.outcome).toBe("rotated");
      expect(sourceMark(rig.rootDir, "acct-1")).not.toBe(sourceMark(rig.rootDir, "acct-2"));
    });
  });

  describe("turn start", () => {
    it("runs nothing for a token outside the margin", async () => {
      const rig = marginRig({ freshness: NOW + 60 * MINUTE });

      expect(await rig.refresher.ensureFresh("codex-default")).toBe(true);
      expect(rig.spawnHandle.invocations).toHaveLength(0);
    });

    it("refreshes a token inside the margin", async () => {
      const rig = marginRig();
      rig.spawnHandle.effects = [{ rotateTo: NOW + 10 * DAY }];

      expect(await rig.refresher.ensureFresh("codex-default")).toBe(true);
      expect(rig.spawnHandle.invocations).toHaveLength(1);
    });

    it("leaves the retry to the schedule while a backoff is in force", async () => {
      const rig = marginRig();
      rig.spawnHandle.effects = [{ stderr: RATE_LIMITED }, { rotateTo: NOW + 10 * DAY }];

      expect(await rig.refresher.ensureFresh("codex-default")).toBe(true);
      expect(await rig.refresher.ensureFresh("codex-default")).toBe(true);
      expect(rig.spawnHandle.invocations).toHaveLength(1);

      // The backoff's own tick is not a turn start, and a turn start after it is free again.
      rig.clock.now = NOW + 3 * MINUTE;
      expect(await rig.refresher.ensureFresh("codex-default")).toBe(true);
      expect(rig.spawnHandle.invocations).toHaveLength(2);
    });

    it("ends the backoff when a refresh succeeds", async () => {
      const rig = marginRig();
      // The new token is inside the margin too, so the next turn start has a refresh to do.
      rig.spawnHandle.effects = [{ stderr: RATE_LIMITED }, { rotateTo: NOW + 41 * MINUTE }, { rotateTo: NOW + 10 * DAY }];

      await rig.refresher.refreshNow("codex-default");
      await rig.refresher.refreshNow("codex-default");

      expect(await rig.refresher.ensureFresh("codex-default")).toBe(true);
      expect(rig.spawnHandle.invocations).toHaveLength(3);
    });

    it("returns false for an expired token while a backoff is in force", async () => {
      const rig = marginRig({ freshness: NOW + 30_000 });
      rig.spawnHandle.effects = [{ stderr: SERVER_ERROR }];

      expect(await rig.refresher.ensureFresh("codex-default")).toBe(true);
      rig.clock.now = NOW + 45_000;

      expect(await rig.refresher.ensureFresh("codex-default")).toBe(false);
      expect(rig.spawnHandle.invocations).toHaveLength(1);
    });

    it("returns false for a grant that is known rejected, without the CLI", async () => {
      const rig = marginRig({ freshness: NOW + 9 * DAY });
      rig.spawnHandle.effects = [{ stderr: REUSED }];
      await rig.refresher.ensureFresh("codex-default", { force: true });

      expect(await rig.refresher.ensureFresh("codex-default")).toBe(false);
      expect(rig.spawnHandle.invocations).toHaveLength(1);
    });

    it("returns false for a grant that was rejected while a backoff is in force", async () => {
      const rig = marginRig();
      rig.spawnHandle.effects = [{ stderr: RATE_LIMITED }, { stderr: INVALIDATED }];

      expect(await rig.refresher.ensureFresh("codex-default")).toBe(true);
      expect(await rig.refresher.ensureFresh("codex-default", { force: true })).toBe(false);

      expect(await rig.refresher.ensureFresh("codex-default")).toBe(false);
      expect(rig.spawnHandle.invocations).toHaveLength(2);
    });

    it("returns false without a tick when the source cannot be read", async () => {
      const rig = buildRig({ accounts: [makeAccount("codex-default")] });
      rigs.push(rig);

      expect(await rig.refresher.ensureFresh("codex-default")).toBe(false);
      expect(await rig.refresher.ensureFresh("codex-default", { force: true })).toBe(false);
      expect(rig.sseCalls).toEqual([]);
    });
  });

  describe("forced heal (a session's 401)", () => {
    it("heals a source with time left when the token host accepts the refresh", async () => {
      const rig = marginRig({ freshness: NOW + 9 * DAY });
      rig.spawnHandle.effects = [{ rotateTo: NOW + 10 * DAY }];

      expect(await rig.refresher.ensureFresh("codex-default", { force: true })).toBe(true);
      expect(rig.spawnHandle.invocations).toHaveLength(1);
      expect(rig.repushCalls).toEqual([{ agentId: "codex", accountId: "codex-default" }]);
      expect(rig.refresher._inspectForTest("codex-default").failureCount).toBe(0);
    });

    it("heals a call that joins a tick after the tick wrote its rotation", async () => {
      const rig = marginRig();
      let joined: Promise<boolean> | undefined;
      rig.spawnHandle.effects = [{
        rotateTo: NOW + 10 * DAY,
        afterRotate: () => {
          joined = rig.refresher.ensureFresh("codex-default", { force: true });
        },
      }];

      await rig.refresher.refreshNow("codex-default");

      expect(await joined).toBe(true);
      expect(rig.spawnHandle.invocations).toHaveLength(1);
    });

    it("heals from a session's rotation without the CLI", async () => {
      const rig = marginRig({ freshness: NOW + 9 * DAY });
      writeSessionAuth(rig.rootDir, "sess-a", { freshness: NOW + 10 * DAY, accountId: "codex-default" });

      expect(await rig.refresher.ensureFresh("codex-default", { force: true })).toBe(true);
      expect(rig.spawnHandle.invocations).toHaveLength(0);
      expect(rig.repushCalls).toEqual([{ agentId: "codex", accountId: "codex-default" }]);
    });

    it("does not heal a rejected token whose expiry is in the future", async () => {
      const rig = marginRig({ freshness: NOW + 9 * DAY });
      rig.spawnHandle.effects = [{ stderr: REUSED }];

      expect(await rig.refresher.ensureFresh("codex-default", { force: true })).toBe(false);
      expect(rig.refresher._inspectForTest("codex-default").emittedUnauthenticated).toBe(true);
    });

    it("heals when the source holds another credential after the wait", async () => {
      const freshness = NOW + 9 * DAY;
      const rig = marginRig({ lateRotationWaitMs: 300, freshness });
      rig.spawnHandle.effects = [{
        stderr: REUSED,
        onRefresh: () => {
          setTimeout(() => writeAuth(accountRootOf(rig.rootDir, "codex-default"), { freshness, mark: "published" }), 50);
        },
      }];

      expect(await rig.refresher.ensureFresh("codex-default", { force: true })).toBe(true);
    });

    it("does not heal when the refresh gets no answer, and keeps the expiry schedule of a token with time left", async () => {
      const rig = marginRig({ freshness: NOW + 9 * DAY });
      rig.spawnHandle.effects = [{ stderr: RATE_LIMITED }];
      const logs = captureLogs();
      try {
        expect(await rig.refresher.ensureFresh("codex-default", { force: true })).toBe(false);
      } finally {
        logs.restore();
      }

      expect(rig.refresher._inspectForTest("codex-default").failureCount).toBe(0);
      expect(logs.lines.some((line) => line.includes("rate_limited on a forced refresh — expiry schedule kept"))).toBe(true);
      // No backoff is in force: a turn start inside the margin gets its refresh.
      rig.clock.now = NOW + 9 * DAY - 10 * MINUTE;
      rig.spawnHandle.effects[1] = { rotateTo: NOW + 20 * DAY };
      expect(await rig.refresher.ensureFresh("codex-default")).toBe(true);
      expect(rig.spawnHandle.invocations).toHaveLength(2);
    });
  });

  it("single-flight: concurrent calls share one Codex CLI invocation", async () => {
    const rig = marginRig();
    rig.spawnHandle.effects = [{ rotateTo: NOW + 10 * DAY, delayMs: 25 }];

    const [a, b] = await Promise.all([
      rig.refresher.refreshNow("codex-default"),
      rig.refresher.refreshNow("codex-default"),
    ]);

    expect(rig.spawnHandle.invocations).toHaveLength(1);
    expect(a[0]!.outcome).toBe("rotated");
    expect(b[0]!.outcome).toBe("rotated");
  });

  it("start schedules known accounts and stop cancels timers", () => {
    vi.useFakeTimers();
    try {
      const rig = buildRig({
        accounts: [makeAccount("acct-a"), makeAccount("acct-b")],
        initialFreshness: { "acct-a": NOW + 60 * MINUTE, "acct-b": NOW + 60 * MINUTE },
      });
      rigs.push(rig);

      rig.refresher.start();
      expect(rig.refresher._inspectForTest("acct-a").hasTimer).toBe(true);
      expect(rig.refresher._inspectForTest("acct-b").hasTimer).toBe(true);
      rig.refresher.stop();
      expect(rig.refresher._inspectForTest("acct-a").hasTimer).toBe(false);
      expect(rig.refresher._inspectForTest("acct-b").hasTimer).toBe(false);
      vi.advanceTimersByTime(2 * 60 * MINUTE);
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
    writeAuth(accountRoot, { freshness: Date.now() + 60 * MINUTE });
    const spawnHandle = makeFakeSpawn();
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

  it("marks missing source credentials unauthenticated once and recovers after re-auth", async () => {
    const rig = buildRig({
      accounts: [makeAccount("codex-default")],
    });
    rigs.push(rig);

    const unauthenticated: string[] = [];
    const reauthenticated: string[] = [];
    rig.refresher.on("account_unauthenticated", (accountId: string) => unauthenticated.push(accountId));
    rig.refresher.on("account_reauthenticated", (accountId: string) => reauthenticated.push(accountId));

    const [result] = await rig.refresher.refreshNow("codex-default");
    await rig.refresher.refreshNow("codex-default");
    expect(result!.outcome).toBe("missing_credentials");
    expect(rig.spawnHandle.invocations).toHaveLength(0);
    expect(rig.repushCalls).toEqual([]);
    expect(unauthenticated).toEqual(["codex-default"]);
    expect(rig.sseCalls).toContainEqual({
      event: "agent_auth_failed",
      data: { loginId: "openai-chatgpt", accountId: "codex-default", reason: "missing_credentials" },
    });
    expect(rig.sseCalls.filter((call) => call.event === "agent_auth_failed")).toHaveLength(1);

    writeAuth(accountRootOf(rig.rootDir, "codex-default"), { freshness: NOW + 14 * DAY });
    await rig.refresher.refreshNow("codex-default");
    expect(reauthenticated).toEqual(["codex-default"]);
    expect(rig.repushCalls).toEqual([{ agentId: "codex", accountId: "codex-default" }]);
    expect(rig.refresher._inspectForTest("codex-default").emittedUnauthenticated).toBe(false);
  });
});
