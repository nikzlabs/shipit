import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AUTH_URL_PATTERNS,
  AuthManager,
  extractAccessToken,
  extractAuthUrl,
  extractExpiresAt,
  extractPlanLabel,
  extractUrlFromBuffer,
} from "./auth-manager.js";

const ptyHoisted = vi.hoisted(() => ({
  calls: [] as { cmd: string; args: readonly string[]; opts: { env?: Record<string, string>; cols?: number } }[],
  exitHandlers: [] as ((e: { exitCode: number }) => void)[],
  dataHandlers: [] as ((data: string) => void)[],
  writes: [] as string[],
  killed: 0,
}));
vi.mock("node-pty", () => ({
  spawn: (cmd: string, args: readonly string[], opts: { env?: Record<string, string>; cols?: number }) => {
    ptyHoisted.calls.push({ cmd, args, opts });
    return {
      pid: 4242,
      onData: (cb: (data: string) => void) => { ptyHoisted.dataHandlers.push(cb); },
      onExit: (cb: (e: { exitCode: number }) => void) => { ptyHoisted.exitHandlers.push(cb); },
      write: (data: string) => { ptyHoisted.writes.push(data); },
      kill: () => { ptyHoisted.killed++; },
    };
  },
}));

describe("AUTH_URL_PATTERNS", () => {
  it("matches Anthropic console URLs", () => {
    const text = "Visit https://console.anthropic.com/verify?code=abc123 to authenticate";
    const match = text.match(AUTH_URL_PATTERNS[0]);
    expect(match).not.toBeNull();
    expect(match![0]).toBe("https://console.anthropic.com/verify?code=abc123");
  });

  it("matches Claude AI OAuth URLs", () => {
    const text = "Go to https://claude.ai/oauth/callback?state=xyz";
    const match = text.match(AUTH_URL_PATTERNS[1]);
    expect(match).not.toBeNull();
  });

  it("matches generic auth verify URLs", () => {
    const text = "Open https://example.com/auth/verify/token123";
    const match = text.match(AUTH_URL_PATTERNS[2]);
    expect(match).not.toBeNull();
  });

  it("matches login URLs", () => {
    const text = "Please visit https://example.com/login?redirect=app";
    const match = text.match(AUTH_URL_PATTERNS[3]);
    expect(match).not.toBeNull();
  });
});

