/**
 * docs/213 — high-signal secret detector for the post-turn auto-commit guard.
 *
 * ShipIt auto-commits the agent's working-tree changes after every turn. A
 * real (now-revoked) GitHub PAT once slipped into a commit message and a
 * `docs/*.md` file and could not be fully scrubbed from history. The durable
 * fix is prevention at commit time: `GitManager.autoCommit` scans the staged
 * diff with `scanDiffForSecrets` and refuses the whole commit when a likely
 * credential is found (see git.ts), so a secret never enters a commit/push.
 *
 * Design constraints:
 *  - HIGH SIGNAL, LOW FALSE-POSITIVE. We only match patterns whose *shape* is
 *    distinctive enough that a real match is almost certainly a live secret —
 *    a public scheme prefix (`ghp_`, `sk-ant-`, `AKIA`, …) followed by a token
 *    body of realistic length. A bare prefix mentioned in prose or a comment
 *    (`"paste your ghp_… token here"`) does NOT match, by requiring the token
 *    body. This keeps docs, examples, and this very file from tripping it.
 *  - CHEAP. Pure synchronous regex over the *added* lines of a staged diff
 *    (not the whole tree), run once per commit. No I/O, no network.
 *  - ALLOWLIST-AWARE. A per-line `gitleaks:allow` / `shipit:allow-secret`
 *    marker, plus a path allowlist that mirrors the companion `.gitleaks.toml`
 *    `[allowlist]`, let a genuine false positive through without a code change.
 *
 * Keep the rule set small and well-commented so it's easy to extend. When you
 * add a rule here, mirror it (and any path allowlist entry) into `.gitleaks.toml`
 * so the diff-only CI backstop stays in sync.
 */

/** One detector rule. `regex` MUST be global (`g`) — `scanLine` iterates matches. */
export interface SecretRule {
  /** Stable short id, also used in the user-facing notice. */
  id: string;
  /** Human-readable description shown in the warning notice. */
  description: string;
  /** Global regex matching the *whole* secret token (used for redaction length). */
  regex: RegExp;
}

/**
 * The rule set. Each pattern requires enough of the token body that a bare
 * scheme prefix in prose won't match. Ordered roughly by specificity.
 *
 * NOTE: the literal pattern strings below are regex *source*, not secrets — the
 * char-classes (`[A-Za-z0-9_-]{n,}`) never match the source text itself, so this
 * module is not self-tripping. The detector test file IS allowlisted by path
 * (it contains realistic fixtures), see `isAllowlistedPath`.
 */
export const SECRET_RULES: SecretRule[] = [
  {
    id: "anthropic-api-key",
    description: "Anthropic API key (sk-ant-)",
    // sk-ant-... keys are long; require a substantial token body.
    regex: /sk-ant-[A-Za-z0-9_-]{20,}/g,
  },
  {
    id: "github-pat",
    description: "GitHub personal access / OAuth / app token (gh[pousr]_)",
    // GitHub's prefixed-token family: `ghp_`/`gho_`/`ghu_`/`ghs_`/`ghr_` + a
    // base62 body. The body length is OPEN-ENDED (`{36,}`, not exactly 36) on
    // purpose: today's tokens are 36 chars after the prefix, but a length change
    // by GitHub shouldn't blind the detector. A *new prefix* or a *new alphabet*
    // would still need a rule edit — that's what the gitleaks CI backstop (which
    // tracks upstream pattern updates) and this maintained rule set are for.
    regex: /gh[pousr]_[A-Za-z0-9]{36,}/g,
  },
  {
    id: "github-fine-grained-pat",
    description: "GitHub fine-grained personal access token (github_pat_)",
    // Distinct prefix + a longer body that itself contains an underscore (a
    // 22-char id, `_`, then the secret). gitleaks pins this to exactly 82 word
    // chars; we use an open-ended `{40,}` so a future length change still trips.
    regex: /github_pat_[A-Za-z0-9_]{40,}/g,
  },
  {
    id: "aws-access-key-id",
    description: "AWS access key ID (AKIA…)",
    // AKIA/ASIA + exactly 16 uppercase-alphanumerics.
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
    // header.payload.signature, each base64url; header always starts `eyJ`.
    regex: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  },
  {
    id: "git-credential-url",
    description: "Token embedded in a git remote URL (x-access-token:…@)",
    // `https://x-access-token:<token>@github.com/...` and the generic
    // `https://user:<token>@host` form the historical leak rode in on.
    regex: /https?:\/\/(?:x-access-token|[A-Za-z0-9._-]+):[^\s/@:]{8,}@/g,
  },
];

/**
 * Per-line override markers. A line containing either is skipped — the
 * `gitleaks:allow` form is the gitleaks convention (so the same marker silences
 * both this guard and the CI backstop); `shipit:allow-secret` is the explicit
 * ShipIt alias. This is how a user overrides a genuine false positive: add the
 * marker comment to the line and re-run the turn.
 */
