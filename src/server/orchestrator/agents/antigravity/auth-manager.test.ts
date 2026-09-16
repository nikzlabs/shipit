import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AntigravityAuthManager,
  extractAntigravityIdentity,
  readAntigravityTokenFreshness,
} from "./auth-manager.js";
import { antigravityTokenPath } from "../../../shared/antigravity-home.js";
import type { AgentAuthFailedPayload } from "../../agent-auth-manager.js";
import type { AgentAuthLogPayload, AgentAuthProgressPayload } from "../auth-diagnostics.js";
import type { AgentAuthPendingDetails } from "../../../shared/types/ws-server-messages.js";

/**
 * Shaped like node-pty: one merged output stream, and `write` submits.
 *
 * **`signal` defaults to 0, because node-pty never omits it.** The fake used to
 * leave it `undefined` on a clean exit, so a manager testing `signal ===
 * undefined` for success passed every case here and could not succeed once —
 * measured 2026-09-16, probes/signin-exit-shape.md.
 */
class FakePty {
  readonly written: string[] = [];
  private data: ((d: string) => void) | null = null;
  private exit: ((e: { exitCode: number; signal?: number }) => void) | null = null;
  killed = false;
  onData(cb: (d: string) => void): void { this.data = cb; }
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): void { this.exit = cb; }
  write(d: string): void { this.written.push(d); }
  kill(): void { this.killed = true; }
  emitData(d: string): void { this.data?.(d); }
  emitExit(exitCode: number, signal = 0): void {
    this.exit?.({ exitCode, signal });
  }
}

const SIGN_IN_URL =
  "https://accounts.google.com/o/oauth2/v2/auth?client_id=1234.apps.googleusercontent.com&scope=openid";

