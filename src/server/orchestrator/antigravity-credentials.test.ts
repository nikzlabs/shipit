import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { revokeSessionProviderCredentials } from "./session-agent-credentials.js";
import { perSessionCredentialsDir } from "./session-credentials.js";
import { AGENT_TOKEN_FILES } from "./token-sync-manager.js";
import { ANTIGRAVITY_TOKEN_REL } from "../shared/antigravity-home.js";

/**
 * Antigravity keeps its OAuth token BESIDE its conversation state, inside
 * `antigravity-cli/`. Every other harness separates them one level up, so the
 * two helpers this exercises both had to learn a deeper path — and the risk of
 * that change is that it quietly alters behaviour for the four harnesses that
 * were already correct.
 */
describe("revoking an account whose token sits beside its state", () => {
  let root: string;
  const sid = "session-antigravity-revoke";

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-agy-creds-"));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function seedGemini(): { token: string; conversation: string; settings: string } {
    const dir = path.join(perSessionCredentialsDir(root, sid), ".gemini", "antigravity-cli");
    fs.mkdirSync(path.join(dir, "conversations"), { recursive: true });
    fs.mkdirSync(path.join(dir, "brain", "conv-1"), { recursive: true });
    const token = path.join(dir, "antigravity-oauth-token");
    const conversation = path.join(dir, "conversations", "conv-1.db");
    const settings = path.join(dir, "settings.json");
    fs.writeFileSync(token, '{"access_token":"secret"}');
    fs.writeFileSync(conversation, "sqlite");
    fs.writeFileSync(settings, '{"modelProvider":"gemini"}');
    return { token, conversation, settings };
  }

  it("deletes the revoked token and keeps the conversation state", () => {
    const { token, conversation } = seedGemini();
    revokeSessionProviderCredentials(root, sid, "antigravity");
    expect(fs.existsSync(token), "the revoked token survived").toBe(false);
    expect(fs.existsSync(conversation), "the conversation was destroyed with it").toBe(true);
  });

  it("declares the token at the path the deletion actually clears", () => {
    expect(AGENT_TOKEN_FILES.antigravity).toEqual([ANTIGRAVITY_TOKEN_REL]);
  });

  // settings.json is derived at every spawn, so it is deliberately not preserved.
  it("drops the derived settings file rather than carrying a stale provider", () => {
    const { settings } = seedGemini();
    revokeSessionProviderCredentials(root, sid, "antigravity");
    expect(fs.existsSync(settings)).toBe(false);
  });

  /**
   * The regression guard for the four harnesses that were already correct: a
   * single-component preserved entry must still preserve the WHOLE directory,
   * exactly as the old bare-name match did.
   */
  it.each([
    ["claude", ".claude", "projects", ".credentials.json"],
    ["codex", ".codex", "sessions", "auth.json"],
    ["grok", ".grok", "sessions", "auth.json"],
  ] as const)("still preserves %s's whole state directory", (agentId, rel, stateDir, tokenName) => {
    const dir = path.join(perSessionCredentialsDir(root, sid), rel);
    fs.mkdirSync(path.join(dir, stateDir, "nested"), { recursive: true });
    const deep = path.join(dir, stateDir, "nested", "thread.jsonl");
    fs.writeFileSync(deep, "state");
    fs.writeFileSync(path.join(dir, tokenName), "token");
    revokeSessionProviderCredentials(root, sid, agentId);
    expect(fs.existsSync(deep), `${agentId} lost nested state`).toBe(true);
    expect(fs.existsSync(path.join(dir, tokenName)), `${agentId} kept its token`).toBe(false);
  });
});
