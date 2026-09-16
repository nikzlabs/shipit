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
import type { AgentAuthLogPayload, AgentAuthProgressPayload } from "../auth-diagnostics.js";

function fakeJwt(authClaim: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64({ "https://api.openai.com/auth": authClaim })}.sig`;
}

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

function emitStdout(stream: Readable, text: string): void {
  stream.push(Buffer.from(text, "utf-8"));
}

afterEach(() => {
  vi.useRealTimers();
});

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
    expect("abc-defgh".match(USER_CODE_PATTERN)).toBeNull();
    expect("AB-CDEFG".match(USER_CODE_PATTERN)).toBeNull();
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

    mgr.startDeviceFlow();
    expect(events).toHaveLength(2);
    expect(events[1]).toEqual(events[0]);
  });

  it("getPendingEvent returns the live event while in-flight and null otherwise", async () => {
    const { proc, spawnFn } = makeSpawn();
    const mgr = new CodexAuthManager({ spawn: spawnFn, checkAuthFile: () => false });
    expect(mgr.getPendingEvent()).toBeNull();

    mgr.startDeviceFlow();
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

describe("CodexAuthManager / cancel + signOut", () => {
  it("cancel kills the running process and is idempotent", () => {
    const { proc, spawnFn } = makeSpawn();
    const mgr = new CodexAuthManager({ spawn: spawnFn, checkAuthFile: () => false });
    mgr.startDeviceFlow();
    expect(mgr.pending).toBe(true);
    mgr.cancel();
    expect(proc.killed).toBe(true);
    expect(mgr.pending).toBe(false);
    expect(() => mgr.cancel()).not.toThrow();
  });

  it("cancel suppresses any pending failure event", async () => {
    const { proc, spawnFn } = makeSpawn();
    const mgr = new CodexAuthManager({ spawn: spawnFn, checkAuthFile: () => false });
    let failedFired = false;
    mgr.on("codex_auth_failed", () => { failedFired = true; });
    mgr.startDeviceFlow();
    mgr.cancel();
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

describe("CodexAuthManager / account-scoped (docs/150)", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-codex-scoped-"));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

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
    expect(mgr.checkCredentials(tmp)).toBe(false);
    fs.mkdirSync(path.join(tmp, ".codex"), { recursive: true });
    fs.writeFileSync(path.join(tmp, ".codex", "auth.json"), "{}");
    expect(mgr.checkCredentials(tmp)).toBe(true);
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

/**
 * The sign-in diagnostics panel in Settings renders whatever a manager reports,
 * for any harness. This one reported nothing: a `codex login` that failed left
 * the user `codex login exited with code 1`, while the CLI's own explanation
 * went to the orchestrator log, truncated at 500 characters, where no user can
 * read it.
 */
describe("what the Codex sign-in reports to the panel", () => {
  const URL = "https://auth.openai.com/codex/device";
  const settle = () => new Promise((r) => setImmediate(r));
  /** Empty, so `credentials=absent` is the real answer rather than a stub's. */
  const diagDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "codex-auth-diag-"));

  /** `makeSpawn` reuses one process; a stale-run test needs a fresh one each time. */
  function makeSpawnPerCall(): { procs: FakeChildProcess[]; spawnFn: SpawnFn } {
    const procs: FakeChildProcess[] = [];
    const spawnFn: SpawnFn = () => {
      const proc = new FakeChildProcess();
      procs.push(proc);
      return proc as unknown as ChildProcess;
    };
    return { procs, spawnFn };
  }

  function startWithDiagnostics() {
    const { proc, spawnFn } = makeSpawn();
    const mgr = new CodexAuthManager({ spawn: spawnFn, checkAuthFile: () => false });
    const logs: AgentAuthLogPayload[] = [];
    const progress: AgentAuthProgressPayload[] = [];
    mgr.on("log", (p) => logs.push(p));
    mgr.on("progress", (p) => progress.push(p));
    mgr.startDeviceFlow({ accountId: "acct-1", credentialDir: diagDir() });
    return { proc, mgr, logs, progress, panel: () => logs.map((l) => l.message).join("\n") };
  }

  it("relays the CLI's own output, scoped to this login and account", async () => {
    const { proc, logs } = startWithDiagnostics();
    emitStdout(proc.stdout, "Welcome to Codex\n");
    await settle();

    const cli = logs.filter((l) => l.source === "cli_stdout");
    expect(cli.map((l) => l.message)).toContain("Welcome to Codex");
    expect(cli[0]).toMatchObject({ loginId: "openai-chatgpt", accountId: "acct-1" });
    expect(cli[0]?.attemptId).toBeTruthy();
  });

  /**
   * `codex login` writes to both streams, so a stderr line is ordinary progress
   * and not a failure. The source says which stream; the level must not claim
   * the line was an error.
   */
  it("labels stderr by its stream without levelling it an error", async () => {
    const { proc, logs } = startWithDiagnostics();
    emitStdout(proc.stderr, "Opening your browser…\n");
    await settle();

    const line = logs.find((l) => l.message === "Opening your browser…");
    expect(line?.source).toBe("cli_stderr");
    expect(line?.level).toBe("info");
  });

  /**
   * The heart of it: every redaction protecting this panel is a whole-STRING
   * rule, so relaying a chunk at a time defeats them. A device code split
   * anywhere stops matching the pattern that removes it, and a URL split inside
   * its query string leaves the second half looking like ordinary text.
   */
  it("redacts a device code the CLI's output split across two chunks", async () => {
    const { proc, logs, panel } = startWithDiagnostics();
    emitStdout(proc.stdout, "   K8RE");
    emitStdout(proc.stdout, "-8MIGC\n");
    await settle();

    expect(panel()).toContain("[code-redacted]");
    // Not just "the whole code is absent": a chunk relay would emit the two
    // halves as separate entries, and joining them would hide that.
    expect(logs.some((l) => /K8RE|8MIGC/.test(l.message)), "leaked half the code").toBe(false);
  });

  it("redacts a verification URL's query string when the split lands inside it", async () => {
    const { proc, panel } = startWithDiagnostics();
    // `device_code`, not `state`: no assignment rule names it and it is under the
    // long-secret threshold, so ONLY the URL rule can remove it.
    const url = `${URL}?foo=bar&device_code=private-grant`;
    const at = url.indexOf("&dev") + 4;
    emitStdout(proc.stdout, `Open this link: ${url.slice(0, at)}`);
    emitStdout(proc.stdout, `${url.slice(at)}\n`);
    await settle();

    expect(panel(), "leaked the link's query string").not.toContain("private-grant");
  });

  /**
   * The marker is substituted into the line the URL rule then has to match, so
   * it must contain no whitespace: a URL ends at the first space, and a spaced
   * marker inside a link truncates what the sanitizer sees, publishing every
   * query parameter after the code in the clear.
   */
  it("does not let the code's removal expose the query parameters after it", async () => {
    const { proc, panel } = startWithDiagnostics();
    emitStdout(proc.stdout, `   ${URL}?user_code=K8RE-8MIGC&device_code=private-grant\n`);
    await settle();

    expect(panel(), "leaked a parameter after the redacted code").not.toContain("private-grant");
    expect(panel()).not.toContain("K8RE-8MIGC");
  });

  /**
   * The order is the guarantee, not the three steps. An escape sequence sitting
   * INSIDE the code hides its shape from the pattern, so the strip has to come
   * first — and the code has to go before the generic rules, which may rewrite
   * the text it sits in.
   *
   * Driven through the spawn failure rather than the CLI's output on purpose:
   * that is the one path to the emitter that does NOT pass the relay, so it is
   * where the emitter's own strip is the only thing standing between an escape
   * and the panel. Everything the CLI prints arrives already stripped.
   */
  it("removes a code an escape sequence is sitting in the middle of", () => {
    const failingSpawn: SpawnFn = () => {
      throw new Error("spawn failed near K8RE\x1b[0m-8MIGC");
    };
    const mgr = new CodexAuthManager({ spawn: failingSpawn, checkAuthFile: () => false });
    const logs: AgentAuthLogPayload[] = [];
    mgr.on("log", (p) => logs.push(p));
    mgr.on("failed", () => { /* the spawn's own failure */ });
    mgr.startDeviceFlow({ accountId: "acct-1", credentialDir: diagDir() });

    const panel = logs.map((l) => l.message).join("\n");
    expect(panel, "an escape inside the code hid it from the pattern").not.toContain("8MIGC");
    expect(panel).toContain("[code-redacted]");
  });

  /**
   * The escape sequence can straddle a chunk boundary, and each half is
   * unrecognisable alone — so `\x1b[90m` stays glued to the text, `m` is a word
   * character, and the `\b` the code pattern needs is gone.
   *
   * **This is an end-to-end guard, not a one-line one.** Two layers stop it
   * independently — the relay strips ANSI off the assembled line, and the
   * redaction runs after the sanitizer rather than before — so it goes red only
   * when BOTH are lost. Each layer has its own single-line guard elsewhere; this
   * pins the property the user actually has.
   */
  it("redacts a code an ANSI sequence split across two chunks would have exposed", async () => {
    const { proc, panel } = startWithDiagnostics();
    emitStdout(proc.stdout, "   \x1b[9");
    emitStdout(proc.stdout, "0mK8RE-8MIGC\x1b[0m\n");
    await settle();

    expect(panel(), "an ANSI split exposed the code").not.toContain("K8RE-8MIGC");
    expect(panel()).toContain("[code-redacted]");
  });

  /**
   * A CLI that hangs part-way through its last sentence is exactly the failure
   * whose explanation has no newline after it — and the timeout path kills the
   * process with `killProc`, which detaches the `close` handler that flushes.
   */
  it("flushes the unterminated final line when the flow times out", async () => {
    const { proc, spawnFn } = makeSpawn();
    const mgr = new CodexAuthManager({ spawn: spawnFn, checkAuthFile: () => false, timeoutMs: 20 });
    const logs: AgentAuthLogPayload[] = [];
    mgr.on("log", (p) => logs.push(p));
    mgr.on("failed", () => { /* the timeout's own failure */ });
    mgr.startDeviceFlow({ accountId: "acct-1", credentialDir: diagDir() });
    emitStdout(proc.stdout, "Error: your account is not eligible.");
    await new Promise((r) => setTimeout(r, 60));

    expect(logs.map((l) => l.message).join("\n")).toContain("Error: your account is not eligible.");
  });

  it("says the device code arrived without putting the link or the code in the panel", async () => {
    const { proc, panel } = startWithDiagnostics();
    emitStdout(proc.stdout, `${URL}\nK8RE-8MIGC\n`);
    await settle();

    expect(panel()).toContain("Device code received");
    expect(panel()).not.toContain("K8RE-8MIGC");
  });

  /** A CLI's last word — the sentence explaining a failure — carries no newline. */
  it("flushes the unterminated final line when the process exits", async () => {
    const { proc, panel } = startWithDiagnostics();
    emitStdout(proc.stdout, "Error: your account is not eligible.");
    await settle();
    proc.emit("close", 1);
    await settle();

    expect(panel()).toContain("Error: your account is not eligible.");
  });

  /**
   * The one line that says which branch the exit took. It was on the terminal
   * only, which the user cannot read — and a failure is exactly when they need it.
   */
  it("puts the line that explains the ending in the panel, not only the terminal", async () => {
    const { proc, logs } = startWithDiagnostics();
    proc.emit("close", 1);
    await settle();

    const ending = logs.find((l) => l.message.startsWith("sign-in ended"));
    expect(ending?.message).toContain("exit=1");
    expect(ending?.message).toContain("credentials=absent");
  });

  /**
   * `cancel()` detaches `close`, so the flush that path does never runs — and a
   * CLI that stopped part-way through its last sentence is exactly the failure
   * the user is cancelling to read about.
   */
  it("flushes the unterminated final line when the sign-in is cancelled", async () => {
    const { mgr, proc, panel } = startWithDiagnostics();
    emitStdout(proc.stdout, "Error: your account is not eligible.");
    await settle();

    mgr.cancel();

    expect(panel()).toContain("Error: your account is not eligible.");
  });

  /**
   * A cancelled run keeps draining — `cancel()` detaches `close` and `error`,
   * never `data` — and by then the manager may be running the NEXT account's
   * flow, so unguarded output lands on that account's panel and its expired
   * challenge is replayed as that account's code.
   */
  it("ignores a cancelled run's output instead of charging it to the next account", async () => {
    const { procs, spawnFn } = makeSpawnPerCall();
    const mgr = new CodexAuthManager({ spawn: spawnFn, checkAuthFile: () => false });
    mgr.startDeviceFlow({ accountId: "acct-1", credentialDir: diagDir() });
    const stale = procs[0];
    const logs: AgentAuthLogPayload[] = [];
    const pending: CodexAuthPendingEvent[] = [];
    mgr.on("log", (p) => logs.push(p));
    mgr.on("codex_auth_pending", (ev: CodexAuthPendingEvent) => pending.push(ev));

    // Both halves of the guard: every kill path clears `this.proc` BEFORE the
    // signal, so a dead run is already foreign whether or not a successor
    // exists — the identity compared is the process object, which a cancel
    // cannot leave stale the way an un-advanced generation counter can.
    mgr.cancel();
    emitStdout(stale.stdout, `stale line\n${URL}\nK8RE-8MIGC\n`);
    await settle();
    expect(logs, "a cancelled run kept reporting").toEqual([]);

    mgr.startDeviceFlow({ accountId: "acct-2", credentialDir: diagDir() });
    emitStdout(stale.stdout, `more stale\n${URL}\nK8RE-8MIGC\n`);
    await settle();

    expect(logs, "charged a dead run's output to the next account").toEqual([]);
    expect(pending, "replayed the cancelled run's challenge").toEqual([]);
  });

  it("says where the sign-in has got to, before and after the challenge arrives", async () => {
    const { proc, progress } = startWithDiagnostics();
    expect(progress.map((p) => p.phase)).toEqual(["starting", "waiting_for_url"]);
    expect(progress[0]).toMatchObject({ loginId: "openai-chatgpt", accountId: "acct-1" });

    emitStdout(proc.stdout, `${URL}\nK8RE-8MIGC\n`);
    await settle();
    expect(progress.at(-1)).toMatchObject({ phase: "waiting_for_code" });
  });
});