describe("extractAuthUrl", () => {
  it("extracts Anthropic console URL from text", () => {
    const text = "Please open https://console.anthropic.com/verify?code=abc123 in your browser";
    expect(extractAuthUrl(text)).toBe("https://console.anthropic.com/verify?code=abc123");
  });

  it("extracts Claude OAuth URL", () => {
    const text = "Redirecting to https://claude.ai/oauth/authorize?state=abc";
    expect(extractAuthUrl(text)).toBe("https://claude.ai/oauth/authorize?state=abc");
  });

  it("strips trailing punctuation from URLs", () => {
    const text = 'Visit https://console.anthropic.com/verify?code=abc"';
    expect(extractAuthUrl(text)).toBe("https://console.anthropic.com/verify?code=abc");
  });

  it("strips trailing brackets and quotes", () => {
    const cases = [
      ['See https://console.anthropic.com/verify)', "https://console.anthropic.com/verify"],
      ['See https://console.anthropic.com/verify]', "https://console.anthropic.com/verify"],
      ["See https://console.anthropic.com/verify'", "https://console.anthropic.com/verify"],
    ];
    for (const [input, expected] of cases) {
      expect(extractAuthUrl(input)).toBe(expected);
    }
  });

  it("returns null for text without auth URLs", () => {
    expect(extractAuthUrl("Hello world")).toBeNull();
    expect(extractAuthUrl("Visit https://example.com")).toBeNull();
    expect(extractAuthUrl("Just some random text")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(extractAuthUrl("")).toBeNull();
  });

  it("prefers Anthropic console URL over generic patterns", () => {
    const text = "Open https://console.anthropic.com/login?code=abc";
    const result = extractAuthUrl(text);
    expect(result).toBe("https://console.anthropic.com/login?code=abc");
  });

  it("strips ANSI escape codes before matching", () => {
    const text = "\x1b[1mOpen \x1b[36mhttps://console.anthropic.com/verify?code=abc\x1b[0m in your browser";
    expect(extractAuthUrl(text)).toBe("https://console.anthropic.com/verify?code=abc");
  });
});

describe("extractUrlFromBuffer", () => {
  it("extracts a simple URL from a buffer", () => {
    const buffer = "Some text\nhttps://example.com/auth?code=abc123\n\nMore text";
    expect(extractUrlFromBuffer(buffer)).toBe("https://example.com/auth?code=abc123");
  });

  it("joins URL split across multiple lines by PTY wrapping", () => {
    const buffer = [
      "Browser didn't open? Use the url below to sign in:",
      "",
      "https://claude.ai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-59",
      "44d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Fo",
      "auth%2Fcode%2Fcallback&scope=user%3Aread%2Corg%3Aread",
      "",
      "Paste code here if prompted >",
    ].join("\n");

    const url = extractUrlFromBuffer(buffer);
    expect(url).toBe(
      "https://claude.ai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=user%3Aread%2Corg%3Aread",
    );
  });

  it("extracts the last URL when multiple are present", () => {
    const buffer = [
      "Opening https://claude.ai/oauth/authorize?redirect_uri=http://localhost:40393",
      "",
      "Browser didn't open? Use the url below to sign in:",
      "",
      "https://claude.ai/oauth/authorize?code=true&client_id=abc123",
      "",
      "Paste code here >",
    ].join("\n");

    const url = extractUrlFromBuffer(buffer);
    expect(url).toBe("https://claude.ai/oauth/authorize?code=true&client_id=abc123");
  });

  it("strips ANSI escape codes before extracting", () => {
    const buffer = "\x1b[1m\x1b[36mhttps://claude.ai/oauth/authorize?code=true&client_id=abc123\x1b[0m\n\nPaste code here";
    expect(extractUrlFromBuffer(buffer)).toBe("https://claude.ai/oauth/authorize?code=true&client_id=abc123");
  });

  it("handles \\r\\n line endings from PTY", () => {
    const buffer =
      "https://claude.ai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9\r\n-88ed-5944d1962f5e\r\n\r\nPaste code here";
    expect(extractUrlFromBuffer(buffer)).toBe(
      "https://claude.ai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e",
    );
  });

  it("returns null when no URL is present", () => {
    expect(extractUrlFromBuffer("No URL here")).toBeNull();
    expect(extractUrlFromBuffer("")).toBeNull();
  });

  it("returns null for very short URLs", () => {
    expect(extractUrlFromBuffer("https://a.b")).toBeNull();
  });

  it("stops at non-URL characters like spaces", () => {
    const buffer = "https://claude.ai/oauth?code=abc more text here";
    expect(extractUrlFromBuffer(buffer)).toBe("https://claude.ai/oauth?code=abc");
  });

  it("handles real Docker PTY output with 6-line wrapped URL", () => {
    const buffer = [
      "Browser didn't open?Use the urlbelowtosignin(ctocopy)",
      "",
      "https://claude.ai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-59",
      "44d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Fo",
      "auth%2Fcode%2Fcallback&scope=org%3Acreate_api_key+user%3Aprofile+user%3Ainferenc",
      "e+user%3Asessions%3Aclaude_code+user%3Amcp_servers&code_challenge=TWy6R8mJ-6Q4sx",
      "EInihAvunUZYP-vYuS_ZgN850bILY&code_challenge_method=S256&state=5Y7MUtftSd4uP8jGs",
      "Mxqyj1gQac34krcYnd3bFeg5q0",
      "",
      "",
      "Pastecodehereifprompted>",
    ].join("\n");

    const url = extractUrlFromBuffer(buffer);
    expect(url).toBe(
      "https://claude.ai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=org%3Acreate_api_key+user%3Aprofile+user%3Ainference+user%3Asessions%3Aclaude_code+user%3Amcp_servers&code_challenge=TWy6R8mJ-6Q4sxEInihAvunUZYP-vYuS_ZgN850bILY&code_challenge_method=S256&state=5Y7MUtftSd4uP8jGsMxqyj1gQac34krcYnd3bFeg5q0",
    );
  });

  it("strips DEC private mode escape sequences", () => {
    const buffer = "\x1b[?25lhttps://claude.ai/oauth/authorize?code=true&client_id=abc123\x1b[?25h\n\nDone";
    expect(extractUrlFromBuffer(buffer)).toBe("https://claude.ai/oauth/authorize?code=true&client_id=abc123");
  });

  it("handles trigger text glued directly to URL end (no empty line)", () => {
    const fullBuffer = "https://claude.ai/oauth/authorize?code=true&state=abc123Pastecodehereifprompted";
    const triggerPos = fullBuffer.indexOf("Pastecodehereifprompted");
    const truncated = fullBuffer.substring(0, triggerPos);
    expect(extractUrlFromBuffer(truncated)).toBe("https://claude.ai/oauth/authorize?code=true&state=abc123");
  });
});


describe("AuthManager.checkCredentials", () => {
  let origApiKey: string | undefined;
  let origAuthToken: string | undefined;

  beforeEach(() => {
    origApiKey = process.env.ANTHROPIC_API_KEY;
    origAuthToken = process.env.ANTHROPIC_AUTH_TOKEN;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
  });

  afterEach(() => {
    if (origApiKey !== undefined) process.env.ANTHROPIC_API_KEY = origApiKey;
    else delete process.env.ANTHROPIC_API_KEY;
    if (origAuthToken !== undefined) process.env.ANTHROPIC_AUTH_TOKEN = origAuthToken;
    else delete process.env.ANTHROPIC_AUTH_TOKEN;
  });

  it("returns true when ANTHROPIC_API_KEY is set", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    const mgr = new AuthManager();
    expect(mgr.checkCredentials()).toBe(true);
    expect(mgr.authenticated).toBe(true);
  });

  it("returns true when ANTHROPIC_AUTH_TOKEN is set (dogfooding path)", () => {
    process.env.ANTHROPIC_AUTH_TOKEN = "oauth-access-token-abc";
    const mgr = new AuthManager();
    expect(mgr.checkCredentials()).toBe(true);
    expect(mgr.authenticated).toBe(true);
  });
});

