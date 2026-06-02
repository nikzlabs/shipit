/**
 * Parse a doc's `issue:` frontmatter pointer (docs/168) into a tracker, a short
 * display identifier, and an absolute URL to open. The tracker is inferred from
 * the pointer's shape — no explicit `tracker:` field — so the same field
 * accepts a Linear full URL or a GitHub `owner/repo#N` / full URL.
 *
 * This is a presentational helper for the jump-to-issue chip: it does NOT
 * resolve the issue's live priority/status (that needs the tracker adapters
 * landing with the Issues tab). It only turns the stored pointer into something
 * clickable and legible.
 */
export interface ParsedIssueRef {
  /** Tracker inferred from the pointer shape. */
  tracker: "linear" | "github" | "unknown";
  /** Short identifier for the chip (e.g. "SHI-28", "owner/repo#42"). */
  identifier: string;
  /** Absolute URL to open the issue, when resolvable from the pointer. */
  url?: string;
}

const LINEAR_URL_RE = /^https?:\/\/linear\.app\/[^/]+\/issue\/([A-Za-z]+-\d+)/i;
const GITHUB_URL_RE = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/i;
const GITHUB_SHORT_RE = /^([^/\s]+)\/([^/\s#]+)#(\d+)$/;

export function parseIssueRef(raw: string): ParsedIssueRef {
  const issue = raw.trim();

  const linear = LINEAR_URL_RE.exec(issue);
  if (linear) {
    return { tracker: "linear", identifier: linear[1].toUpperCase(), url: issue };
  }

  const ghUrl = GITHUB_URL_RE.exec(issue);
  if (ghUrl) {
    return {
      tracker: "github",
      identifier: `${ghUrl[1]}/${ghUrl[2]}#${ghUrl[3]}`,
      url: issue,
    };
  }

  const ghShort = GITHUB_SHORT_RE.exec(issue);
  if (ghShort) {
    return {
      tracker: "github",
      identifier: `${ghShort[1]}/${ghShort[2]}#${ghShort[3]}`,
      url: `https://github.com/${ghShort[1]}/${ghShort[2]}/issues/${ghShort[3]}`,
    };
  }

  // Unknown shape — surface the raw pointer, and treat it as a link only if it
  // already looks like an absolute URL.
  return {
    tracker: "unknown",
    identifier: issue,
    url: /^https?:\/\//i.test(issue) ? issue : undefined,
  };
}
