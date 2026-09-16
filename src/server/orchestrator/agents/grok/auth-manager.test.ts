import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import {
  XaiAuthManager,
  USER_CODE_PATTERN,
  VERIFICATION_URL_PATTERN,
  extractXaiAccessToken,
  extractXaiIdentity,
  grokAuthFileFor,
  grokConfigDirFor,
  readXaiTokenFreshness,
  readXaiTokenFreshnessFile,
  type SpawnFn,
  type XaiAuthPendingEvent,
} from "./auth-manager.js";
import type { AgentAuthLogPayload, AgentAuthProgressPayload } from "../auth-diagnostics.js";

// Captured from Grok 1.0.1 on 2026-08-19, including ANSI escapes.
const REAL_STDERR = `
To sign in, open this URL in your browser:

  https://accounts.x.ai/oauth2/device?user_code=NSJF-75ZB

  (Could not open browser automatically — open the URL above manually.)

Confirm this code in your browser:

  NSJF-75ZB

[90mOnly continue with a code you requested. Don't share it with anyone.[0m

Waiting for authorization...
`;

class FakeChildProcess extends EventEmitter {
  pid = 4242;
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
  calls: { cmd: string; args: readonly string[]; env: Record<string, string> }[];
}

function makeSpawn(): SpawnContext {
  const proc = new FakeChildProcess();
  const calls: SpawnContext["calls"] = [];
  const spawnFn: SpawnFn = (cmd, args, options) => {
    calls.push({ cmd, args, env: (options?.env ?? {}) as Record<string, string> });
    return proc as unknown as ChildProcess;
  };
  return { proc, spawnFn, calls };
}

function emit(stream: Readable, text: string): void {
  stream.push(Buffer.from(text, "utf-8"));
}

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "xai-auth-test-"));
}

afterEach(() => {
  vi.useRealTimers();
});

describe("parsing the device-code challenge", () => {
  it("matches the URL and the four-and-four code in the real stderr", () => {
    expect(VERIFICATION_URL_PATTERN.exec(REAL_STDERR)?.[0]).toBe(
      "https://accounts.x.ai/oauth2/device?user_code=NSJF-75ZB",
    );
    expect(USER_CODE_PATTERN.exec(REAL_STDERR)?.[1]).toBe("NSJF-75ZB");
  });

  it("does not match a Codex-shaped four-and-five code", () => {
    expect(USER_CODE_PATTERN.exec("ABCD-EFGHI")?.[1]).toBeUndefined();
  });

  it("emits the challenge from STDERR, which is the only stream the CLI uses", async () => {
    const { proc, spawnFn } = makeSpawn();
    const mgr = new XaiAuthManager({ spawn: spawnFn, checkAuthFile: () => false });
    const pending: XaiAuthPendingEvent[] = [];
    mgr.on("xai_auth_pending", (ev: XaiAuthPendingEvent) => pending.push(ev));
    const normalized: unknown[] = [];
    mgr.on("pending", (details: unknown) => normalized.push(details));

    mgr.start({ accountId: "acct_1", credentialDir: tempRoot() });
    emit(proc.stderr, REAL_STDERR);
    await new Promise((r) => setImmediate(r));

    expect(pending).toHaveLength(1);
    expect(pending[0].verificationUri).toBe("https://accounts.x.ai/oauth2/device?user_code=NSJF-75ZB");
    expect(pending[0].userCode).toBe("NSJF-75ZB");
    expect(normalized).toEqual([
      { kind: "device-code", verificationUri: pending[0].verificationUri, userCode: "NSJF-75ZB", expiresInSec: 900 },
    ]);
    expect(mgr.getPendingPayload()).toEqual({ kind: "device-code", ...pending[0] });
    mgr.cancel();
  });

  it("emits the challenge only once however the output is chunked", async () => {
    const { proc, spawnFn } = makeSpawn();
    const mgr = new XaiAuthManager({ spawn: spawnFn, checkAuthFile: () => false });
    const pending: XaiAuthPendingEvent[] = [];
    mgr.on("xai_auth_pending", (ev: XaiAuthPendingEvent) => pending.push(ev));

    mgr.start({ accountId: "acct_1", credentialDir: tempRoot() });
    emit(proc.stderr, REAL_STDERR.slice(0, 60));
    await new Promise((r) => setImmediate(r));
    expect(pending).toHaveLength(0);
    emit(proc.stderr, REAL_STDERR.slice(60));
    await new Promise((r) => setImmediate(r));
    expect(pending).toHaveLength(1);
    emit(proc.stderr, "Waiting for authorization...\n");
    await new Promise((r) => setImmediate(r));
    expect(pending).toHaveLength(1);
    mgr.cancel();
  });
});

