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

/**
 * Extract issue pointers from FREE-FORM text — e.g. a session's first user
 * message — as opposed to the keyword-anchored PR-body parse
 * ({@link parsePrBodyIssueRefs}). Used to recover the issue a session was
 * *started from*: `seedFromIssueRef` plants `You are working on issue <KEY>: …`
 * + `Issue link: <url>` as the first message (docs/206).
 *
 * Only UNAMBIGUOUS shapes are matched, on purpose. A bare Linear key pattern
 * (`[A-Z]+-\d+`) collides with everyday tokens — `UTF-8`, `ISO-8601`, `GPT-4`,
 * `H-1B` — so scanning raw text for it would mint phantom issues. The accepted
 * shapes:
 *
 *  - Linear issue URLs   `https://linear.app/<ws>/issue/KEY[/slug]`
 *  - GitHub issue URLs   `https://github.com/<o>/<r>/issues/<n>`
 *  - GitHub short refs   `owner/repo#n`
 *  - Bare Linear keys **only when preceded by the word `issue`**
 *    (case-insensitive: `working on issue SHI-90`, `issue: SHI-90`) — the form
 *    the seed always produces and natural phrasing usually does. A bare
 *    `SHI-90` with no `issue` lead-in is deliberately NOT matched.
 *
 * Deduped by `tracker:issueId` in first-seen order; unresolvable tokens drop.
 */
export function extractIssueRefsFromText(text: string | null | undefined): ParsedIssueRef[] {
  if (!text) return [];
  const out: ParsedIssueRef[] = [];
  const seen = new Set<string>();
  // Gather every candidate with its position, so the final list is in document
  // order regardless of which pattern matched it. Dedup happens on push.
  const candidates: { index: number; token: string }[] = [];
  const collect = (re: RegExp, group: number) => {
    for (const m of text.matchAll(re)) {
      candidates.push({ index: m.index ?? 0, token: m[group] ?? "" });
    }
  };
  // Linear + GitHub issue URLs.
  collect(/https?:\/\/linear\.app\/[^/\s]+\/issue\/[A-Za-z]+-\d+(?:\/[^\s)]*)?/gi, 0);
  collect(/https?:\/\/github\.com\/[^/\s]+\/[^/\s]+\/issues\/\d+/gi, 0);
  // GitHub short refs `owner/repo#n`. The lookbehind keeps it from biting into
  // a URL's path (`…/issues/5` has no `#`, but `github.com/o/r#5` would).
  collect(/(?<![\w/])[^/\s#]+\/[^/\s#]+#\d+/g, 0);
  // Bare Linear keys, gated on an `issue` lead-in (the separator allows
  // `issue SHI-9`, `issue: SHI-9`, `issue #SHI-9`).
  collect(/\bissue\b[\s:#-]*([A-Za-z]+-\d+)/gi, 1);

  candidates.sort((a, b) => a.index - b.index);
  for (const { token } of candidates) {
    const parsed = parseIssueRef(token);
    if (parsed.tracker === "unknown" || !parsed.issueId) continue;
    const key = `${parsed.tracker}:${parsed.issueId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(parsed);
  }

  return out;
}
