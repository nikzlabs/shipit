import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  AUTH_URL_PATTERNS,
  AuthManager,
  extractAccessToken,
  extractAuthUrl,
  extractExpiresAt,
  extractPlanLabel,
  extractUrlFromBuffer,
} from "./auth-manager.js";

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
    // AUTH_URL_PATTERNS is ordered: console > claude.ai > generic auth > login
    const text = "Open https://console.anthropic.com/login?code=abc";
    const result = extractAuthUrl(text);
    expect(result).toBe("https://console.anthropic.com/login?code=abc");
  });

  it("strips ANSI escape codes before matching", () => {
    // PTY output includes ANSI codes for colors, cursor movement, etc.
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
    // Real-world scenario: PTY wraps at 80 chars, splitting the URL.
    // An empty line separates the URL block from the "Paste code here" prompt.
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
    // CLI outputs redirect URL first, then the code-paste URL
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
    // URLs shorter than 20 chars are rejected
    expect(extractUrlFromBuffer("https://a.b")).toBeNull();
  });

  it("stops at non-URL characters like spaces", () => {
    const buffer = "https://claude.ai/oauth?code=abc more text here";
    expect(extractUrlFromBuffer(buffer)).toBe("https://claude.ai/oauth?code=abc");
  });

  it("handles real Docker PTY output with 6-line wrapped URL", () => {
    // Exact format from Docker logs — URL wrapped at ~80 cols, two blank lines
    // before "Paste code here" trigger (PTY strips spaces from trigger text)
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
    // PTY may emit \x1b[?25l (hide cursor) which the basic ANSI regex misses
    const buffer = "\x1b[?25lhttps://claude.ai/oauth/authorize?code=true&client_id=abc123\x1b[?25h\n\nDone";
    expect(extractUrlFromBuffer(buffer)).toBe("https://claude.ai/oauth/authorize?code=true&client_id=abc123");
  });

  it("handles trigger text glued directly to URL end (no empty line)", () => {
    // The PTY may glue the "Paste code here" prompt directly onto the URL
    // with no newline between. The caller (AuthManager) truncates at the
    // trigger position, so extractUrlFromBuffer receives a clean buffer.
    const fullBuffer = "https://claude.ai/oauth/authorize?code=true&state=abc123Pastecodehereifprompted";
    // Simulating what AuthManager does: truncate at trigger position
    const triggerPos = fullBuffer.indexOf("Pastecodehereifprompted");
    const truncated = fullBuffer.substring(0, triggerPos);
    expect(extractUrlFromBuffer(truncated)).toBe("https://claude.ai/oauth/authorize?code=true&state=abc123");
  });
});

describe("AuthManager.checkCredentials", () => {
  // Save/restore Anthropic auth env vars so tests don't depend on the host
  // shell and don't leak state between tests. We don't try to assert the
  // *unauthenticated* case here because the dev container may have a real
  // ~/.claude/.credentials.json on disk that flips the OR'd authentication
  // check on regardless of env. The disk-only path is already exercised
  // implicitly by the production deploy; what's new in this change is the
  // env-var branch.
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
    // ShipIt-in-ShipIt: the outer orch forwards its Claude OAuth access
    // token to the inner orch as ANTHROPIC_AUTH_TOKEN. The inner orch has
    // no /root/.claude/.credentials.json on disk, so this env var is the
    // only signal that authentication is configured. Before this fix
    // checkCredentials() only looked at ANTHROPIC_API_KEY and would report
    // the inner orch as unauthenticated in OAuth-only setups.
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
  // Mirrors the exact shape captured during doc 135 Phase 0 against a
  // real Anthropic Max-20x credentials file.
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