describe("scoping the flow to one account", () => {
  it("points GROK_HOME at the account's .grok directory, not the home above it", () => {
    const { spawnFn, calls } = makeSpawn();
    const root = tempRoot();
    const mgr = new XaiAuthManager({ spawn: spawnFn, checkAuthFile: () => false });

    mgr.start({ accountId: "acct_1", credentialDir: root });

    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe("grok");
    expect(calls[0].args).toEqual(["login", "--device-auth"]);
    expect(calls[0].env.HOME).toBe(root);
    expect(calls[0].env.GROK_HOME).toBe(path.join(root, ".grok"));
    expect(grokConfigDirFor(root)).toBe(path.join(root, ".grok"));
    expect(grokAuthFileFor(root)).toBe(path.join(root, ".grok", "auth.json"));
    expect(fs.existsSync(path.join(root, ".grok"))).toBe(true);
    mgr.cancel();
  });

  it("scrubs the environment credentials that would redirect the CLI", () => {
    const { spawnFn, calls } = makeSpawn();
    const prior = {
      XAI_API_KEY: process.env.XAI_API_KEY,
      GROK_AUTH: process.env.GROK_AUTH,
      GROK_AUTH_PATH: process.env.GROK_AUTH_PATH,
    };
    process.env.XAI_API_KEY = "a-metered-key";
    process.env.GROK_AUTH = "/somewhere/else/auth.json";
    process.env.GROK_AUTH_PATH = "/somewhere/else";
    try {
      const mgr = new XaiAuthManager({ spawn: spawnFn, checkAuthFile: () => false });
      mgr.start({ accountId: "acct_1", credentialDir: tempRoot() });
      expect(calls[0].env.XAI_API_KEY).toBeUndefined();
      expect(calls[0].env.GROK_AUTH).toBeUndefined();
      expect(calls[0].env.GROK_AUTH_PATH).toBeUndefined();
      mgr.cancel();
    } finally {
      if (prior.XAI_API_KEY === undefined) delete process.env.XAI_API_KEY;
      else process.env.XAI_API_KEY = prior.XAI_API_KEY;
      if (prior.GROK_AUTH === undefined) delete process.env.GROK_AUTH;
      else process.env.GROK_AUTH = prior.GROK_AUTH;
      if (prior.GROK_AUTH_PATH === undefined) delete process.env.GROK_AUTH_PATH;
      else process.env.GROK_AUTH_PATH = prior.GROK_AUTH_PATH;
    }
  });
});

