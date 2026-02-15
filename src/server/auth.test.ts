import { describe, it, expect } from "vitest";
import { AUTH_URL_PATTERNS, extractAuthUrl } from "./auth.js";

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
});
