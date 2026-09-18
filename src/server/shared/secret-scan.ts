export interface SecretRule {
  id: string;
  description: string;
  /** Must be global: scanLine iterates matches. */
  regex: RegExp;
}

// Require a token body so bare prefixes in prose do not match.
export const SECRET_RULES: SecretRule[] = [
  {
    id: "anthropic-api-key",
    description: "Anthropic API key (sk-ant-)",
    regex: /sk-ant-[A-Za-z0-9_-]{20,}/g,
  },
  {
    id: "github-pat",
    description: "GitHub personal access / OAuth / app token (gh[pousr]_)",
    // Open-ended length also catches longer tokens with the same prefix.
    regex: /gh[pousr]_[A-Za-z0-9]{36,}/g,
  },
  {
    id: "github-fine-grained-pat",
    description: "GitHub fine-grained personal access token (github_pat_)",
    regex: /github_pat_[A-Za-z0-9_]{40,}/g,
  },
  {
    id: "github-app-token-stateless",
    description: "GitHub App installation / Actions token, 2026 stateless format (ghs_…_JWT)",
    // The app-ID separator prevents the classic token rule from matching.
    regex: /ghs_[A-Za-z0-9]+_eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
  },
  {
    id: "aws-access-key-id",
    description: "AWS access key ID (AKIA…)",
    regex: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  },
  {
    id: "private-key-block",
    description: "PEM private key block",
    regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g,
  },
  {
    id: "slack-token",
    description: "Slack token (xox[baprs]-)",
    regex: /xox[baprs]-[A-Za-z0-9-]{10,}/g,
  },
  {
    id: "jwt",
    description: "JSON Web Token (eyJ…)",
    regex: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  },
  {
    id: "git-credential-url",
    description: "Token embedded in a git remote URL (x-access-token:…@)",
    regex: /https?:\/\/(?:x-access-token|[A-Za-z0-9._-]+):[^\s/@:]{8,}@/g,
  },
];

const INLINE_ALLOW_MARKERS = ["gitleaks:allow", "shipit:allow-secret"];

// Mirror in .gitleaks.toml. Basename matches or broad docs exemptions permit bypasses.
const ALLOWLIST_PATH_PATTERNS: RegExp[] = [
  /^src\/server\/shared\/secret-scan\.ts$/,
  /^src\/server\/shared\/secret-scan\.test\.ts$/,
  /^src\/server\/shared\/git-secret-scan\.test\.ts$/,
  /^src\/server\/orchestrator\/services\/secret-scan-notice\.ts$/,
  /^src\/server\/orchestrator\/services\/secret-scan-notice\.test\.ts$/,
  /^docs\/\d+-secret-scan-autocommit\//,
];

export function isAllowlistedPath(filePath: string): boolean {
  return ALLOWLIST_PATH_PATTERNS.some((re) => re.test(filePath));
}

export interface SecretFinding {
  rule: string;
  description: string;
  file: string;
  /** 1-based line in the new file. */
  line?: number;
  redacted: string;
}

export function redactSecret(match: string): string {
  const prefix = match.slice(0, 4);
  return `${prefix}…[redacted, ${match.length} chars]`;
}

export function redactSecretsInText(text: string): string {
  let out = text;
  for (const rule of SECRET_RULES) {
    rule.regex.lastIndex = 0;
    out = out.replace(rule.regex, (m) => redactSecret(m));
  }
  return out;
}

function scanLine(content: string): { rule: SecretRule; match: string }[] {
  if (INLINE_ALLOW_MARKERS.some((m) => content.includes(m))) return [];
  const out: { rule: SecretRule; match: string }[] = [];
  for (const rule of SECRET_RULES) {
    rule.regex.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rule.regex.exec(content)) !== null) {
      out.push({ rule, match: m[0] });
      // Advance past zero-width matches to avoid an infinite loop.
      if (m.index === rule.regex.lastIndex) rule.regex.lastIndex++;
    }
  }
  return out;
}

export function scanDiffForSecrets(diff: string): SecretFinding[] {
  if (!diff) return [];
  const findings: SecretFinding[] = [];
  const seen = new Set<string>();

  let currentFile = "(staged change)";
  let fileAllowlisted = false;
  let newLineNo = 0;

  for (const rawLine of diff.split("\n")) {
    if (rawLine.startsWith("+++ ")) {
      const target = rawLine.slice(4).trim();
      currentFile = target.replace(/^b\//, "");
      if (currentFile === "/dev/null") currentFile = "(staged change)";
      fileAllowlisted = isAllowlistedPath(currentFile);
      // Report a secret-bearing filename through a placeholder, never its raw path.
      if (!fileAllowlisted) {
        for (const { rule, match } of scanLine(currentFile)) {
          const redacted = redactSecret(match);
          const key = `filename|${rule.id}|${redacted}`;
          if (seen.has(key)) continue;
          seen.add(key);
          findings.push({
            rule: rule.id,
            description: `${rule.description} — in a file name`,
            file: "(file name)",
            redacted,
          });
        }
      }
      continue;
    }
    if (rawLine.startsWith("--- ")) continue;
    if (rawLine.startsWith("@@")) {
      const m = /\+(\d+)/.exec(rawLine);
      newLineNo = m ? parseInt(m[1], 10) : 0;
      continue;
    }
    if (rawLine.startsWith("+")) {
      const content = rawLine.slice(1);
      if (!fileAllowlisted) {
        for (const { rule, match } of scanLine(content)) {
          const redacted = redactSecret(match);
          const key = `${currentFile}|${rule.id}|${redacted}`;
          if (seen.has(key)) {
            newLineNo++;
            continue;
          }
          seen.add(key);
          findings.push({
            rule: rule.id,
            description: rule.description,
            file: currentFile,
            line: newLineNo > 0 ? newLineNo : undefined,
            redacted,
          });
        }
      }
      newLineNo++;
      continue;
    }
    if (rawLine.startsWith(" ")) newLineNo++;
  }

  return findings;
}
