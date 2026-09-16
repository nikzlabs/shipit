import { describe, expect, it } from "vitest";
import { sanitizeAuthDiagnostic } from "./auth-diagnostics.js";

describe("sanitizeAuthDiagnostic", () => {
  it("redacts auth URL details, token-like values, emails, API keys, and credential paths", () => {
    const sanitized = sanitizeAuthDiagnostic(
      "Open https://claude.ai/oauth/authorize?code=true&state=secret-state&code_challenge=secret-challenge " +
      "for person@example.com with Authorization: Bearer abcdefghijklmnop and sk-ant-secret " +
      "from /root/.claude/.credentials.json plus /credentials/.claude/auth.json",
    );

    expect(sanitized).toContain("https://claude.ai/oauth/authorize?[redacted]");
    expect(sanitized).toContain("[email redacted]");
    expect(sanitized).toContain("Bearer [redacted]");
    expect(sanitized).toContain("sk-ant-[redacted]");
    expect(sanitized).toContain("/root/.[redacted]");
    expect(sanitized).toContain("/credentials/[redacted]");
    expect(sanitized).not.toContain("secret-state");
    expect(sanitized).not.toContain("person@example.com");
    expect(sanitized).not.toContain("abcdefghijklmnop");
  });

  /**
   * The path rule used to name `.claude` and `.codex` only, which was already
   * one harness short: Antigravity's token sits under `.gemini`.
   */
  it("redacts a credential path under any harness's home directory", () => {
    const sanitized = sanitizeAuthDiagnostic(
      "wrote /root/.gemini/antigravity-cli/antigravity-oauth-token",
    );

    expect(sanitized).toBe("wrote /root/.[redacted]");
  });
});
