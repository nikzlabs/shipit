/**
 * CodexAuthManager unit tests.
 *
 * Drives the manager with a fake `spawn` so we can deterministically replay
 * the stdout/stderr the real `codex login --device-auth` produces, plus
 * malformed and error variants. The credentials-on-disk check is also
 * injected so the suite doesn't need to touch /credentials.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import {
  CodexAuthManager,
  USER_CODE_PATTERN,
  VERIFICATION_URL_PATTERN,
  extractCodexPlan,
  type CodexAuthFailedEvent,
  type CodexAuthPendingEvent,
  type SpawnFn,
} from "./auth-manager.js";

/** Build a fake JWT (header.payload.signature) carrying the OpenAI auth claim. */
function fakeJwt(authClaim: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64({ "https://api.openai.com/auth": authClaim })}.sig`;
}

// ---------------------------------------------------------------------------
// Fake child_process
// ---------------------------------------------------------------------------

/**
 * Minimal stand-in for a ChildProcess. Only implements what the manager
 * touches: stdout / stderr Readable streams, an `on("close" | "error")`
 * registration, and a `kill()` method.
 */
class FakeChildProcess extends EventEmitter {
  pid = 12345;
  stdout = new Readable({ read() { /* no-op */ } });
  stderr = new Readable({ read() { /* no-op */ } });
  killed = false;
  kill(_signal?: NodeJS.Signals | number): boolean {
    this.killed = true;
    return true;
  }
}

interface SpawnContext {
  proc: FakeChildProcess;
  spawnFn: SpawnFn;
  /** Calls captured (command, args). */
  calls: { cmd: string; args: readonly string[] }[];
}

function makeSpawn(): SpawnContext {
  const proc = new FakeChildProcess();
  const calls: SpawnContext["calls"] = [];
  const spawnFn: SpawnFn = (cmd, args) => {
    calls.push({ cmd, args });
    return proc as unknown as ChildProcess;
  };
  return { proc, spawnFn, calls };
}

/** Push a chunk onto a Readable so the manager's listener fires synchronously. */
function emitStdout(stream: Readable, text: string): void {
  stream.push(Buffer.from(text, "utf-8"));
}

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Regex sanity checks
// ---------------------------------------------------------------------------

describe("extractCodexPlan", () => {
  it("reads and title-cases the chatgpt_plan_type claim from the id token", () => {
    const auth = { tokens: { id_token: fakeJwt({ chatgpt_plan_type: "plus" }) } };
    expect(extractCodexPlan(auth)).toBe("Plus");
  });

  it("maps known tiers to their display names", () => {
    expect(extractCodexPlan({ tokens: { id_token: fakeJwt({ chatgpt_plan_type: "pro" }) } })).toBe("Pro");
    expect(extractCodexPlan({ tokens: { id_token: fakeJwt({ chatgpt_plan_type: "enterprise" }) } })).toBe("Enterprise");
  });

  it("falls back to the access token when the id token lacks the claim", () => {
    const auth = { tokens: { access_token: fakeJwt({ chatgpt_plan_type: "free" }) } };
    expect(extractCodexPlan(auth)).toBe("Free");
  });

  it("returns null when no plan claim is present", () => {
    expect(extractCodexPlan({ tokens: { id_token: fakeJwt({ chatgpt_account_id: "acct-1" }) } })).toBeNull();
    expect(extractCodexPlan({})).toBeNull();
    expect(extractCodexPlan({ tokens: { id_token: "not.a.jwt-with-bad-payload" } })).toBeNull();
  });
});

describe("CodexAuthManager / regex", () => {
  it("USER_CODE_PATTERN matches XXXX-XXXXX", () => {
    expect("K8RE-8MIGC".match(USER_CODE_PATTERN)?.[1]).toBe("K8RE-8MIGC");
  });

  it("USER_CODE_PATTERN ignores unrelated tokens", () => {
    expect("hello world".match(USER_CODE_PATTERN)).toBeNull();
    expect("abc-defgh".match(USER_CODE_PATTERN)).toBeNull(); // lowercase
    expect("AB-CDEFG".match(USER_CODE_PATTERN)).toBeNull(); // wrong shape
  });

  it("VERIFICATION_URL_PATTERN matches the canonical OpenAI device URL", () => {
    const text = "Open this link: https://auth.openai.com/codex/device and continue";
    expect(text.match(VERIFICATION_URL_PATTERN)?.[0]).toBe("https://auth.openai.com/codex/device");
  });

  it("VERIFICATION_URL_PATTERN tolerates query string suffixes", () => {
    const text = "https://auth.openai.com/codex/device?foo=bar";
    expect(text.match(VERIFICATION_URL_PATTERN)?.[0]).toBe("https://auth.openai.com/codex/device?foo=bar");
  });
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

describe("CodexAuthManager / startDeviceFlow", () => {
  it("spawns codex login --device-auth", () => {
    const { spawnFn, calls } = makeSpawn();
    const mgr = new CodexAuthManager({ spawn: spawnFn, checkAuthFile: () => false });
    mgr.startDeviceFlow();
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe("codex");
    expect(calls[0].args).toEqual(["login", "--device-auth"]);
  });

  it("emits codex_auth_pending with URL + code parsed from stdout", async () => {
    const { proc, spawnFn } = makeSpawn();
    const mgr = new CodexAuthManager({ spawn: spawnFn, checkAuthFile: () => false });
    const pending = new Promise<CodexAuthPendingEvent>((resolve) => {
      mgr.once("codex_auth_pending", (ev: CodexAuthPendingEvent) => resolve(ev));
    });

    mgr.startDeviceFlow();
    emitStdout(
      proc.stdout,
      "Welcome to Codex\n\n1. Open this link\n   https://auth.openai.com/codex/device\n\n2. Enter this one-time code\n   K8RE-8MIGC\n",
    );

    const ev = await pending;
    expect(ev.verificationUri).toBe("https://auth.openai.com/codex/device");
    expect(ev.userCode).toBe("K8RE-8MIGC");
    expect(ev.expiresInSec).toBeGreaterThan(0);
  });

  it("emits codex_auth_pending only once even if URL/code re-printed", async () => {
    const { proc, spawnFn } = makeSpawn();
    const mgr = new CodexAuthManager({ spawn: spawnFn, checkAuthFile: () => false });
    const events: CodexAuthPendingEvent[] = [];
    mgr.on("codex_auth_pending", (ev: CodexAuthPendingEvent) => events.push(ev));

    mgr.startDeviceFlow();
    emitStdout(proc.stdout, "https://auth.openai.com/codex/device\nK8RE-8MIGC\n");
    emitStdout(proc.stdout, "https://auth.openai.com/codex/device\nK8RE-8MIGC\n");
    // Let the Readable flush through to data listeners.
    await new Promise((r) => setImmediate(r));
    expect(events).toHaveLength(1);
  });

  it("strips ANSI escape codes before regex matching", async () => {
    const { proc, spawnFn } = makeSpawn();
    const mgr = new CodexAuthManager({ spawn: spawnFn, checkAuthFile: () => false });
    const pending = new Promise<CodexAuthPendingEvent>((resolve) => {
      mgr.once("codex_auth_pending", (ev: CodexAuthPendingEvent) => resolve(ev));
    });
    mgr.startDeviceFlow();
    // Bold / colored output the CLI sometimes emits.
    emitStdout(proc.stdout, "\x1b[1mhttps://auth.openai.com/codex/device\x1b[0m\n\x1b[33mK8RE-8MIGC\x1b[0m\n");
    const ev = await pending;
    expect(ev.verificationUri).toBe("https://auth.openai.com/codex/device");
    expect(ev.userCode).toBe("K8RE-8MIGC");
  });

  it("emits codex_auth_complete on exit code 0 + credentials on disk", async () => {
    const { proc, spawnFn } = makeSpawn();
    let credsOnDisk = false;
    const mgr = new CodexAuthManager({ spawn: spawnFn, checkAuthFile: () => credsOnDisk });
    const complete = new Promise<void>((resolve) => mgr.once("codex_auth_complete", () => resolve()));

    mgr.startDeviceFlow();
    credsOnDisk = true;
    proc.emit("close", 0);

    await complete;
  });

  it("emits codex_auth_failed when exit 0 but no credentials written", async () => {
    const { proc, spawnFn } = makeSpawn();
    const mgr = new CodexAuthManager({ spawn: spawnFn, checkAuthFile: () => false });
    const failed = new Promise<CodexAuthFailedEvent>((resolve) => {
      mgr.once("codex_auth_failed", (ev: CodexAuthFailedEvent) => resolve(ev));
    });
    mgr.startDeviceFlow();
    proc.emit("close", 0);
    const ev = await failed;
    expect(ev.reason).toBe("error");
    expect(ev.message).toMatch(/credentials/i);
  });

  it("emits codex_auth_failed on non-zero exit", async () => {
    const { proc, spawnFn } = makeSpawn();
    const mgr = new CodexAuthManager({ spawn: spawnFn, checkAuthFile: () => false });
    const failed = new Promise<CodexAuthFailedEvent>((resolve) => {
      mgr.once("codex_auth_failed", (ev: CodexAuthFailedEvent) => resolve(ev));
    });
    mgr.startDeviceFlow();
    proc.emit("close", 1);
    const ev = await failed;
    expect(ev.reason).toBe("error");
    expect(ev.message).toMatch(/code 1/);
  });

  it("emits codex_auth_failed when spawn throws", () => {
    const failingSpawn: SpawnFn = () => {
      throw new Error("ENOENT");
    };
    const mgr = new CodexAuthManager({ spawn: failingSpawn, checkAuthFile: () => false });
    const events: CodexAuthFailedEvent[] = [];
    mgr.on("codex_auth_failed", (ev: CodexAuthFailedEvent) => events.push(ev));
    mgr.startDeviceFlow();
    expect(events).toHaveLength(1);
    expect(events[0].reason).toBe("error");
    expect(events[0].message).toBe("ENOENT");
  });

  it("does nothing when called twice in a row", () => {
    const { spawnFn, calls } = makeSpawn();
    const mgr = new CodexAuthManager({ spawn: spawnFn, checkAuthFile: () => false });
    mgr.startDeviceFlow();
    mgr.startDeviceFlow();
    expect(calls).toHaveLength(1);
  });

  // Regression: page reload mid-flow used to leave the Sign-in button dead
  // because (a) the server's `proc` was still polling, so a second
  // `startDeviceFlow()` no-op'd, and (b) the original `codex_auth_pending`
  // event was already consumed by the previous browser tab. Now the manager
  // re-emits the cached pending event so a fresh click after reload swaps
  // the UI back to the Step 1 / Step 2 view.
  it("re-emits the cached pending event when start is called against a running flow", async () => {
    const { proc, spawnFn } = makeSpawn();
    const mgr = new CodexAuthManager({ spawn: spawnFn, checkAuthFile: () => false });
    const events: CodexAuthPendingEvent[] = [];
    mgr.on("codex_auth_pending", (ev: CodexAuthPendingEvent) => events.push(ev));

    mgr.startDeviceFlow();
    emitStdout(
      proc.stdout,
      "https://auth.openai.com/codex/device\nK8RE-8MIGC\n",
    );
    await new Promise((r) => setImmediate(r));
    expect(events).toHaveLength(1);

    // Second click — simulates the user hitting "Sign in" after a page
    // reload. The manager must re-broadcast so the new UI catches up.
    mgr.startDeviceFlow();
    expect(events).toHaveLength(2);
    expect(events[1]).toEqual(events[0]);
  });

  it("getPendingEvent returns the live event while in-flight and null otherwise", async () => {
    const { proc, spawnFn } = makeSpawn();
    const mgr = new CodexAuthManager({ spawn: spawnFn, checkAuthFile: () => false });
    expect(mgr.getPendingEvent()).toBeNull();

    mgr.startDeviceFlow();
    // No URL/code yet — still null.
    expect(mgr.getPendingEvent()).toBeNull();

    emitStdout(proc.stdout, "https://auth.openai.com/codex/device\nK8RE-8MIGC\n");
    await new Promise((r) => setImmediate(r));
    const snap = mgr.getPendingEvent();
    expect(snap).not.toBeNull();
    expect(snap?.verificationUri).toBe("https://auth.openai.com/codex/device");
    expect(snap?.userCode).toBe("K8RE-8MIGC");

    mgr.cancel();
    expect(mgr.getPendingEvent()).toBeNull();
  });

  it("clears the cached pending event on successful completion", async () => {
    const { proc, spawnFn } = makeSpawn();
    let credsOnDisk = false;
    const mgr = new CodexAuthManager({ spawn: spawnFn, checkAuthFile: () => credsOnDisk });
    const complete = new Promise<void>((resolve) => mgr.once("codex_auth_complete", () => resolve()));

    mgr.startDeviceFlow();
    emitStdout(proc.stdout, "https://auth.openai.com/codex/device\nK8RE-8MIGC\n");
    await new Promise((r) => setImmediate(r));
    expect(mgr.getPendingEvent()).not.toBeNull();

    credsOnDisk = true;
    proc.emit("close", 0);
    await complete;
    expect(mgr.getPendingEvent()).toBeNull();
  });

  it("emits codex_auth_failed with reason=timeout after the device-code TTL", async () => {
    vi.useFakeTimers();
    const { proc, spawnFn } = makeSpawn();
    const mgr = new CodexAuthManager({
      spawn: spawnFn,
      checkAuthFile: () => false,
      timeoutMs: 1000,
    });
    const failed = new Promise<CodexAuthFailedEvent>((resolve) => {
      mgr.once("codex_auth_failed", (ev: CodexAuthFailedEvent) => resolve(ev));
    });
    mgr.startDeviceFlow();
    vi.advanceTimersByTime(1001);
    const ev = await failed;
    expect(ev.reason).toBe("timeout");
    expect(proc.killed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Cancel + signOut
// ---------------------------------------------------------------------------

describe("CodexAuthManager / cancel + signOut", () => {
  it("cancel kills the running process and is idempotent", () => {
    const { proc, spawnFn } = makeSpawn();
    const mgr = new CodexAuthManager({ spawn: spawnFn, checkAuthFile: () => false });
    mgr.startDeviceFlow();
    expect(mgr.pending).toBe(true);
    mgr.cancel();
    expect(proc.killed).toBe(true);
    expect(mgr.pending).toBe(false);
    // Second call must not throw.
    expect(() => mgr.cancel()).not.toThrow();
  });

  it("cancel suppresses any pending failure event", async () => {
    const { proc, spawnFn } = makeSpawn();
    const mgr = new CodexAuthManager({ spawn: spawnFn, checkAuthFile: () => false });
    let failedFired = false;
    mgr.on("codex_auth_failed", () => { failedFired = true; });
    mgr.startDeviceFlow();
    mgr.cancel();
    // After cancel, the underlying process firing 'close' should be a no-op
    // because the listener was removed. Re-emit anyway to verify.
    proc.emit("close", 0);
    await new Promise((r) => setImmediate(r));
    expect(failedFired).toBe(false);
  });

  it("checkCredentials reflects the injected check", () => {
    let v = false;
    const { spawnFn } = makeSpawn();
    const mgr = new CodexAuthManager({ spawn: spawnFn, checkAuthFile: () => v });
    expect(mgr.checkCredentials()).toBe(false);
    v = true;
    expect(mgr.checkCredentials()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Account-scoped flows (docs/150)
// ---------------------------------------------------------------------------

describe("CodexAuthManager / account-scoped (docs/150)", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-codex-scoped-"));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  /** Spawn fake that also captures the per-call options (env, etc.). */
  function makeSpawnWithOpts(): { proc: FakeChildProcess; spawnFn: SpawnFn; opts: Parameters<SpawnFn>[2][] } {
    const proc = new FakeChildProcess();
    const opts: Parameters<SpawnFn>[2][] = [];
    const spawnFn: SpawnFn = (_cmd, _args, options) => {
      opts.push(options);
      return proc as unknown as ChildProcess;
    };
    return { proc, spawnFn, opts };
  }

  it("spawns the CLI with HOME pointed at the account credential root", () => {
    const { spawnFn, opts } = makeSpawnWithOpts();
    const mgr = new CodexAuthManager({ spawn: spawnFn, checkAuthFile: () => false });
    mgr.start({ accountId: "acct-1", credentialDir: tmp });
    expect(opts).toHaveLength(1);
    expect((opts[0]?.env as Record<string, string>).HOME).toBe(tmp);
    expect(mgr.getActiveAccountId()).toBe("acct-1");
  });

  it("checkCredentials reads the account's auth.json, ignoring the injected singleton check", () => {
    const { spawnFn } = makeSpawnWithOpts();
    const mgr = new CodexAuthManager({ spawn: spawnFn, checkAuthFile: () => true });
    // No file yet → scoped check is false even though the singleton check is true.
    expect(mgr.checkCredentials(tmp)).toBe(false);
    fs.mkdirSync(path.join(tmp, ".codex"), { recursive: true });
    fs.writeFileSync(path.join(tmp, ".codex", "auth.json"), "{}");
    expect(mgr.checkCredentials(tmp)).toBe(true);
    // The singleton path is unaffected.
    expect(mgr.checkCredentials()).toBe(true);
  });

  it("completes scoped, exposing the account id during the complete event then clearing it", async () => {
    const { proc, spawnFn } = makeSpawnWithOpts();
    const mgr = new CodexAuthManager({ spawn: spawnFn, checkAuthFile: () => false });
    fs.mkdirSync(path.join(tmp, ".codex"), { recursive: true });
    fs.writeFileSync(path.join(tmp, ".codex", "auth.json"), "{}");

    let observed: string | null = "unset";
    mgr.on("complete", () => { observed = mgr.getActiveAccountId(); });
    mgr.start({ accountId: "acct-9", credentialDir: tmp });
    proc.emit("close", 0);
    await new Promise((r) => setImmediate(r));

    expect(observed).toBe("acct-9");
    // Scope is cleared after the terminal event.
    expect(mgr.getActiveAccountId()).toBeNull();
  });

  it("signOut(credentialDir) removes only the account's auth.json", () => {
    const { spawnFn } = makeSpawnWithOpts();
    const mgr = new CodexAuthManager({ spawn: spawnFn, checkAuthFile: () => false });
    fs.mkdirSync(path.join(tmp, ".codex"), { recursive: true });
    const authPath = path.join(tmp, ".codex", "auth.json");
    fs.writeFileSync(authPath, "{}");
    mgr.signOut({ credentialDir: tmp });
    expect(fs.existsSync(authPath)).toBe(false);
  });
});
