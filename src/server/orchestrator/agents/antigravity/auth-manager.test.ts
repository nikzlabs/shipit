import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AntigravityAuthManager,
  extractAntigravityIdentity,
  readAntigravityTokenFreshness,
} from "./auth-manager.js";
import { antigravityTokenPath } from "../../../shared/antigravity-home.js";
import type { AgentAuthFailedPayload } from "../../agent-auth-manager.js";
import type { AgentAuthPendingDetails } from "../../../shared/types/ws-server-messages.js";

interface FakeProc extends EventEmitter {
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: PassThrough;
}

const SIGN_IN_URL =
  "https://accounts.google.com/o/oauth2/v2/auth?client_id=1234.apps.googleusercontent.com&scope=openid";

describe("AntigravityAuthManager", () => {
  let home: string;
  let proc: FakeProc;
  let manager: AntigravityAuthManager;
  let pending: AgentAuthPendingDetails[];
  let failed: (AgentAuthFailedPayload | undefined)[];
  let completed: number;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "antigravity-auth-"));
    proc = new EventEmitter() as FakeProc;
    proc.stdout = new PassThrough();
    proc.stderr = new PassThrough();
    proc.stdin = new PassThrough();
    pending = [];
    failed = [];
    completed = 0;
    manager = new AntigravityAuthManager({ spawn: () => proc as unknown as ChildProcess });
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
    proc.stderr.write(`Open this URL to sign in: ${SIGN_IN_URL}\n`);
    expect(pending).toEqual([{ kind: "code-paste-url", verificationUri: SIGN_IN_URL }]);
  });

  /**
   * A stderr chunk boundary lands wherever the pipe buffer says. Matching one
   * chunk emits a truncated link (split mid-query-string) or none at all (split
   * inside the host) — and the user pastes a code against that link inside the
   * CLI's 60-second window, so a broken one costs the whole attempt.
   */
  it("waits for the whole URL when stderr splits it across chunks", () => {
    start();
    const at = SIGN_IN_URL.indexOf("client_") + 7;
    proc.stderr.write(`Open this URL: ${SIGN_IN_URL.slice(0, at)}`);
    expect(pending, "emitted a truncated link").toEqual([]);
    proc.stderr.write(`${SIGN_IN_URL.slice(at)}\n`);
    expect(pending).toEqual([{ kind: "code-paste-url", verificationUri: SIGN_IN_URL }]);
  });

  it("waits when the split lands inside the host", () => {
    start();
    proc.stderr.write("Open this URL: https://accounts.goo");
    expect(pending).toEqual([]);
    proc.stderr.write(`${SIGN_IN_URL.slice("https://accounts.goo".length)} `);
    expect(pending[0]).toMatchObject({ verificationUri: SIGN_IN_URL });
  });

  it("writes the pasted code to the CLI's stdin", () => {
    const written: string[] = [];
    proc.stdin.on("data", (c: Buffer) => written.push(c.toString("utf8")));
    start();
    manager.submitCode("  4/0AY-code  ");
    expect(written.join("")).toBe("4/0AY-code\n");
  });

  it("completes only when the run exited zero AND a token was written", () => {
    start();
    writeToken({ access_token: "a", expiry: "2030-01-01T00:00:00Z" });
    proc.emit("close", 0);
    expect(completed).toBe(1);
    expect(failed).toEqual([]);
  });

  it("does not complete on exit zero with no token", () => {
    start();
    proc.emit("close", 0);
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
    proc.stderr.write(
      `${prefix} Eligibility check failed: Your current account is not eligible for Antigravity.\n`
      + "To use Antigravity you must be 18 years old or older.\n",
    );
    proc.emit("close", 1);
    expect(failed[0]?.message).toBe(
      "Eligibility check failed: Your current account is not eligible for Antigravity.\n"
      + "To use Antigravity you must be 18 years old or older.",
    );
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