describe("extractAccessToken", () => {
  it("returns the top-level accessToken when present", () => {
    expect(extractAccessToken({ accessToken: "tok-1" })).toBe("tok-1");
  });

  it("falls back to snake_case access_token", () => {
    expect(extractAccessToken({ access_token: "tok-2" })).toBe("tok-2");
  });

  it("reads the nested claudeAiOauth shape", () => {
    expect(extractAccessToken({ claudeAiOauth: { accessToken: "nested" } })).toBe("nested");
  });

  it("returns null when no token shape is recognized", () => {
    expect(extractAccessToken({ unrelated: "shape" })).toBeNull();
    expect(extractAccessToken({ accessToken: "" })).toBeNull();
  });
});

describe("extractExpiresAt", () => {
  it("returns ms-precision timestamps verbatim", () => {
    expect(extractExpiresAt({ expiresAt: 1_700_000_000_000 })).toBe(1_700_000_000_000);
  });

  it("upconverts second-precision timestamps", () => {
    expect(extractExpiresAt({ expires_at: 1_700_000_000 })).toBe(1_700_000_000_000);
  });

  it("reads nested claudeAiOauth.expiresAt", () => {
    expect(extractExpiresAt({ claudeAiOauth: { expiresAt: 1_700_000_000_000 } })).toBe(1_700_000_000_000);
  });

  it("returns null when nothing parses", () => {
    expect(extractExpiresAt({ expiresAt: "soon" })).toBeNull();
    expect(extractExpiresAt({})).toBeNull();
  });
});

describe("extractPlanLabel", () => {
  it("renders 'Max 20x' from rateLimitTier=default_claude_max_20x", () => {
    expect(extractPlanLabel({
      claudeAiOauth: {
        subscriptionType: "max",
        rateLimitTier: "default_claude_max_20x",
      },
    })).toBe("Max 20x");
  });

  it("renders 'Max 5x' from rateLimitTier=default_claude_max_5x", () => {
    expect(extractPlanLabel({
      claudeAiOauth: {
        subscriptionType: "max",
        rateLimitTier: "default_claude_max_5x",
      },
    })).toBe("Max 5x");
  });

  it("renders 'Pro' from a Pro-shaped rateLimitTier", () => {
    expect(extractPlanLabel({
      claudeAiOauth: { subscriptionType: "pro", rateLimitTier: "default_claude_pro" },
    })).toBe("Pro");
  });

  it("falls back to subscriptionType when rateLimitTier is unrecognized", () => {
    expect(extractPlanLabel({
      claudeAiOauth: { subscriptionType: "pro", rateLimitTier: "future_tier_we_dont_know_yet" },
    })).toBe("Pro");
  });

  it("titlecases an unknown subscriptionType so we have *something* to render", () => {
    expect(extractPlanLabel({
      claudeAiOauth: { subscriptionType: "enterprise" },
    })).toBe("Enterprise");
  });

  it("returns null when the file has no oauth metadata", () => {
    expect(extractPlanLabel({})).toBeNull();
    expect(extractPlanLabel({ claudeAiOauth: {} })).toBeNull();
  });
});

describe("AuthManager / account-scoped (docs/150)", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-claude-scoped-"));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
  });

  it("getActiveAccountId is null before any scoped flow", () => {
    expect(new AuthManager().getActiveAccountId()).toBeNull();
  });

  it("checkCredentials(dir) is file-only and ignores reserved env vars", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    process.env.ANTHROPIC_AUTH_TOKEN = "bearer";
    const mgr = new AuthManager();
    expect(mgr.isConfigured({ credentialDir: tmp })).toBe(false);
    expect(mgr.isConfigured()).toBe(true);

    fs.mkdirSync(path.join(tmp, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(tmp, ".claude", ".credentials.json"), "{}");
    expect(mgr.isConfigured({ credentialDir: tmp })).toBe(true);
  });

  it("signOut(credentialDir) removes only the account's credential files", () => {
    const mgr = new AuthManager();
    fs.mkdirSync(path.join(tmp, ".claude"), { recursive: true });
    const credPath = path.join(tmp, ".claude", ".credentials.json");
    fs.writeFileSync(credPath, "{}");
    mgr.signOut({ credentialDir: tmp });
    expect(fs.existsSync(credPath)).toBe(false);
  });
});

