/**
 * XaiAuthManager unit tests (planning#435).
 *
 * Drives the manager with a fake `spawn` so the real `grok login --device-auth`
 * output can be replayed deterministically, byte-shaped from a live capture.
 * Two facts about that output are what this suite exists to lock, because both
 * differ from the Codex flow the manager is otherwise modelled on: the challenge
 * arrives on **stderr**, and the user code is **four-and-four** rather than
 * four-and-five.
 */

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

/**
 * The exact bytes `grok login --device-auth` wrote to stderr in a live container
 * on 2026-08-19 (CLI 1.0.1), ANSI escape included. Replayed verbatim rather than
 * paraphrased: a paraphrase is a test of the paraphrase.
 */
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

// ---------------------------------------------------------------------------
// The challenge, as the CLI really prints it
// ---------------------------------------------------------------------------

describe("parsing the device-code challenge", () => {
  it("matches the URL and the four-and-four code in the real stderr", () => {
    expect(VERIFICATION_URL_PATTERN.exec(REAL_STDERR)?.[0]).toBe(
      "https://accounts.x.ai/oauth2/device?user_code=NSJF-75ZB",
    );
    expect(USER_CODE_PATTERN.exec(REAL_STDERR)?.[1]).toBe("NSJF-75ZB");
  });

  /**
   * The Codex pattern is `[A-Z0-9]{4}-[A-Z0-9]{5}`. Borrowing it here matches
   * nothing at all, so the manager would emit no challenge and time out fifteen
   * minutes later with the user staring at a dead button — a failure with no
   * error anywhere. This is the assertion that says the two are not
   * interchangeable.
   */
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
    // The normalized event is what the SSE wiring rebroadcasts; the client's
    // device-code card reads `kind` to decide which shape to render.
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
    // Split mid-URL, so a naive per-chunk match would find neither half.
    emit(proc.stderr, REAL_STDERR.slice(0, 60));
    await new Promise((r) => setImmediate(r));
    expect(pending).toHaveLength(0);
    emit(proc.stderr, REAL_STDERR.slice(60));
    await new Promise((r) => setImmediate(r));
    expect(pending).toHaveLength(1);
    // More output afterwards ("Waiting for authorization…" repeats) must not
    // re-announce a challenge the user is already looking at.
    emit(proc.stderr, "Waiting for authorization...\n");
    await new Promise((r) => setImmediate(r));
    expect(pending).toHaveLength(1);
    mgr.cancel();
  });
});

// ---------------------------------------------------------------------------
// Where the CLI is pointed
// ---------------------------------------------------------------------------

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
    // `GROK_HOME` IS the `.grok` dir (see `shared/agent-home.ts`). One level off
    // points the CLI at a config root beside its credentials, which surfaces as
    // "not authenticated" rather than as an error naming a path.
    expect(calls[0].env.GROK_HOME).toBe(path.join(root, ".grok"));
    expect(grokConfigDirFor(root)).toBe(path.join(root, ".grok"));
    expect(grokAuthFileFor(root)).toBe(path.join(root, ".grok", "auth.json"));
    // Created ahead of the spawn: the CLI writes the file but expects a parent.
    expect(fs.existsSync(path.join(root, ".grok"))).toBe(true);
    mgr.cancel();
  });

  /**
   * The scoped home is only as good as the environment around it. `XAI_API_KEY`
   * out-prefers the on-disk login and `GROK_AUTH` / `GROK_AUTH_PATH` redirect the
   * CLI at a different token store entirely — so a login run with any of them
   * inherited could write, or authenticate, somewhere no session ever reads.
   */
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

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