describe("AntigravityAuthManager", () => {
  let home: string;
  let proc: FakePty;
  let spawnOpts: { name: string; cols: number; rows: number; env: Record<string, string> } | null;
  let manager: AntigravityAuthManager;
  let pending: AgentAuthPendingDetails[];
  let failed: (AgentAuthFailedPayload | undefined)[];
  let completed: number;
  let logs: AgentAuthLogPayload[];
  let progress: AgentAuthProgressPayload[];

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "antigravity-auth-"));
    proc = new FakePty();
    spawnOpts = null;
    pending = [];
    failed = [];
    completed = 0;
    logs = [];
    progress = [];
    manager = new AntigravityAuthManager({ spawn: (_c, _a, o) => { spawnOpts = o; return proc; } });
    manager.on("pending", (d) => pending.push(d));
    manager.on("failed", (p) => failed.push(p));
    manager.on("complete", () => { completed += 1; });
    manager.on("log", (p) => logs.push(p));
    manager.on("progress", (p) => progress.push(p));
  });

  afterEach(() => {
    manager.kill();
    fs.rmSync(home, { recursive: true, force: true });
  });

  function start(): void {
    manager.start({ credentialDir: home, accountId: "acct-1" });
  }

  function writeToken(body: Record<string, unknown>): void {
    const file = antigravityTokenPath(home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(body));
  }

  it("emits the sign-in link as a paste-shaped challenge", () => {
    start();
    proc.emitData(`Open this URL to sign in: ${SIGN_IN_URL}\n`);
    expect(pending).toEqual([{ kind: "code-paste-url", verificationUri: SIGN_IN_URL }]);
  });

  /**
   * A pty chunk boundary lands wherever the buffer says. Matching one
   * chunk emits a truncated link (split mid-query-string) or none at all (split
   * inside the host) — and the user pastes a code against that link inside the
   * CLI's 60-second window, so a broken one costs the whole attempt.
   */
  it("waits for the whole URL when the output splits it across chunks", () => {
    start();
    const at = SIGN_IN_URL.indexOf("client_") + 7;
    proc.emitData(`Open this URL: ${SIGN_IN_URL.slice(0, at)}`);
    expect(pending, "emitted a truncated link").toEqual([]);
    proc.emitData(`${SIGN_IN_URL.slice(at)}\n`);
    expect(pending).toEqual([{ kind: "code-paste-url", verificationUri: SIGN_IN_URL }]);
  });

  it("waits when the split lands inside the host", () => {
    start();
    proc.emitData("Open this URL: https://accounts.goo");
    expect(pending).toEqual([]);
    proc.emitData(`${SIGN_IN_URL.slice("https://accounts.goo".length)} `);
    expect(pending[0]).toMatchObject({ verificationUri: SIGN_IN_URL });
  });

  // Trimmed and terminated: the CLI reads one submitted line.
  it("submits the pasted code on the terminal", () => {
    start();
    manager.submitCode("  4/0AY-code  ");
    expect(proc.written.join("")).toMatch(/^4\/0AY-code[\r\n]$/);
  });

  /**
   * node-pty reports SIGTERM as `{exitCode: 0, signal: 15}` (measured), so a
   * cancelled flow that found an OLD token on disk would announce a sign-in
   * that never happened. The child-process path this replaced reported a null
   * exit code and could not.
   */
  it("does not call a killed sign-in complete, even with a token already on disk", () => {
    writeToken({ auth_method: "consumer", token: { access_token: "old", expiry: "2030-01-01T00:00:00Z" } });
    start();
    proc.emitExit(0, 15);
    expect(completed).toBe(0);
    expect(failed[0]?.message).toContain("stopped");
  });

  /**
   * The CLI asks whether stdin is a CHARACTER DEVICE to decide whether it may
   * start an interactive login, so a pipe — which is what delivering the pasted
   * code needs — makes it refuse with `authentication required. Run
   * 'antigravity' to log in`. It shipped that way and no sign-in could complete.
   * Measured on 1.1.27 by varying stdin alone.
   */
  it("asks for a terminal, which is what makes stdin a character device", () => {
    start();
    expect(spawnOpts?.name).toBe("xterm-color");
  });

  // An ambient key would authenticate the run and no sign-in would ever start.
  it("keeps an ambient Gemini key out of the sign-in environment", () => {
    process.env.GEMINI_API_KEY = "ambient-key";
    try {
      start();
      expect(spawnOpts?.env.GEMINI_API_KEY).toBeUndefined();
    } finally {
      delete process.env.GEMINI_API_KEY;
    }
  });

  it("completes when the run wrote a token", () => {
    start();
    writeToken({ access_token: "a", expiry: "2030-01-01T00:00:00Z" });
    proc.emitExit(0);
    expect(completed).toBe(1);
    expect(failed).toEqual([]);
  });

  /**
   * The sign-in rides a PRINT run, so a non-zero exit can be the prompt failing
   * for its own reasons — quota, a blocked host — over a credential that is
   * fine. Failing there strands a user who cannot connect a working account
   * however often they retry, because every retry ends the same way.
   */
  it("completes on a non-zero exit when the token was still written", () => {
    start();
    writeToken({ access_token: "a", expiry: "2030-01-01T00:00:00Z" });
    proc.emitExit(1);
    expect(completed).toBe(1);
  });

  /**
   * The eligibility check runs AFTER the exchange, so an ineligible account gets
   * a perfectly good token and then Google's refusal. Calling that connected
   * discards the only explanation the user gets (req 4) and leaves an account
   * whose every turn fails — so a sentence from the CLI outranks the token.
   */
  it("fails a refusal that arrives over a token this run wrote", () => {
    start();
    writeToken({ access_token: "a", expiry: "2030-01-01T00:00:00Z" });
    proc.emitData("Error: Eligibility check failed: Your current account is not eligible.\n");
    proc.emitExit(1);
    expect(completed).toBe(0);
    expect(failed[0]?.message).toBe("Eligibility check failed: Your current account is not eligible.");
  });

  /**
   * A save that died part-way moves the file's mtime like any other write. The
   * completion claim is "a run signed in", so it is read as a credential, not
   * as bytes — `isConfigured` keeps the looser test, which reports what the
   * account has rather than what a run just did.
   */
  it("does not read a half-written token file as a sign-in", () => {
    start();
    const file = antigravityTokenPath(home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{"auth_method":"cons');
    proc.emitExit(0);
    expect(completed).toBe(0);
  });

  // A run on an already-signed-in home never touches the token and still succeeds.
  it("completes on a clean exit when a token was already there", () => {
    writeToken({ access_token: "old", expiry: "2030-01-01T00:00:00Z" });
    start();
    proc.emitExit(0);
    expect(completed).toBe(1);
  });

  // Past a printed link this bound is not the one that lapsed — the CLI's own
  // 60 s window closed long before — so "no link" contradicts the link on screen.
  it("does not blame a missing link for a timeout that came after one", async () => {
    const bounded = new AntigravityAuthManager({ spawn: () => proc, timeoutMs: 10 });
    const seen: (AgentAuthFailedPayload | undefined)[] = [];
    bounded.on("failed", (p) => seen.push(p));
    bounded.start({ credentialDir: home, accountId: "acct-1" });
    proc.emitData(`Sign in here: ${SIGN_IN_URL}\n`);
    await new Promise((r) => setTimeout(r, 40));
    expect(seen[0]?.reason).toBe("timeout");
    expect(seen[0]?.message).not.toContain("no sign-in link");
  });

  it("does not complete on exit zero with no token", () => {
    start();
    proc.emitExit(0);
    expect(completed).toBe(0);
    expect(failed.length).toBe(1);
  });

  // The stale token is not this flow's, and the CLI said why it failed.
  it("fails a timed-out sign-in even with an older token on disk", () => {
    writeToken({ access_token: "old", expiry: "2030-01-01T00:00:00Z" });
    start();
    proc.emitData(`Sign in here: ${SIGN_IN_URL}\n`);
    proc.emitData("Error: authentication timed out.\n");
    proc.emitExit(1);
    expect(completed).toBe(0);
    expect(failed[0]?.message).toContain("authentication timed out");
  });

  /**
   * The exit handler clears `lastPendingDetails` before it composes the message,
   * so reading the field there always said "without starting a sign-in" — the
   * one sentence that is wrong once a link has been shown, and the sentence a
   * user who pasted their code too late was given.
   */
  it("names the 60-second window when a link was shown but nothing was written", () => {
    start();
    proc.emitData(`Sign in here: ${SIGN_IN_URL}\n`);
    proc.emitExit(0);
    expect(failed[0]?.message).toContain("60 seconds");
  });

  /**
   * req 4 — Google's own sentence, not ShipIt's generic copy. The prefix's CASE
   * is a version difference (1.1.27 writes `Error:`, 1.2.2 writes `error:`), so
   * a case-sensitive match finds the refusal on one version and nothing on the
   * other.
   */
  it.each(["Error:", "error:"])("relays a refusal introduced by %s, verbatim", (prefix) => {
    start();
    proc.emitData(
      `${prefix} Eligibility check failed: Your current account is not eligible for Antigravity.\n`
      + "To use Antigravity you must be 18 years old or older.\n",
    );
    proc.emitExit(1);
    expect(failed[0]?.message).toBe(
      "Eligibility check failed: Your current account is not eligible for Antigravity.\n"
      + "To use Antigravity you must be 18 years old or older.",
    );
  });

  /**
   * Every other test here injects a fake, so replacing the production spawn with
   * a pipe again would leave them all green — which is exactly how the defect
   * shipped. This one drives the REAL spawn against a stub that reports what its
   * stdin is, because "stdin is a character device" is the whole fix.
   */
  it("gives the real spawn a character device on stdin, not a pipe", async () => {
    const stub = path.join(home, "stub-cli.mjs");
    fs.writeFileSync(stub, [
      "import fs from 'node:fs';",
      "const s = fs.fstatSync(0);",
      "process.stdout.write(s.isCharacterDevice() ? 'STDIN=chardev\\n' : 'STDIN=other\\n');",
    ].join("\n"));

    const seen: string[] = [];
    const real = new AntigravityAuthManager({ command: process.execPath, timeoutMs: 20_000 });
    // The manager only surfaces a sign-in URL, so read the stub's answer here.
    const spawned = (real as unknown as {
      spawnFn: (c: string, a: readonly string[], o: Record<string, unknown>) => {
        onData: (cb: (d: string) => void) => void; kill: () => void;
      };
    }).spawnFn(process.execPath, [stub], { name: "xterm-color", cols: 80, rows: 40, env: process.env });
    spawned.onData((d) => seen.push(d));
    await new Promise((r) => setTimeout(r, 2_000));
    spawned.kill();
    expect(seen.join("")).toContain("STDIN=chardev");
  });

  it("reports a saved account only when the token file has content", () => {
    expect(manager.isConfigured({ credentialDir: home })).toBe(false);
    writeToken({ access_token: "a" });
    expect(manager.isConfigured({ credentialDir: home })).toBe(true);
  });

  /**
   * The sign-in diagnostics panel in Settings renders whatever a manager
   * reports, for any harness. This one reported nothing, so an Antigravity
   * login that failed left the user one summary sentence and no way to see what
   * the CLI had said.
   */
  describe("what the sign-in reports to the panel", () => {
    it("relays the CLI's own output, scoped to this login and account", () => {
      start();
      proc.emitData("Waiting for authentication (timeout 60s)...\n");

      const cli = logs.filter((l) => l.source === "cli_stdout");
      expect(cli.map((l) => l.message)).toContain("Waiting for authentication (timeout 60s)...");
      expect(cli[0]).toMatchObject({ loginId: "google-antigravity-oauth", accountId: "acct-1" });
      expect(cli[0]?.attemptId).toBeTruthy();
    });

    it("says the link arrived without putting the link through the sanitizer", () => {
      start();
      proc.emitData(`Please visit the URL to log in:\n  ${SIGN_IN_URL}\n`);

      const arrival = logs.find((l) => l.source === "shipit" && l.message.includes("link received"));
      expect(arrival).toBeDefined();
      // The link the user needs is the challenge's button, unsanitized. A log
      // line quoting it would arrive as `…/auth?[redacted]` and be useless.
      expect(arrival?.message).not.toContain("accounts.google.com");
      expect(pending[0]).toMatchObject({ verificationUri: SIGN_IN_URL });
    });

    it("says the code went to the CLI and never says what the code was", () => {
      start();
      proc.emitData(`${SIGN_IN_URL} `);
      manager.submitCode("4/0AY-secret-code");

      const shipit = logs.filter((l) => l.source === "shipit").map((l) => l.message);
      expect(shipit.some((m) => m.includes("Authorization code delivered"))).toBe(true);
      expect(shipit.join("\n")).not.toContain("4/0AY-secret-code");
      expect(progress.at(-1)).toMatchObject({ phase: "checking_credentials" });
    });

    /**
     * The one line that says which branch the exit took. It was on the terminal
     * only, which the user cannot read — and a completed exchange reported as a
     * failure is exactly the case where they need it (probes/signin-exit-shape.md).
     */
    it("puts the line that explains the ending in the panel, not only the terminal", () => {
      start();
      proc.emitData(`${SIGN_IN_URL} `);
      proc.emitExit(1);

      const ending = logs.find((l) => l.message.startsWith("sign-in ended"));
      expect(ending?.message).toContain("exit=1");
      expect(ending?.message).toContain("link=true");
      expect(ending?.message).toContain("token=absent");
    });

    it("says where the sign-in has got to before the link arrives", () => {
      start();
      expect(progress.map((p) => p.phase)).toEqual(["starting", "waiting_for_url"]);
      expect(progress[0]).toMatchObject({ loginId: "google-antigravity-oauth", accountId: "acct-1" });
    });
  });
});

