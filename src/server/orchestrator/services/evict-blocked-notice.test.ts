import { describe, it, expect } from "vitest";
import { formatEvictBlockedNotice, type EvictBlockReason } from "./evict-blocked-notice.js";
import type { SecretFinding } from "../../shared/secret-scan.js";

// SHI-294 — the notice a user sees when disk eviction refuses to wipe a
// checkout whose uncommitted work couldn't be committed.
describe("formatEvictBlockedNotice", () => {
  const finding: SecretFinding = {
    rule: "aws-access-key-id",
    description: "AWS access key ID (AKIA…)",
    file: ".env",
    line: 3,
    redacted: "AKIA…(20 chars)",
  };

  it("names each secret finding with its location, and only the redacted match", () => {
    const text = formatEvictBlockedNotice({ kind: "secret", findings: [finding] });
    expect(text).toContain(".env:3");
    expect(text).toContain("AWS access key ID");
    expect(text).toContain("AKIA…(20 chars)");
    // The notice is persisted to the DB — it may only ever carry the redaction.
    expect(text).toContain("gitleaks:allow");
  });

  it("pluralizes multiple findings", () => {
    const text = formatEvictBlockedNotice({
      kind: "secret",
      findings: [finding, { ...finding, file: "config.ts", line: 12 }],
    });
    expect(text).toContain("2 likely secrets");
    expect(text).toContain("config.ts:12");
  });

  it("reports the unresolved-merge cause with its conflicted paths", () => {
    const text = formatEvictBlockedNotice({
      kind: "conflict",
      conflictedFiles: ["src/a.ts"],
      rebaseInProgress: true,
    });
    expect(text).toContain("unresolved merge state");
    expect(text).toContain("rebase is in progress");
    expect(text).toContain("src/a.ts");
  });

  it("still produces a message for an unattributed refusal", () => {
    const text = formatEvictBlockedNotice({ kind: "unknown" });
    expect(text).toContain("Disk cleanup paused");
    expect(text.length).toBeGreaterThan(0);
  });

  it("always states that the work was preserved — the point of the notice", () => {
    const reasons: EvictBlockReason[] = [
      { kind: "secret", findings: [finding] },
      { kind: "conflict", conflictedFiles: [], rebaseInProgress: false },
      { kind: "unknown" },
    ];
    for (const reason of reasons) {
      expect(formatEvictBlockedNotice(reason)).toContain("still on disk");
    }
  });
});
