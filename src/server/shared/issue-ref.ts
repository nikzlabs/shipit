/**
 * Parse an issue pointer into a tracker, a short display identifier, a
 * tracker-native id, and (when resolvable) an absolute URL.
 *
 * The pointer is whatever a doc's `issue:` frontmatter (docs/168) or a user
 * holds: a Linear full URL, a bare Linear key (`SHI-28`), a GitHub
 * `owner/repo#N`, or a GitHub issue URL. The tracker is inferred from the
 * pointer's *shape* — there is no explicit `tracker:` field.
 *
 * This is the single pointer→tracker resolver shared by the client (the
 * jump-to-issue chip) and the server (the `shipit issue` shim path, docs/175).
 * Two fields matter to each consumer:
 *
 *  - `identifier` is the combined, human-legible display form (`owner/repo#42`,
 *    `SHI-28`) — what the chip renders.
 *  - `issueId` is the **tracker-native** id that `Tracker.getIssue(id)` wants:
 *    the bare issue **number** for GitHub (its adapter builds
 *    `/repos/{owner}/{repo}/issues/${id}`), and the **key** for Linear. The
 *    combined `identifier` is NOT what `getIssue` wants — passing `owner/repo#42`
 *    to GitHub yields `/issues/owner%2Frepo%2342` → 404.
 */
export interface ParsedIssueRef {
  /** Tracker inferred from the pointer shape. */
  tracker: "linear" | "github" | "unknown";
  /** Short identifier for display (e.g. "SHI-28", "owner/repo#42"). */
  identifier: string;
  /**
   * Tracker-native id for `Tracker.getIssue(id)`: the bare number for GitHub,
   * the key for Linear. Absent for an unknown pointer shape.
   */
  issueId?: string;
  /** Absolute URL to open the issue, when resolvable from the pointer. */
  url?: string;
}

const LINEAR_URL_RE = /^https?:\/\/linear\.app\/[^/]+\/issue\/([A-Za-z]+-\d+)/i;
const GITHUB_URL_RE = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/i;
const GITHUB_SHORT_RE = /^([^/\s]+)\/([^/\s#]+)#(\d+)$/;
/** A bare Linear key like `SHI-28` — the form an `issue:` pointer most often holds. */
const LINEAR_KEY_RE = /^([A-Za-z]+-\d+)$/;

export function parseIssueRef(raw: string): ParsedIssueRef {
  const issue = raw.trim();

  const linear = LINEAR_URL_RE.exec(issue);
  if (linear) {
    const key = linear[1].toUpperCase();
    return { tracker: "linear", identifier: key, issueId: key, url: issue };
  }

  const ghUrl = GITHUB_URL_RE.exec(issue);
  if (ghUrl) {
    return {
      tracker: "github",
      identifier: `${ghUrl[1]}/${ghUrl[2]}#${ghUrl[3]}`,
      issueId: ghUrl[3],
      url: issue,
    };
  }

  const ghShort = GITHUB_SHORT_RE.exec(issue);
  if (ghShort) {
    return {
      tracker: "github",
      identifier: `${ghShort[1]}/${ghShort[2]}#${ghShort[3]}`,
      issueId: ghShort[3],
      url: `https://github.com/${ghShort[1]}/${ghShort[2]}/issues/${ghShort[3]}`,
    };
  }

  // A bare Linear key (`SHI-28`). No URL is derivable without the workspace
  // slug, but the tracker + native id are enough for `getIssue`.
  const linearKey = LINEAR_KEY_RE.exec(issue);
  if (linearKey) {
    const key = linearKey[1].toUpperCase();
    return { tracker: "linear", identifier: key, issueId: key };
  }

  // Unknown shape — surface the raw pointer, and treat it as a link only if it
  // already looks like an absolute URL.
  return {
    tracker: "unknown",
    identifier: issue,
    url: /^https?:\/\//i.test(issue) ? issue : undefined,
  };
}