describe("the flow's terminal states", () => {
  it("completes only when the CLI exits 0 AND the credentials landed", async () => {
    const root = tempRoot();
    const { proc, spawnFn } = makeSpawn();
    const mgr = new XaiAuthManager({ spawn: spawnFn });
    const events: string[] = [];
    mgr.on("complete", () => events.push("complete"));
    mgr.on("failed", () => events.push("failed"));

    mgr.start({ accountId: "acct_1", credentialDir: root });
    // Exit 0 with nothing written is a FAILURE, not a success: the CLI can exit
    // cleanly on a cancelled browser tab.
    proc.emit("close", 0);
    await new Promise((r) => setImmediate(r));
    expect(events).toEqual(["failed"]);

    const { proc: proc2, spawnFn: spawn2 } = makeSpawn();
    const mgr2 = new XaiAuthManager({ spawn: spawn2 });
    const events2: string[] = [];
    let accountAtComplete: string | null = null;
    mgr2.on("complete", () => {
      events2.push("complete");
      // Read SYNCHRONOUSLY by the SSE wiring, so the scope must still be set
      // when the handler runs and cleared only after it returns.
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

    // A page reload mid-flow: the UI has lost the code and the CLI is still
    // polling, so a second `start` must replay rather than spawn.
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
    // Idempotent — sign-out runs from several paths.
    expect(() => mgr.signOut({ credentialDir: rootA })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Reading the credential file
// ---------------------------------------------------------------------------

describe("reading a scope-keyed auth.json", () => {
  /**
   * The REAL shape, from a live `grok login --device-auth` on 2026-08-19,
   * secrets replaced and everything else verbatim. Three details were each
   * guessed wrong before this file existed, and every one of them is a silent
   * failure rather than a loud one:
   *
   *   - the scope key is `https://auth.x.ai::<client-uuid>`, which no fixed-key
   *     reader could ever have matched;
   *   - the access token is `key`, not `access_token`;
   *   - `expires_at` is an ISO-8601 **string**, not a number.
   */
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

  /**
   * The ISO expiry, and this is the assertion that matters most in the file.
   *
   * A freshness reader that returns null does NOT fail safe: `syncAgentTokenIn`
   * skips its copy only when it can prove the session's token is at least as
   * fresh, so an unreadable expiry makes every sync copy unconditionally — and a
   * session that had just refreshed loses its live token to a stale source. The
   * first cut of the reader accepted only numeric expiries and so did exactly
   * that on every real file.
   */
  it("parses the ISO-8601 expires_at the CLI really writes", () => {
    expect(readXaiTokenFreshness(real)).toBe(Date.parse("2026-08-19T19:37:53.982Z"));
    // Six hours after `create_time` — the measurement behind req 13's "~6h", so
    // a future CLI that shortens it makes this fail rather than pass quietly.
    const lifetimeMs = Date.parse(real["https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828"].expires_at)
      - Date.parse(real["https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828"].create_time);
    expect(lifetimeMs).toBe(6 * 60 * 60 * 1000);
  });

  it("falls back to the access token's JWT exp when no expiry field parses", () => {
    const scope = { ...real["https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828"] };
    delete (scope as Partial<typeof scope>).expires_at;
    // `exp` advances on every refresh, so it is a true freshness signal and not
    // merely a fallback that happens to return a number.
    expect(readXaiTokenFreshness({ s: scope })).toBe(1_787_168_273_000);
  });

  it("accepts a flat top-level record too, so a layout change degrades rather than breaks", () => {
    expect(extractXaiAccessToken({ key: "tok-flat" })).toBe("tok-flat");
    expect(extractXaiIdentity({ access_token: "t", user_id: "u-1" })).toEqual({ externalId: "u-1" });
  });

  /**
   * `user_id` and not the email, because an email can change under one account —
   * so two rows holding the same subscription must still collide on the id.
   * Identity with no email is legal; the email is a label default only.
   */
  it("keys identity on user_id, and reports none when there is no id", () => {
    expect(extractXaiIdentity({ s: { key: "t", email: "a@b.c" } })).toBeNull();
    expect(extractXaiIdentity({ s: { user_id: "u-2" } })).toEqual({ externalId: "u-2" });
  });

  it("reports no freshness for an unparseable file rather than a fake one", () => {
    const file = path.join(tempRoot(), "auth.json");
    // Missing: "cannot prove this is newer". The sync guards read that as "copy
    // the source in", which is the safe direction for a session with no token.
    expect(readXaiTokenFreshnessFile(file)).toBeNull();
    fs.writeFileSync(file, "not json at all");
    expect(readXaiTokenFreshnessFile(file)).toBeNull();
    fs.writeFileSync(file, JSON.stringify({ s: { key: "not-a-jwt" } }));
    expect(readXaiTokenFreshnessFile(file)).toBeNull();
    fs.writeFileSync(file, JSON.stringify({ s: { expires_at: 1_800_000_000 } }));
    // A numeric seconds expiry still scales to ms, so a future CLI that swapped
    // the ISO string for a number does not read as 1970 and lose every compare.
    expect(readXaiTokenFreshnessFile(file)).toBe(1_800_000_000_000);
  });
});
