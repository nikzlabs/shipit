import { describe, it, expect } from "vitest";
import { textIndicatesProviderEdgeBlock, transientProviderErrorKind } from "./provider-errors.js";

const CLOUDFLARE_PAGE =
  "<!DOCTYPE html><html><head><title>Attention Required! | Cloudflare</title></head><body>blocked</body></html>";

describe("transientProviderErrorKind", () => {
  it.each([
    // 2026-11-13: the CLI's words for Cloudflare's block page.
    ["Claude Code's Cloudflare 403", "Failed to authenticate. API Error: 403 Attention Required! | Cloudflare", "edge-block"],
    ["a 403 with the page", `API Error: 403 ${CLOUDFLARE_PAGE}`, "edge-block"],
    [
      "OpenCode 2's notice for it (#3351)",
      "Anthropic's edge blocked this request: Cloudflare at api.anthropic.com answered with a 403 block page, so this turn stopped.",
      "edge-block",
    ],
    ["Claude Code's 529", "API Error: Repeated 529 Overloaded errors", "overloaded"],
    ["a 529 body", 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}', "overloaded"],
    ["a 500", 'API Error: 500 {"type":"error","error":{"type":"api_error","message":"Internal server error"}}', "server-error"],
    ["a 503", "API Error: 503 Service Unavailable", "server-error"],
    ["OpenCode 2's bare overload", "Overloaded", "overloaded"],
    ["OpenCode 2's bare 502", "Bad Gateway", "server-error"],
  ])("%s", (_label, text, kind) => {
    expect(transientProviderErrorKind(text)).toBe(kind);
  });

  it.each([
    ["a real 401", "API Error: 401 Invalid authentication credentials"],
    ["not logged in", "Not logged in · Please run /login"],
    ["a 400", 'API Error: 400 {"type":"error","error":{"type":"invalid_request_error"}}'],
    ["a JSON 403", 'API Error: 403 {"type":"error","error":{"type":"permission_error"}}'],
    ["prose about a server error", "The app returns an internal server error on /login, so I fixed the handler."],
    ["a quota refusal", "Claude AI usage limit reached|1793141022"],
    ["nothing", undefined],
  ])("%s is not one", (_label, text) => {
    expect(transientProviderErrorKind(text)).toBeNull();
  });
});

describe("textIndicatesProviderEdgeBlock", () => {
  it("is not a 401, whatever it says", () => {
    expect(textIndicatesProviderEdgeBlock("Attention Required! | Cloudflare", 401)).toBe(false);
  });

  it("needs Cloudflare or HTML beside a 403", () => {
    expect(textIndicatesProviderEdgeBlock("API Error: 403 Forbidden")).toBe(false);
    expect(textIndicatesProviderEdgeBlock("Forbidden", 403)).toBe(false);
    expect(textIndicatesProviderEdgeBlock("<html>no</html>", 403)).toBe(true);
  });
});
