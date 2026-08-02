import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { LIVE_CREDENTIALS_DIR, resolveCredentialsDir } from "./app-di.js";

/**
 * Regression cover for the "Not logged in · Please run /login" session-killer.
 *
 * `initializeManagers` defaulted `credentialsDir` to {@link LIVE_CREDENTIALS_DIR}.
 * ~86 of the 99 test files that call `buildApp()` pass `workspaceDir: tmpDir`
 * but no `credentialsDir`, so under test they pointed `ProviderAccountManager`
 * at that live path. Its legacy migration is gated on "no accounts registered
 * yet" — never true in production, ALWAYS true against a fresh test DB — and
 * ended in a `renameSync`. Inside a ShipIt session container `/credentials` is
 * the session's own agent home, so running the suite moved the running CLI's
 * `.claude/` (credential *and* conversation jsonl) into
 * `provider-accounts/claude/claude-default/` and every later turn 401'd.
 *
 * These tests pin the two rules that make that unreachable.
 */
describe("resolveCredentialsDir", () => {
  const created: string[] = [];

  afterEach(() => {
    for (const dir of created.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("defaults to the live volume outside test mode", () => {
    expect(resolveCredentialsDir(undefined, false)).toBe(LIVE_CREDENTIALS_DIR);
  });

  it("passes an explicit dir through outside test mode", () => {
    expect(resolveCredentialsDir("/somewhere/else", false)).toBe("/somewhere/else");
  });

  it("never returns the live volume in test mode when omitted", () => {
    const resolved = resolveCredentialsDir(undefined, true);
    created.push(resolved);

    expect(resolved).not.toBe(LIVE_CREDENTIALS_DIR);
    expect(fs.existsSync(resolved)).toBe(true);
    expect(path.basename(resolved)).toMatch(/^shipit-test-credentials-/);
  });

  it("hands each test its own dir, so suites can't collide", () => {
    const a = resolveCredentialsDir(undefined, true);
    const b = resolveCredentialsDir(undefined, true);
    created.push(a, b);

    expect(a).not.toBe(b);
  });

  it("rejects an explicit live volume in test mode", () => {
    expect(() => resolveCredentialsDir(LIVE_CREDENTIALS_DIR, true)).toThrow(
      /Refusing to use the live credentials volume/,
    );
  });

  it("rejects a non-normalized path that still resolves to the live volume", () => {
    expect(() => resolveCredentialsDir("/credentials/", true)).toThrow(
      /Refusing to use the live credentials volume/,
    );
    expect(() => resolveCredentialsDir("/var/../credentials", true)).toThrow(
      /Refusing to use the live credentials volume/,
    );
  });

  it("still allows an explicit temp dir in test mode", () => {
    expect(resolveCredentialsDir("/tmp/some-test-root", true)).toBe("/tmp/some-test-root");
  });
});