describe("the flow's terminal states", () => {
  it("completes only when the CLI exits 0 AND the credentials landed", async () => {
    const root = tempRoot();
    const { proc, spawnFn } = makeSpawn();
    const mgr = new XaiAuthManager({ spawn: spawnFn });
    const events: string[] = [];
    mgr.on("complete", () => events.push("complete"));
    mgr.on("failed", () => events.push("failed"));

    mgr.start({ accountId: "acct_1", credentialDir: root });
    proc.emit("close", 0);
    await new Promise((r) => setImmediate(r));
    expect(events).toEqual(["failed"]);

    const { proc: proc2, spawnFn: spawn2 } = makeSpawn();
    const mgr2 = new XaiAuthManager({ spawn: spawn2 });
    const events2: string[] = [];
    let accountAtComplete: string | null = null;
    mgr2.on("complete", () => {
      events2.push("complete");
      accountAtComplete = mgr2.getActiveAccountId();
    });
    mgr2.on("failed", () => events2.push("failed"));
    mgr2.start({ accountId: "acct_2", credentialDir: root });
    fs.writeFileSync(grokAuthFileFor(root), JSON.stringify({ scope: { access_token: "t" } }));
    proc2.emit("close", 0);
    await new Promise((r) => setImmediate(r));
    expect(events2).toEqual(["complete"]);
    expect(accountAtComplete).toBe("acct_2");
    expect(mgr2.getActiveAccountId()).toBeNull();
  });

  it("times out and kills the CLI so it cannot poll forever", async () => {
    vi.useFakeTimers();
    const { proc, spawnFn } = makeSpawn();
    const mgr = new XaiAuthManager({ spawn: spawnFn, checkAuthFile: () => false, timeoutMs: 1_000 });
    const failures: ({ reason?: string } | undefined)[] = [];
    mgr.on("failed", (payload) => { failures.push(payload); });

    mgr.start({ accountId: "acct_1", credentialDir: tempRoot() });
    vi.advanceTimersByTime(1_000);

    expect(failures).toEqual([{ reason: "timeout", message: "Device code expired" }]);
    expect(proc.killed).toBe(true);
  });

  it("re-broadcasts the cached challenge instead of starting a second CLI", async () => {
    const { proc, spawnFn, calls } = makeSpawn();
    const mgr = new XaiAuthManager({ spawn: spawnFn, checkAuthFile: () => false });
    const pending: XaiAuthPendingEvent[] = [];

    mgr.start({ accountId: "acct_1", credentialDir: tempRoot() });
    emit(proc.stderr, REAL_STDERR);
    await new Promise((r) => setImmediate(r));

    mgr.on("xai_auth_pending", (ev: XaiAuthPendingEvent) => pending.push(ev));
    mgr.start({ accountId: "acct_1", credentialDir: tempRoot() });
    expect(calls).toHaveLength(1);
    expect(pending).toHaveLength(1);
    expect(pending[0].userCode).toBe("NSJF-75ZB");
    mgr.cancel();
  });

  it("signs out by removing that account's auth.json and nothing else", () => {
    const rootA = tempRoot();
    const rootB = tempRoot();
    fs.mkdirSync(grokConfigDirFor(rootA), { recursive: true });
    fs.mkdirSync(grokConfigDirFor(rootB), { recursive: true });
    fs.writeFileSync(grokAuthFileFor(rootA), "{}");
    fs.writeFileSync(grokAuthFileFor(rootB), "{}");

    const mgr = new XaiAuthManager({ spawn: makeSpawn().spawnFn });
    mgr.signOut({ credentialDir: rootA });

    expect(fs.existsSync(grokAuthFileFor(rootA))).toBe(false);
    expect(fs.existsSync(grokAuthFileFor(rootB))).toBe(true);
    expect(() => mgr.signOut({ credentialDir: rootA })).not.toThrow();
  });
});

describe("reading a scope-keyed auth.json", () => {
  // Captured on 2026-08-19 with secrets replaced.
  const real = {
    "https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828": {
      key: `${Buffer.from(JSON.stringify({ typ: "at+jwt" })).toString("base64url")}.`
        + `${Buffer.from(JSON.stringify({ exp: 1_787_168_273, tier: 1, principal_type: "User" })).toString("base64url")}.sig`,
      auth_mode: "oidc",
      create_time: "2026-08-19T13:37:53.982150334Z",
      user_id: "eb48b549-2c2a-4f56-aef2-543179bd88fe",
      email: "someone@example.com",
      first_name: "Nik",
      last_name: "Zherebtsov",
      principal_type: "User",
      team_id: "cc0429e2-fd03-412c-956a-f721824b551e",
      refresh_token: "REDACTED-REFRESH-TOKEN",
      expires_at: "2026-08-19T19:37:53.982150334Z",
      oidc_issuer: "https://auth.x.ai",
    },
  };

  it("finds the token and identity under a URL-shaped scope key", () => {
    expect(extractXaiAccessToken(real)).toBe(real["https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828"].key);
    expect(extractXaiIdentity(real)).toEqual({
      externalId: "eb48b549-2c2a-4f56-aef2-543179bd88fe",
      email: "someone@example.com",
    });
  });

  it("parses the ISO-8601 expires_at the CLI really writes", () => {
    expect(readXaiTokenFreshness(real)).toBe(Date.parse("2026-08-19T19:37:53.982Z"));
    const lifetimeMs = Date.parse(real["https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828"].expires_at)
      - Date.parse(real["https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828"].create_time);
    expect(lifetimeMs).toBe(6 * 60 * 60 * 1000);
  });

  it("falls back to the access token's JWT exp when no expiry field parses", () => {
    const scope = { ...real["https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828"] };
    delete (scope as Partial<typeof scope>).expires_at;
    expect(readXaiTokenFreshness({ s: scope })).toBe(1_787_168_273_000);
  });

  it("accepts a flat top-level record too, so a layout change degrades rather than breaks", () => {
    expect(extractXaiAccessToken({ key: "tok-flat" })).toBe("tok-flat");
    expect(extractXaiIdentity({ access_token: "t", user_id: "u-1" })).toEqual({ externalId: "u-1" });
  });

  it("keys identity on user_id, and reports none when there is no id", () => {
    expect(extractXaiIdentity({ s: { key: "t", email: "a@b.c" } })).toBeNull();
    expect(extractXaiIdentity({ s: { user_id: "u-2" } })).toEqual({ externalId: "u-2" });
  });

  it("reports no freshness for an unparseable file rather than a fake one", () => {
    const file = path.join(tempRoot(), "auth.json");
    expect(readXaiTokenFreshnessFile(file)).toBeNull();
    fs.writeFileSync(file, "not json at all");
    expect(readXaiTokenFreshnessFile(file)).toBeNull();
    fs.writeFileSync(file, JSON.stringify({ s: { key: "not-a-jwt" } }));
    expect(readXaiTokenFreshnessFile(file)).toBeNull();
    fs.writeFileSync(file, JSON.stringify({ s: { expires_at: 1_800_000_000 } }));
    expect(readXaiTokenFreshnessFile(file)).toBe(1_800_000_000_000);
  });
});

