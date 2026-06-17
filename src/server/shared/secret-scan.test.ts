import { describe, it, expect } from "vitest";
import {
  scanDiffForSecrets,
  redactSecret,
  isAllowlistedPath,
  SECRET_RULES,
} from "./secret-scan.js";

// Fixtures below are NOT real credentials — they are pattern-shaped strings used
// to exercise the detector. This file is allowlisted by path in secret-scan.ts,
// so it never trips the auto-commit guard on ShipIt's own branch.
const FAKE = {
  anthropic: "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA1234567890bbbb",
  githubPat: "ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789",
  aws: "AKIAIOSFODNN7EXAMPLE",
  slack: "xoxb-1234567890-ABCDEFGHIJKLMNOP",
  jwt: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
  pem: "-----BEGIN RSA PRIVATE KEY-----",
  credUrl: "https://x-access-token:ghs_SomeTokenValue1234567890@github.com/o/r.git",
};

/** Build a minimal unified diff that ADDS `lines` to `file`. */
function addedDiff(file: string, lines: string[]): string {
  const body = lines.map((l) => `+${l}`).join("\n");
  return [
    `diff --git a/${file} b/${file}`,
    "new file mode 100644",
    "index 0000000..1111111",
    "--- /dev/null",
    `+++ b/${file}`,
    `@@ -0,0 +1,${lines.length} @@`,
    body,
  ].join("\n");
}

describe("scanDiffForSecrets — detection", () => {
  it("detects an Anthropic key in an added line", () => {
    const findings = scanDiffForSecrets(addedDiff("src/config.ts", [`const k = "${FAKE.anthropic}";`]));
    expect(findings).toHaveLength(1);
    expect(findings[0].rule).toBe("anthropic-api-key");
    expect(findings[0].file).toBe("src/config.ts");
  });

  it("detects a GitHub PAT", () => {
    const f = scanDiffForSecrets(addedDiff("a.txt", [FAKE.githubPat]));
    expect(f.map((x) => x.rule)).toContain("github-pat");
  });

  it("detects an AWS access key id", () => {
    const f = scanDiffForSecrets(addedDiff("a.txt", [`AWS_KEY=${FAKE.aws}`]));
    expect(f.map((x) => x.rule)).toContain("aws-access-key-id");
  });

  it("detects a Slack token", () => {
    const f = scanDiffForSecrets(addedDiff("a.txt", [FAKE.slack]));
    expect(f.map((x) => x.rule)).toContain("slack-token");
  });

  it("detects a JWT", () => {
    const f = scanDiffForSecrets(addedDiff("a.txt", [FAKE.jwt]));
    expect(f.map((x) => x.rule)).toContain("jwt");
  });

  it("detects a PEM private key header", () => {
    const f = scanDiffForSecrets(addedDiff("key.pem", [FAKE.pem, "MIIE.....", "-----END RSA PRIVATE KEY-----"]));
    expect(f.map((x) => x.rule)).toContain("private-key-block");
  });

  it("detects a token embedded in a git remote URL", () => {
    const f = scanDiffForSecrets(addedDiff("setup.sh", [`git remote add origin ${FAKE.credUrl}`]));
    expect(f.map((x) => x.rule)).toContain("git-credential-url");
  });

  it("reports the new-file line number from the hunk header", () => {
    const diff = [
      "diff --git a/f.ts b/f.ts",
      "--- a/f.ts",
      "+++ b/f.ts",
      "@@ -10,2 +10,3 @@",
      " context line",
      `+const token = "${FAKE.githubPat}";`,
      " another context",
    ].join("\n");
    const f = scanDiffForSecrets(diff);
    expect(f).toHaveLength(1);
    expect(f[0].line).toBe(11);
  });
});

describe("scanDiffForSecrets — no false positives", () => {
  it("ignores a bare scheme prefix without a token body (prose / placeholder)", () => {
    const lines = [
      "Paste your ghp_ token here, then run setup.",
      "The sk-ant- prefix identifies Anthropic keys.",
      "Set AWS_ACCESS_KEY_ID to your AKIA value.",
    ];
    expect(scanDiffForSecrets(addedDiff("README.md", lines))).toEqual([]);
  });

  it("ignores removed and context lines (only added content is scanned)", () => {
    const diff = [
      "diff --git a/f.ts b/f.ts",
      "--- a/f.ts",
      "+++ b/f.ts",
      "@@ -1,2 +1,1 @@",
      ` const old = "${FAKE.githubPat}";`, // context line — must be ignored
      `-const removed = "${FAKE.anthropic}";`, // removed line — must be ignored
      "+const clean = 1;",
    ].join("\n");
    expect(scanDiffForSecrets(diff)).toEqual([]);
  });

  it("returns [] for an empty diff", () => {
    expect(scanDiffForSecrets("")).toEqual([]);
  });
});

describe("scanDiffForSecrets — allowlist overrides", () => {
  it("skips a line carrying the gitleaks:allow marker", () => {
    const f = scanDiffForSecrets(addedDiff("a.ts", [`const k = "${FAKE.anthropic}"; // gitleaks:allow`]));
    expect(f).toEqual([]);
  });

  it("skips a line carrying the shipit:allow-secret marker", () => {
    const f = scanDiffForSecrets(addedDiff("a.ts", [`const k = "${FAKE.githubPat}" // shipit:allow-secret`]));
    expect(f).toEqual([]);
  });

  it("skips an allowlisted path entirely", () => {
    const f = scanDiffForSecrets(addedDiff("src/server/shared/secret-scan.test.ts", [FAKE.githubPat]));
    expect(f).toEqual([]);
  });

  it("does NOT allowlist a generic docs markdown file", () => {
    // The historical leak was in docs/*.md — those must still be scanned.
    const f = scanDiffForSecrets(addedDiff("docs/099-foo/plan.md", [FAKE.githubPat]));
    expect(f.map((x) => x.rule)).toContain("github-pat");
  });
});

describe("isAllowlistedPath", () => {
  it("allowlists the detector, its tests, gitleaks config, and this feature dir", () => {
    expect(isAllowlistedPath("src/server/shared/secret-scan.ts")).toBe(true);
    expect(isAllowlistedPath("src/server/shared/secret-scan.test.ts")).toBe(true);
    expect(isAllowlistedPath(".gitleaks.toml")).toBe(true);
    expect(isAllowlistedPath("docs/213-secret-scan-autocommit/plan.md")).toBe(true);
  });
  it("does not allowlist ordinary source or docs", () => {
    expect(isAllowlistedPath("src/server/shared/git.ts")).toBe(false);
    expect(isAllowlistedPath("docs/001-foo/plan.md")).toBe(false);
  });
});

describe("redactSecret", () => {
  it("reveals only a 4-char prefix and the length, never the body", () => {
    const r = redactSecret(FAKE.githubPat);
    expect(r.startsWith("ghp_")).toBe(true);
    expect(r).toContain("[redacted");
    expect(r).not.toContain(FAKE.githubPat.slice(4));
  });

  it("dedupes a token repeated across lines into one finding", () => {
    const f = scanDiffForSecrets(addedDiff("a.ts", [FAKE.githubPat, FAKE.githubPat, FAKE.githubPat]));
    expect(f).toHaveLength(1);
  });
});

describe("SECRET_RULES", () => {
  it("every rule uses a global regex (required by the line scanner)", () => {
    for (const rule of SECRET_RULES) {
      expect(rule.regex.flags).toContain("g");
    }
  });
});