const INLINE_ALLOW_MARKERS = ["gitleaks:allow", "shipit:allow-secret"];

/**
 * Path allowlist — files that legitimately contain pattern-shaped strings
 * (the detector + its tests, the gitleaks config, this feature's own design
 * doc). MIRROR these into `.gitleaks.toml`'s `[allowlist] paths` so the CI
 * backstop agrees. Deliberately narrow: the historical leak was in a generic
 * `docs/*.md`, so we do NOT allowlist docs broadly — only this feature's dir.
 */
const ALLOWLIST_PATH_PATTERNS: RegExp[] = [
  /(^|\/)secret-scan\.ts$/,
  /(^|\/)secret-scan\.test\.ts$/,
  /(^|\/)git-secret-scan\.test\.ts$/,
  /(^|\/)secret-scan-notice\.ts$/,
  /(^|\/)secret-scan-notice\.test\.ts$/,
  /(^|\/)\.gitleaks\.toml$/,
  /(^|\/)docs\/\d+-secret-scan-autocommit\//,
];

/** True when `filePath` is exempt from scanning (see ALLOWLIST_PATH_PATTERNS). */
export function isAllowlistedPath(filePath: string): boolean {
  return ALLOWLIST_PATH_PATTERNS.some((re) => re.test(filePath));
}

/** A single detected secret, with the match redacted for safe display. */
export interface SecretFinding {
  /** Rule id (e.g. "github-pat"). */
  rule: string;
  /** Human-readable rule description. */
  description: string;
  /** File path (from the diff `+++ b/<path>` header), or "(staged change)". */
  file: string;
  /** 1-based line number within the new file, when derivable from the hunk. */
  line?: number;
  /** Redacted form of the match — only a short public prefix is revealed. */
  redacted: string;
}

/**
 * Redact a matched secret so the notice can name it without re-leaking it.
 * Reveals only the first 4 characters (always a public scheme prefix for our
 * rules — `ghp_`, `sk-a`, `AKIA`, `eyJ…`) and the total length. Never echoes
 * the token body.
 */
export function redactSecret(match: string): string {
  const prefix = match.slice(0, 4);
  return `${prefix}…[redacted, ${match.length} chars]`;
}

/** Scan one line of (already-stripped) added content for any rule match. */
function scanLine(content: string): { rule: SecretRule; match: string }[] {
  if (INLINE_ALLOW_MARKERS.some((m) => content.includes(m))) return [];
  const out: { rule: SecretRule; match: string }[] = [];
  for (const rule of SECRET_RULES) {
    rule.regex.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rule.regex.exec(content)) !== null) {
      out.push({ rule, match: m[0] });
      // Guard against zero-width matches looping forever (none of our rules are,
      // but be defensive if a future rule is edited).
      if (m.index === rule.regex.lastIndex) rule.regex.lastIndex++;
    }
  }
  return out;
}

/**
 * Scan a unified `git diff` for secrets in ADDED lines only. Parses the
 * `+++ b/<path>` file headers and `@@ … +start,count @@` hunk headers so each
 * finding carries its file and (best-effort) new-file line number. Removed and
 * context lines are ignored — we only care about content the commit introduces.
 *
 * Findings are de-duplicated by (file, rule, redacted) so a token repeated on
 * several lines reports once.
 */
export function scanDiffForSecrets(diff: string): SecretFinding[] {
  if (!diff) return [];
  const findings: SecretFinding[] = [];
  const seen = new Set<string>();

  let currentFile = "(staged change)";
  let fileAllowlisted = false;
  let newLineNo = 0;

  for (const rawLine of diff.split("\n")) {
    // File header: `+++ b/path/to/file` (or `+++ /dev/null` for deletions).
    if (rawLine.startsWith("+++ ")) {
      const target = rawLine.slice(4).trim();
      currentFile = target.replace(/^b\//, "");
      if (currentFile === "/dev/null") currentFile = "(staged change)";
      fileAllowlisted = isAllowlistedPath(currentFile);
      continue;
    }
    // The `---` old-file header must not be treated as a removed content line.
    if (rawLine.startsWith("--- ")) continue;
    // Hunk header: `@@ -a,b +c,d @@` — reset the new-file line counter to `c`.
    if (rawLine.startsWith("@@")) {
      const m = /\+(\d+)/.exec(rawLine);
      newLineNo = m ? parseInt(m[1], 10) : 0;
      continue;
    }
    // Added line.
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
    // Context line (starts with a space) advances the new-file counter; a
    // removed line (`-`) does not.
    if (rawLine.startsWith(" ")) newLineNo++;
  }

  return findings;
}
