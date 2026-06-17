import { describe, it, expect } from "vitest";
import { formatSecretScanNotice } from "./secret-scan-notice.js";
import type { SecretFinding } from "../../shared/secret-scan.js";

const finding = (over: Partial<SecretFinding> = {}): SecretFinding => ({
  rule: "github-pat",
  description: "GitHub personal access / OAuth / app token (gh[pousr]_)",
  file: "src/config.ts",
  line: 11,
  redacted: "ghp_…[redacted, 40 chars]",
  ...over,
});

describe("formatSecretScanNotice", () => {
  it("lists each finding with file:line, description, and the redacted match", () => {
    const msg = formatSecretScanNotice([finding()]);
    expect(msg).toContain("Blocked auto-commit");
    expect(msg).toContain("a likely secret");
    expect(msg).toContain("src/config.ts:11");
    expect(msg).toContain("ghp_…[redacted, 40 chars]");
    expect(msg).toContain("gitleaks:allow");
  });

  it("never echoes a raw token body (only the redacted form is present)", () => {
    const msg = formatSecretScanNotice([finding({ redacted: "ghp_…[redacted, 40 chars]" })]);
    expect(msg).not.toMatch(/ghp_[A-Za-z0-9]{36}/);
  });

  it("pluralizes and counts multiple findings", () => {
    const msg = formatSecretScanNotice([finding(), finding({ file: "a.env", line: undefined })]);
    expect(msg).toContain("2 likely secrets");
    // A finding without a line number falls back to just the file path.
    expect(msg).toContain("`a.env`");
  });

  it("throws on an empty finding list (caller must guard)", () => {
    expect(() => formatSecretScanNotice([])).toThrow();
  });
});