describe("the Antigravity token file", () => {
  const jwt = (payload: Record<string, unknown>): string =>
    `hdr.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.sig`;

  /**
   * A real sign-in nests the credential under `token` — captured 2026-09-14 from
   * a `consumer` sign-in. Read at the top level it returned null for every real
   * file, so no Antigravity token was orderable and a rotated one was never
   * published back (`token-freshness=unorderable outcome=stranded-rotation`).
   */
  it("orders the nested shape a real sign-in writes", () => {
    expect(readAntigravityTokenFreshness({
      auth_method: "consumer",
      token: { access_token: "opaque", token_type: "Bearer", expiry: "2026-09-14T13:45:34.180907488Z" },
    })).toBe(Date.parse("2026-09-14T13:45:34.180Z"));
  });

  // The observed auth method carries no id_token, so there is no identity to show.
  it("reports no identity for a consumer token, which carries no id token", () => {
    expect(extractAntigravityIdentity({
      auth_method: "consumer",
      token: { access_token: "opaque", refresh_token: "opaque", token_type: "Bearer" },
    })).toBeNull();
  });

  it("still reads an identity nested beside the credential", () => {
    expect(extractAntigravityIdentity({
      auth_method: "business",
      token: { id_token: jwt({ sub: "1049", email: "a@b.c" }) },
    })).toEqual({ externalId: "1049", email: "a@b.c" });
  });

  it("orders by the RFC3339 expiry the CLI writes", () => {
    expect(readAntigravityTokenFreshness({ expiry: "2026-09-13T17:00:00.482173911Z" }))
      .toBe(Date.parse("2026-09-13T17:00:00.482Z"));
  });

  it("falls back to the id token's exp when expiry is missing", () => {
    expect(readAntigravityTokenFreshness({ id_token: jwt({ exp: 1789059600 }) })).toBe(1789059600 * 1000);
  });

  // Unknown freshness must not read as absence: that licenses a clobber.
  it("returns null rather than a guess when nothing is orderable", () => {
    expect(readAntigravityTokenFreshness({ access_token: "opaque" })).toBeNull();
    expect(readAntigravityTokenFreshness({ expiry: "not a date" })).toBeNull();
  });

  it("identifies the account by the id token's subject, with the email as a label", () => {
    expect(extractAntigravityIdentity({ id_token: jwt({ sub: "1049", email: "a@b.c" }) }))
      .toEqual({ externalId: "1049", email: "a@b.c" });
  });

  it("reports no identity rather than a partial one when the subject is absent", () => {
    expect(extractAntigravityIdentity({ id_token: jwt({ email: "a@b.c" }) })).toBeNull();
    expect(extractAntigravityIdentity({})).toBeNull();
  });
});