describe("AuthManager / scoped spawn (docs/150)", () => {
  beforeEach(() => {
    ptyHoisted.calls.length = 0;
    ptyHoisted.dataHandlers.length = 0;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("spawns claude /login with HOME at the account credential root", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-claude-home-"));
    try {
      const mgr = new AuthManager();
      mgr.startOAuthFlow({ accountId: "acct-7", credentialDir: tmp });

      expect(ptyHoisted.calls).toHaveLength(1);
      expect(ptyHoisted.calls[0].cmd).toBe("claude");
      expect(ptyHoisted.calls[0].args).toEqual(["/login"]);
      expect(ptyHoisted.calls[0].opts.env?.HOME).toBe(tmp);
      expect(mgr.getActiveAccountId()).toBe("acct-7");
      mgr.kill();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("cancel() releases the account scope, not just the PTY", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-claude-home-"));
    try {
      const mgr = new AuthManager();
      mgr.startOAuthFlow({ accountId: "acct-7", credentialDir: tmp });
      expect(mgr.getActiveAccountId()).toBe("acct-7");

      mgr.cancel();

      expect(mgr.getActiveAccountId()).toBeNull();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("spawns with HOME=/root for the legacy singleton flow", () => {
    const mgr = new AuthManager();
    mgr.startOAuthFlow();
    expect(ptyHoisted.calls[0].opts.env?.HOME).toBe("/root");
    expect(mgr.getActiveAccountId()).toBeNull();
    mgr.kill();
  });

  it("wipes a stale/expired credential file before spawning the login CLI", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-claude-wipe-"));
    try {
      const credPath = path.join(tmp, ".claude", ".credentials.json");
      fs.mkdirSync(path.dirname(credPath), { recursive: true });
      fs.writeFileSync(credPath, '{"expired":true}');

      const mgr = new AuthManager();
      mgr.startOAuthFlow({ accountId: "acct-reauth", credentialDir: tmp });

      expect(fs.existsSync(credPath)).toBe(false);
      expect(ptyHoisted.calls).toHaveLength(1);
      mgr.kill();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("strips ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / CLAUDE_CODE_OAUTH_TOKEN from the login subprocess env", () => {
    const origKey = process.env.ANTHROPIC_API_KEY;
    const origToken = process.env.ANTHROPIC_AUTH_TOKEN;
    const origOauth = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    process.env.ANTHROPIC_API_KEY = "sk-ant-stale";
    process.env.ANTHROPIC_AUTH_TOKEN = "stale-bearer";
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "stale-oauth-token";
    try {
      const mgr = new AuthManager();
      mgr.startOAuthFlow();

      const env = ptyHoisted.calls[0].opts.env!;
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
      expect(process.env.ANTHROPIC_API_KEY).toBe("sk-ant-stale");
      expect(process.env.ANTHROPIC_AUTH_TOKEN).toBe("stale-bearer");
      expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("stale-oauth-token");
      mgr.kill();
    } finally {
      if (origKey !== undefined) process.env.ANTHROPIC_API_KEY = origKey;
      else delete process.env.ANTHROPIC_API_KEY;
      if (origToken !== undefined) process.env.ANTHROPIC_AUTH_TOKEN = origToken;
      else delete process.env.ANTHROPIC_AUTH_TOKEN;
      if (origOauth !== undefined) process.env.CLAUDE_CODE_OAUTH_TOKEN = origOauth;
      else delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    }
  });

  it("tears down a stale PTY and restarts instead of silently no-oping", () => {
    ptyHoisted.killed = 0;
    const mgr = new AuthManager();

    mgr.startOAuthFlow();
    expect(ptyHoisted.calls).toHaveLength(1);
    expect(ptyHoisted.killed).toBe(0);

    mgr.startOAuthFlow();
    expect(ptyHoisted.killed).toBe(1);
    expect(ptyHoisted.calls).toHaveLength(2);
    mgr.kill();
  });
});

describe("AuthManager / auth diagnostics", () => {
  beforeEach(() => {
    ptyHoisted.calls.length = 0;
    ptyHoisted.dataHandlers.length = 0;
    ptyHoisted.exitHandlers.length = 0;
    ptyHoisted.killed = 0;
    ptyHoisted.writes.length = 0;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("emits progress and sanitized CLI logs through the auth flow", () => {
    const mgr = new AuthManager();
    const progress: { phase: string; message: string; attemptId: string }[] = [];
    const logs: { source: string; message: string; attemptId: string }[] = [];
    const pending: string[] = [];
    mgr.on("progress", (p: { phase: string; message: string; attemptId: string }) => progress.push(p));
    mgr.on("log", (l: { source: string; message: string; attemptId: string }) => logs.push(l));
    mgr.on("pending", () => pending.push("pending"));

    mgr.startOAuthFlow();
    expect(progress.map((p) => p.phase)).toContain("starting");
    expect(progress.map((p) => p.phase)).toContain("waiting_for_url");

    ptyHoisted.dataHandlers[0](
      "Browser didn't open?\nhttps://claude.ai/oauth/authorize?code=true&state=super-secret-state\n\nPastecodehereifprompted>",
    );

    expect(pending).toHaveLength(1);
    expect(progress.map((p) => p.phase)).toContain("waiting_for_code");
    // Relayed a line at a time, so the link is its own entry.
    const cli = logs.filter((l) => l.source === "cli_stdout").map((l) => l.message);
    expect(cli.join("")).toContain("https://claude.ai/oauth/authorize?[redacted]");
    expect(cli.join("")).not.toContain("super-secret-state");
    expect(new Set(progress.map((p) => p.attemptId)).size).toBe(1);
    mgr.kill();
  });

  /**
   * A pty echoes what is written to it, so the pasted code comes back on the
   * CLI's own output — which the diagnostics panel shows. The sanitizer's
   * long-secret rule catches a long code and nothing guarantees the code is one.
   */
  it("keeps the pasted code out of the CLI output the pty echoes back", () => {
    const mgr = new AuthManager();
    const logs: { source: string; message: string }[] = [];
    mgr.on("log", (l: { source: string; message: string }) => logs.push(l));

    mgr.startOAuthFlow();
    ptyHoisted.dataHandlers[0](
      "Browser didn't open?\nhttps://claude.ai/oauth/authorize?code=true&state=s\n\nPaste code here if prompted >",
    );
    mgr.sendCode("short-code-1234#state");
    ptyHoisted.dataHandlers[0]("short-code-1234#state\nExchanging the code…\n");

    const panel = logs.map((l) => l.message).join("\n");
    expect(panel, "leaked the authorization code").not.toContain("short-code-1234");
    expect(panel).toContain("Exchanging the code…");
    mgr.kill();
  });

  /**
   * A chunk boundary lands wherever the pty buffer says, and every rule that
   * protects this panel is a whole-string rule. Relaying a line at a time is
   * what makes any of them apply — the code redaction is only one of them.
   */
  it.each([
    {
      name: "a link's query string",
      chunks: ["Open https://claude.ai/oauth/authorize?code=true&sta", "te=private-state-value&hint=x\n"],
      secret: "private-state-value",
    },
    {
      // The first chunk is redacted on its own, which is what makes the second
      // look like ordinary text: the tail is the half that gets published.
      name: "the tail of a bearer token",
      chunks: ["Authorization: Bearer abcdefgh", "ijklmnopqrstuvwx\n"],
      secret: "ijklmnopqrstuvwx",
    },
  ])("redacts $name the pty split across two chunks", ({ chunks, secret }) => {
    const mgr = new AuthManager();
    const logs: { source: string; message: string }[] = [];
    mgr.on("log", (l: { source: string; message: string }) => logs.push(l));

    mgr.startOAuthFlow();
    for (const chunk of chunks) ptyHoisted.dataHandlers[0](chunk);

    expect(logs.map((l) => l.message).join("")).not.toContain(secret);
    mgr.kill();
  });

  /**
   * A chunk boundary is not the only break in the stream: the CLI wraps its own
   * output at the width ShipIt spawned it with, newline included — a capture of
   * this login at 80 columns breaks the link across three lines — so a whole
   * line is still half a secret. Taking the width back from the spawn call is
   * the property under test: a relay unwrapping at a different number is the
   * same defect.
   */
  it("redacts a link the CLI wrapped at the width it was spawned with", () => {
    const mgr = new AuthManager();
    const logs: { message: string }[] = [];
    mgr.on("log", (l: { message: string }) => logs.push(l));

    mgr.startOAuthFlow();
    const cols = ptyHoisted.calls[0].opts.cols ?? 0;
    // The break falls inside `state`, which is where the leak lives: split
    // anywhere else and the assignment rule still recognises the key on the
    // second line, so the test would pass with no unwrapping at all.
    const base = "https://claude.ai/oauth/authorize?hint=";
    const url = `${base}${"x".repeat(cols - base.length - 3)}state=private-state-value`;
    expect(url.slice(0, cols)).toMatch(/sta$/);

    ptyHoisted.dataHandlers[0](`${url.slice(0, cols)}\n${url.slice(cols)}\n`);

    const panel = logs.map((l) => l.message).join("");
    expect(panel).not.toContain("private-state-value");
    // Relaying nothing at all would satisfy the line above.
    expect(panel).toContain("https://claude.ai/oauth/authorize?[redacted]");
    mgr.kill();
  });

  /**
   * A held line is held because it might be half a secret, and cancelling is
   * when the user most wants to read why. `kill()` is the only path left that
   * can drain it — the exit callback runs on a process that has been detached.
   */
  it("relays a held line when the login is cancelled", () => {
    const mgr = new AuthManager();
    const logs: { message: string }[] = [];
    mgr.on("log", (l: { message: string }) => logs.push(l));

    mgr.startOAuthFlow();
    const cols = ptyHoisted.calls[0].opts.cols ?? 0;
    const line = "The Claude CLI could not reach the authentication service.".padEnd(cols, ".");
    ptyHoisted.dataHandlers[0](`${line}\n`);
    expect(logs.map((l) => l.message).join(""), "relayed before the line could be joined")
      .not.toContain("could not reach");

    mgr.cancel();

    expect(logs.map((l) => l.message).join("")).toContain("could not reach");
  });

  /**
   * The flush publishes whatever the CLI had printed, and mid-echo that is the
   * first half of the code — which no whole-code match recognises. It reaches
   * the `[auth output]` log as well as the panel, from the same string.
   */
  it("keeps a half-echoed code out of what cancelling flushes", () => {
    const mgr = new AuthManager();
    const logs: { message: string }[] = [];
    mgr.on("log", (l: { message: string }) => logs.push(l));

    mgr.startOAuthFlow();
    ptyHoisted.dataHandlers[0](
      "https://claude.ai/oauth/authorize?code=true&state=s\n\nPaste code here if prompted >",
    );
    mgr.sendCode("4/short.private/code");
    ptyHoisted.dataHandlers[0]("4/short.private/");

    mgr.cancel();

    expect(logs.map((l) => l.message).join("")).not.toContain("4/short.private/");
  });

  /**
   * A pty colours its echo, so an escape sequence can land inside the code, and
   * split across two chunks neither half is recognisable — which is why chunks
   * are buffered raw and the escapes are stripped off the assembled line.
   */
  it("keeps the code out when an escape sequence splits its echo", () => {
    const mgr = new AuthManager();
    const logs: { source: string; message: string }[] = [];
    mgr.on("log", (l: { source: string; message: string }) => logs.push(l));

    mgr.startOAuthFlow();
    ptyHoisted.dataHandlers[0](
      "Browser didn't open?\nhttps://claude.ai/oauth/authorize?code=true&state=s\n\nPaste code here if prompted >",
    );
    mgr.sendCode("short-code-1234#state");
    ptyHoisted.dataHandlers[0]("echo: short-code-\x1b[9");
    ptyHoisted.dataHandlers[0]("0m1234#state\n");

    const panel = logs.map((l) => l.message).join("");
    expect(panel, "leaked the authorization code").not.toContain("short-code-");
    mgr.kill();
  });

  /**
   * The Claude CLI is a TUI, so a code can arrive as two frames. Neither half
   * matches what was submitted; only the assembled line does.
   */
  it("keeps the pasted code out when the echo is split across two chunks", () => {
    const mgr = new AuthManager();
    const logs: { source: string; message: string }[] = [];
    mgr.on("log", (l: { source: string; message: string }) => logs.push(l));

    mgr.startOAuthFlow();
    ptyHoisted.dataHandlers[0](
      "Browser didn't open?\nhttps://claude.ai/oauth/authorize?code=true&state=s\n\nPaste code here if prompted >",
    );
    mgr.sendCode("short-code-1234#state");
    ptyHoisted.dataHandlers[0]("echo: short-code-");
    ptyHoisted.dataHandlers[0]("1234#state\nExchanging the code…\n");

    // Joined without a separator: two adjacent lines each holding half of the
    // code put the whole code on the screen just as plainly as one line would.
    const panel = logs.map((l) => l.message).join("");
    expect(panel, "leaked the authorization code").not.toContain("short-code-1234");
    expect(panel).toContain("Exchanging the code…");
    mgr.kill();
  });

  /**
   * Only the latest code used to be remembered, so a second submission stripped
   * the first one's protection off output still sitting in the line buffer.
   */
  it("keeps redacting a code the user has already replaced", () => {
    const mgr = new AuthManager();
    const logs: { source: string; message: string }[] = [];
    mgr.on("log", (l: { source: string; message: string }) => logs.push(l));

    mgr.startOAuthFlow();
    ptyHoisted.dataHandlers[0](
      "Browser didn't open?\nhttps://claude.ai/oauth/authorize?code=true&state=s\n\nPaste code here if prompted >",
    );
    mgr.sendCode("first-code-secret");
    ptyHoisted.dataHandlers[0]("echo: first-code-secret");
    mgr.sendCode("second-code-secret");
    ptyHoisted.dataHandlers[0]("\n");

    const panel = logs.map((l) => l.message).join("");
    expect(panel, "leaked the first code once a second was submitted").not.toContain("first-code-secret");
    mgr.kill();
  });

  /**
   * A torn-down login keeps draining. The exit callback already checked the
   * flow generation; the data callback did not, so the old run's output landed
   * on the new attempt and its expired link became that attempt's challenge.
   */
  it("ignores a superseded login process's output", () => {
    const mgr = new AuthManager();
    const logs: { source: string; message: string }[] = [];
    const pending: string[] = [];
    mgr.on("log", (l: { source: string; message: string }) => logs.push(l));
    mgr.on("pending", () => pending.push("pending"));

    mgr.startOAuthFlow();
    const stale = ptyHoisted.dataHandlers[0];
    mgr.startOAuthFlow();
    logs.length = 0;
    pending.length = 0;
    stale("Browser didn't open?\nhttps://claude.ai/oauth/authorize?code=true&state=s\n\nPaste code here if prompted >");

    expect(logs).toEqual([]);
    expect(pending, "replayed the superseded run's link").toEqual([]);
    mgr.kill();
  });

  /**
   * Cancelling is not restarting: nothing supersedes the flow, so the guard has
   * to move when the process is killed as well. A cancelled pty keeps draining.
   */
  it("ignores a cancelled login process's output", () => {
    const mgr = new AuthManager();
    const logs: { source: string; message: string }[] = [];
    const pending: string[] = [];
    mgr.on("log", (l: { source: string; message: string }) => logs.push(l));
    mgr.on("pending", () => pending.push("pending"));

    mgr.startOAuthFlow();
    const drained = ptyHoisted.dataHandlers[0];
    mgr.cancel();
    logs.length = 0;
    pending.length = 0;
    drained("Browser didn't open?\nhttps://claude.ai/oauth/authorize?code=true&state=s\n\nPaste code here if prompted >");

    expect(logs).toEqual([]);
    expect(pending, "replayed the cancelled run's link").toEqual([]);
  });

  /**
   * The panel's redaction has to cover the orchestrator's log too: the same
   * chunk was being printed raw next to the sanitized line it produced.
   */
  it("logs the sanitized line rather than the raw chunk", () => {
    const mgr = new AuthManager();
    const logged: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logged.push(args.map((a) => String(a)).join(" "));
    });

    mgr.startOAuthFlow();
    ptyHoisted.dataHandlers[0](
      "Browser didn't open?\nhttps://claude.ai/oauth/authorize?code=true&state=super-secret-state\n",
    );

    // Every line this manager prints, not only the relayed one: the URL
    // detection printed its own unsanitized copy beside the clean one.
    expect(logged.join("\n"), "printed the link's query string to the server log")
      .not.toContain("super-secret-state");
    spy.mockRestore();
    mgr.kill();
  });

  it("does not submit an empty code when Claude collapses only some prompt spaces", () => {
    const mgr = new AuthManager();
    const pending: string[] = [];
    mgr.on("pending", () => pending.push("pending"));

    mgr.startOAuthFlow();
    ptyHoisted.dataHandlers[0](
      "Browser didn't open?\nhttps://claude.com/cai/oauth/authorize?code=true&state=secret\n\nPaste codehereifprompted >",
    );

    expect(pending).toHaveLength(1);
    vi.advanceTimersByTime(10_000);
    expect(ptyHoisted.writes).toEqual([]);
    mgr.kill();
  });

  it("emits failed progress and diagnostic log when the process exits without fresh credentials", () => {
    const mgr = new AuthManager();
    const progress: { phase: string; message: string }[] = [];
    const logs: { level: string; message: string }[] = [];
    mgr.on("progress", (p: { phase: string; message: string }) => progress.push(p));
    mgr.on("log", (l: { level: string; message: string }) => logs.push(l));

    mgr.startOAuthFlow();
    for (const cb of ptyHoisted.exitHandlers) cb({ exitCode: 1 });

    expect(progress.at(-1)).toMatchObject({ phase: "failed" });
    expect(logs.some((l) => l.level === "error" && l.message.includes("without writing fresh credentials"))).toBe(true);
  });
});

describe("AuthManager / fresh-credential completion gate", () => {
  let tmp: string;
  const CRED_REL = path.join(".claude", ".credentials.json");

  const STALE_MTIME = 1_000_000_000_000;
  const FRESH_MTIME = 2_000_000_000_000;

  function writeCred(mtimeMs: number): void {
    const credPath = path.join(tmp, CRED_REL);
    fs.mkdirSync(path.dirname(credPath), { recursive: true });
    fs.writeFileSync(credPath, "{}");
    const when = new Date(mtimeMs);
    fs.utimesSync(credPath, when, when);
  }

  function track(mgr: AuthManager): { complete: number; failed: { reason?: string }[] } {
    const seen = { complete: 0, failed: [] as { reason?: string }[] };
    mgr.on("complete", () => { seen.complete++; });
    mgr.on("failed", (p?: { reason?: string }) => { seen.failed.push(p ?? {}); });
    return seen;
  }

  beforeEach(() => {
    ptyHoisted.calls.length = 0;
    ptyHoisted.exitHandlers.length = 0;
    ptyHoisted.killed = 0;
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-claude-fresh-"));
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("poll does NOT complete on a pre-existing stale file, and leaves the CLI alive", () => {
    writeCred(STALE_MTIME);
    const mgr = new AuthManager();
    const seen = track(mgr);
    mgr.startOAuthFlow({ accountId: "acct-stale", credentialDir: tmp });
    mgr.sendCode("auth-code-xyz");

    vi.advanceTimersByTime(500);
    expect(seen.complete).toBe(0);
    expect(seen.failed).toHaveLength(0);
    expect(ptyHoisted.killed).toBe(0);

    writeCred(FRESH_MTIME);
    vi.advanceTimersByTime(500);
    expect(seen.complete).toBe(1);
    expect(ptyHoisted.killed).toBe(1);
  });

  it("poll completes when credentials first appear (no pre-existing file)", () => {
    const mgr = new AuthManager();
    const seen = track(mgr);
    mgr.startOAuthFlow({ accountId: "acct-new", credentialDir: tmp });
    mgr.sendCode("auth-code-xyz");

    vi.advanceTimersByTime(500);
    expect(seen.complete).toBe(0);

    writeCred(FRESH_MTIME);
    vi.advanceTimersByTime(500);
    expect(seen.complete).toBe(1);
  });

  it("poll times out (failed) when no fresh write ever lands, despite a stale file", () => {
    writeCred(STALE_MTIME);
    const mgr = new AuthManager();
    const seen = track(mgr);
    mgr.startOAuthFlow({ accountId: "acct-timeout", credentialDir: tmp });
    mgr.sendCode("auth-code-xyz");

    vi.advanceTimersByTime(30_000);
    expect(seen.complete).toBe(0);
    expect(seen.failed).toHaveLength(1);
    expect(seen.failed[0].reason).toBe("timeout");
  });

  it("exit handler reports failure on a stale file (no fresh write)", () => {
    writeCred(STALE_MTIME);
    const mgr = new AuthManager();
    const seen = track(mgr);
    mgr.startOAuthFlow({ accountId: "acct-exit-stale", credentialDir: tmp });

    expect(ptyHoisted.exitHandlers.length).toBeGreaterThan(0);
    for (const cb of ptyHoisted.exitHandlers) cb({ exitCode: 129 });

    expect(seen.complete).toBe(0);
    expect(seen.failed).toHaveLength(1);
    expect(seen.failed[0].reason).toBe("error");
  });

  it("exit handler reports success when the CLI wrote fresh credentials", () => {
    writeCred(STALE_MTIME);
    const mgr = new AuthManager();
    const seen = track(mgr);
    mgr.startOAuthFlow({ accountId: "acct-exit-fresh", credentialDir: tmp });

    writeCred(FRESH_MTIME);
    for (const cb of ptyHoisted.exitHandlers) cb({ exitCode: 0 });

    expect(seen.complete).toBe(1);
    expect(seen.failed).toHaveLength(0);
  });
});

describe("AuthManager / one terminal outcome per flow", () => {
  let tmp: string;
  const CRED_REL = path.join(".claude", ".credentials.json");
  const FRESH_MTIME = 2_000_000_000_000;

  function writeCred(mtimeMs: number): void {
    const credPath = path.join(tmp, CRED_REL);
    fs.mkdirSync(path.dirname(credPath), { recursive: true });
    fs.writeFileSync(credPath, "{}");
    const when = new Date(mtimeMs);
    fs.utimesSync(credPath, when, when);
  }

  function trackScoped(mgr: AuthManager): { complete: (string | null)[]; failed: (string | null)[] } {
    const seen = { complete: [] as (string | null)[], failed: [] as (string | null)[] };
    mgr.on("complete", () => { seen.complete.push(mgr.getActiveAccountId()); });
    mgr.on("failed", () => { seen.failed.push(mgr.getActiveAccountId()); });
    return seen;
  }

  beforeEach(() => {
    ptyHoisted.calls.length = 0;
    ptyHoisted.exitHandlers.length = 0;
    ptyHoisted.killed = 0;
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-claude-once-"));
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("emits exactly one scoped `complete` when the PTY exits after the poll succeeded", () => {
    const mgr = new AuthManager();
    const seen = trackScoped(mgr);
    mgr.startOAuthFlow({ accountId: "acct-once", credentialDir: tmp });
    mgr.sendCode("auth-code-xyz");

    writeCred(FRESH_MTIME);
    vi.advanceTimersByTime(500);
    expect(seen.complete).toEqual(["acct-once"]);

    for (const cb of ptyHoisted.exitHandlers) cb({ exitCode: 129 });
    expect(seen.complete).toEqual(["acct-once"]);
    expect(seen.failed).toEqual([]);
  });

  it("does not turn a completed sign-in into a `failed` when the PTY exits with no credentials on disk", () => {
    const mgr = new AuthManager();
    const seen = trackScoped(mgr);
    mgr.startOAuthFlow({ accountId: "acct-once-gone", credentialDir: tmp });
    mgr.sendCode("auth-code-xyz");

    writeCred(FRESH_MTIME);
    vi.advanceTimersByTime(500);
    expect(seen.complete).toEqual(["acct-once-gone"]);

    fs.rmSync(path.join(tmp, CRED_REL));
    for (const cb of ptyHoisted.exitHandlers) cb({ exitCode: 129 });
    expect(seen.failed).toEqual([]);
  });

  it("a cancelled flow's PTY exit reports nothing", () => {
    const mgr = new AuthManager();
    const seen = trackScoped(mgr);
    mgr.startOAuthFlow({ accountId: "acct-cancelled", credentialDir: tmp });

    mgr.cancel();
    for (const cb of ptyHoisted.exitHandlers) cb({ exitCode: 129 });

    expect(seen.failed).toEqual([]);
    expect(seen.complete).toEqual([]);
  });

  it("a superseded flow's PTY exit does not consume the new flow's terminal event", () => {
    const mgr = new AuthManager();
    const seen = trackScoped(mgr);
    mgr.startOAuthFlow({ accountId: "acct-first", credentialDir: tmp });
    const staleExit = [...ptyHoisted.exitHandlers];

    mgr.startOAuthFlow({ accountId: "acct-second", credentialDir: tmp });
    for (const cb of staleExit) cb({ exitCode: 129 });
    expect(seen.failed).toEqual([]);
    expect(seen.complete).toEqual([]);

    mgr.sendCode("auth-code-xyz");
    writeCred(FRESH_MTIME);
    vi.advanceTimersByTime(500);
    expect(seen.complete).toEqual(["acct-second"]);
  });
});
