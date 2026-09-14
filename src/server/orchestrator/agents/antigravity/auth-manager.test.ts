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
import type { AgentAuthPendingDetails } from "../../../shared/types/ws-server-messages.js";

/** Shaped like node-pty: one merged output stream, and `write` submits. */
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
  emitExit(exitCode: number, signal?: number): void {
    this.exit?.(signal === undefined ? { exitCode } : { exitCode, signal });
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

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "antigravity-auth-"));
    proc = new FakePty();
    spawnOpts = null;
    pending = [];
    failed = [];
    completed = 0;
    manager = new AntigravityAuthManager({ spawn: (_c, _a, o) => { spawnOpts = o; return proc; } });
    manager.on("pending", (d) => pending.push(d));
    manager.on("failed", (p) => failed.push(p));
    manager.on("complete", () => { completed += 1; });
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

  it("completes only when the run exited zero AND a token was written", () => {
    start();
    writeToken({ access_token: "a", expiry: "2030-01-01T00:00:00Z" });
    proc.emitExit(0);
    expect(completed).toBe(1);
    expect(failed).toEqual([]);
  });

  it("does not complete on exit zero with no token", () => {
    start();
    proc.emitExit(0);
    expect(completed).toBe(0);
    expect(failed.length).toBe(1);
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