/**
 * The sign-in diagnostics panel in Settings renders whatever a manager reports,
 * for any harness. This one reported nothing: a `grok login` that failed left
 * the user `grok login exited with code 1`, while the CLI's own explanation
 * went to the orchestrator log, truncated at 500 characters, where no user can
 * read it.
 */
describe("what the Grok sign-in reports to the panel", () => {
  const URL = "https://accounts.x.ai/oauth2/device";
  const settle = () => new Promise((r) => setImmediate(r));
  /** Empty, so `credentials=absent` is the real answer rather than a stub's. */
  const diagDir = tempRoot;

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
    const mgr = new XaiAuthManager({ spawn: spawnFn, checkAuthFile: () => false });
    const logs: AgentAuthLogPayload[] = [];
    const progress: AgentAuthProgressPayload[] = [];
    mgr.on("log", (p) => logs.push(p));
    mgr.on("progress", (p) => progress.push(p));
    mgr.startDeviceFlow({ accountId: "acct-1", credentialDir: diagDir() });
    return { proc, mgr, logs, progress, panel: () => logs.map((l) => l.message).join("\n") };
  }

  /**
   * Grok 1.0.1 prints everything — the challenge included — on stderr, so a
   * stderr line here is ordinary progress. The source says which stream it came
   * from; levelling it `error` would paint a healthy sign-in red.
   */
  it("relays stderr as ordinary output, scoped to this login and account", async () => {
    const { proc, logs } = startWithDiagnostics();
    emit(proc.stderr, "Waiting for authorization...\n");
    await settle();

    const line = logs.find((l) => l.message === "Waiting for authorization...");
    expect(line?.source).toBe("cli_stderr");
    expect(line?.level).toBe("info");
    expect(line).toMatchObject({ loginId: "xai-oauth", accountId: "acct-1" });
    expect(line?.attemptId).toBeTruthy();
  });

  /** The real thing, ANSI escapes and all: neither secret may reach the panel. */
  it("keeps the code and the link's query string out of the real captured stderr", async () => {
    const { proc, panel } = startWithDiagnostics();
    emit(proc.stderr, REAL_STDERR);
    await settle();

    expect(panel(), "leaked the device code").not.toContain("NSJF-75ZB");
    expect(panel()).toContain("[code-redacted]");
    // The link is all query string; the usable one is the challenge's button.
    expect(panel()).toContain("Only continue with a code you requested");
  });

  /**
   * The heart of it: every redaction protecting this panel is a whole-STRING
   * rule, so relaying a chunk at a time defeats them. A device code split
   * anywhere stops matching the pattern that removes it.
   */
  it("redacts a device code the CLI's output split across two chunks", async () => {
    const { proc, logs, panel } = startWithDiagnostics();
    emit(proc.stderr, "  NSJF");
    emit(proc.stderr, "-75ZB\n");
    await settle();

    expect(panel()).toContain("[code-redacted]");
    // Not just "the whole code is absent": a chunk relay would emit the two
    // halves as separate entries, and joining them would hide that.
    expect(logs.some((l) => /NSJF|75ZB/.test(l.message)), "leaked half the code").toBe(false);
  });

  it("redacts a verification URL's query string when the split lands inside it", async () => {
    const { proc, panel } = startWithDiagnostics();
    // `device_code`, not `state`: no assignment rule names it and it is under the
    // long-secret threshold, so ONLY the URL rule can remove it.
    const url = `${URL}?user_code=AAAA-BBBB&device_code=private-grant`;
    const at = url.indexOf("&dev") + 4;
    emit(proc.stderr, `open this URL: ${url.slice(0, at)}`);
    emit(proc.stderr, `${url.slice(at)}\n`);
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
    emit(proc.stderr, `  ${URL}?user_code=NSJF-75ZB&device_code=private-grant\n`);
    await settle();

    expect(panel(), "leaked a parameter after the redacted code").not.toContain("private-grant");
    expect(panel()).not.toContain("NSJF-75ZB");
  });

  /**
   * A CLI that hangs part-way through its last sentence is exactly the failure
   * whose explanation has no newline after it — and the timeout path kills the
   * process with `killProc`, which detaches the `close` handler that flushes.
   */
  it("flushes the unterminated final line when the flow times out", async () => {
    const { proc, spawnFn } = makeSpawn();
    const mgr = new XaiAuthManager({ spawn: spawnFn, checkAuthFile: () => false, timeoutMs: 20 });
    const logs: AgentAuthLogPayload[] = [];
    mgr.on("log", (p) => logs.push(p));
    mgr.on("failed", () => { /* the timeout's own failure */ });
    mgr.startDeviceFlow({ accountId: "acct-1", credentialDir: diagDir() });
    emit(proc.stderr, "Error: this account cannot use Grok Build.");
    await new Promise((r) => setTimeout(r, 60));

    expect(logs.map((l) => l.message).join("\n"))
      .toContain("Error: this account cannot use Grok Build.");
  });

  /** A CLI's last word — the sentence explaining a failure — carries no newline. */
  it("flushes the unterminated final line when the process exits", async () => {
    const { proc, panel } = startWithDiagnostics();
    emit(proc.stderr, "Error: this account cannot use Grok Build.");
    await settle();
    proc.emit("close", 1);
    await settle();

    expect(panel()).toContain("Error: this account cannot use Grok Build.");
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
   * A cancelled run keeps draining — `cancel()` detaches `close` and `error`,
   * never `data` — and by then the manager may be running the NEXT account's
   * flow, so unguarded output lands on that account's panel and its expired
   * challenge is replayed as that account's code.
   */
  it("ignores a cancelled run's output instead of charging it to the next account", async () => {
    const { procs, spawnFn } = makeSpawnPerCall();
    const mgr = new XaiAuthManager({ spawn: spawnFn, checkAuthFile: () => false });
    mgr.startDeviceFlow({ accountId: "acct-1", credentialDir: diagDir() });
    const stale = procs[0];
    mgr.cancel();

    mgr.startDeviceFlow({ accountId: "acct-2", credentialDir: diagDir() });
    const logs: AgentAuthLogPayload[] = [];
    const pending: XaiAuthPendingEvent[] = [];
    mgr.on("log", (p) => logs.push(p));
    mgr.on("xai_auth_pending", (ev: XaiAuthPendingEvent) => pending.push(ev));
    emit(stale.stderr, REAL_STDERR);
    await settle();

    expect(logs, "charged a dead run's output to the next account").toEqual([]);
    expect(pending, "replayed the cancelled run's challenge").toEqual([]);
  });

  it("says where the sign-in has got to, before and after the challenge arrives", async () => {
    const { proc, progress } = startWithDiagnostics();
    expect(progress.map((p) => p.phase)).toEqual(["starting", "waiting_for_url"]);
    expect(progress[0]).toMatchObject({ loginId: "xai-oauth", accountId: "acct-1" });

    emit(proc.stderr, REAL_STDERR);
    await settle();
    expect(progress.at(-1)).toMatchObject({ phase: "waiting_for_code" });
  });
});
