import type { SecretFinding } from "../../shared/secret-scan.js";

/** Findings must already contain redacted matches; this notice is persisted. */
export function formatSecretScanNotice(findings: SecretFinding[]): string {
  if (findings.length === 0) {
    throw new Error("formatSecretScanNotice: findings must be non-empty");
  }
  const noun = findings.length === 1 ? "a likely secret" : `${findings.length} likely secrets`;
  const lines = findings.map((f) => {
    const where = f.line ? `${f.file}:${f.line}` : f.file;
    return `- \`${where}\` — ${f.description} (\`${f.redacted}\`)`;
  });
  return (
    `🔒 Blocked auto-commit — found ${noun} in the staged changes:\n\n` +
    `${lines.join("\n")}\n\n` +
    `Nothing was committed or pushed; the change is still in your working tree. ` +
    `Remove the secret (use an environment variable or a ShipIt secret instead) ` +
    `and the next turn will commit normally. ` +
    `If this is a false positive, add a \`gitleaks:allow\` comment to the line.`
  );
}
