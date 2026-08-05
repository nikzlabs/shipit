/**
 * Parse an issue reference into the *shape* it has: which destination it names,
 * a short display identifier, a tracker-native id, and (when derivable) an
 * absolute URL.
 *
 * This module stays **pure and context-free**, which is why the client chip and
 * the server shim can both share it. It answers "what shape is this string";
 * `issue-ref-resolution.ts` answers "which declared tracker does that identify",
 * which is where requirement 11's fail-closed and ambiguity rules live. Keeping
 * the two apart is deliberate: threading the declarations through every caller
 * of this function would put the routing rules at each call site instead of in
 * one place.
 *
 * docs/248 req 10 — three reference forms are recognized:
 *
 * | Form                        | Example                          | What this parser reports |
 * |---|---|---|
 * | tracker name + backend id   | `roadmap#SHI-304`, `planning#123`| `trackerName` + raw `issueId` |
 * | tracker name + number       | `roadmap#304`                    | `trackerName` + raw `issueId` |
 * | the backend's canonical address | `SHI-304`, `owner/repo#42`, an issue URL | a concrete `tracker` id |
 *
 * A **name** form leaves `tracker` as `"unknown"` on purpose: a name means
 * nothing without the declarations, so only the resolver can turn it into a
 * destination. A **canonical** form resolves to a destination-qualified
 * {@link TrackerId} here — `github:owner/repo`, `linear:SHI` — because the
 * address itself carries the identity. Recognizing it is still not the same as
 * *reaching* it: the resolver checks it against the declarations and fails
 * closed when it identifies none (req 11).
 *
 * Two fields matter to each consumer:
 *
 *  - `identifier` is the combined, human-legible display form (`owner/repo#42`,
 *    `SHI-28`, `planning#42`) — what a chip renders.
 *  - `issueId` is the **tracker-native** id that `Tracker.getIssue(id)` wants:
 *    the bare issue **number** for GitHub (its adapter builds
 *    `/repos/{owner}/{repo}/issues/${id}`), and the **key** for Linear. The
 *    combined `identifier` is NOT what `getIssue` wants — passing `owner/repo#42`
 *    to GitHub yields `/issues/owner%2Frepo%2342` → 404. For a *name* form the
 *    raw suffix is reported as-is; normalizing `roadmap#304` to `SHI-304` needs
 *    the declaration, so the resolver does it.
 */

import type { TrackerId } from "./types/domain-types/issue.js";
import { githubTrackerId, linearTrackerId } from "./tracker-id.js";

export interface ParsedIssueRef {
  /**
   * Tracker **destination** inferred from the reference's shape — a full
   * {@link TrackerId}, not just the tracker kind.
   *
   * docs/248: a canonical GitHub address always names its repository
   * (`owner/repo#42`, a `github.com/owner/repo/issues/42` URL), so it resolves
   * to `github:owner/repo`; a Linear key names its team through its prefix
   * (`SHI-304` → `linear:SHI`). That is what stops a reference into one
   * destination from operating on the *session's* repository — the wrong-target
   * bug the design targets — and it is why the destination is carried here
   * rather than reconstructed downstream from `identifier`, which is display
   * text.
   *
   * `"unknown"` means one of two things, distinguished by `trackerName`: with a
   * name, the reference addressed a declared tracker this parser cannot resolve;
   * without one, the string isn't a reference at all.
   */
  tracker: TrackerId | "unknown";
  /**
   * docs/248 req 10 — the tracker **name** the reference addressed, when it used
   * one of the two name forms. The resolver looks this up in the declarations;
   * requirement 16's re-point works precisely because the name, not the
   * destination it resolved to, is what a written reference carries.
   */
  trackerName?: string;
  /** Short identifier for display (e.g. "SHI-28", "owner/repo#42", "planning#42"). */
  identifier: string;
  /**
   * Tracker-native id for `Tracker.getIssue(id)`: the bare number for GitHub,
   * the key for Linear. For a name form this is the raw suffix as written
   * (`304` or `SHI-304`) — the resolver normalizes it once it knows the kind.
   * Absent for an unrecognized shape.
   */
  issueId?: string;
  /** Absolute URL to open the issue, when resolvable from the reference alone. */
  url?: string;
}

const LINEAR_URL_RE = /^https?:\/\/linear\.app\/[^/]+\/issue\/([A-Za-z][A-Za-z0-9]*)-(\d+)/i;
const GITHUB_URL_RE = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/i;
const GITHUB_SHORT_RE = /^([^/\s]+)\/([^/\s#]+)#(\d+)$/;
/**
 * A bare Linear key like `SHI-28` — the canonical address a Linear user writes.
 * The team prefix accepts digits after the first character because Linear team
 * keys do (`T2`), and {@link normalizeLinearTeamKey} accepts the same shape: a
 * narrower regex here would make a perfectly valid `team: T2` declaration
 * unaddressable by its own issues' keys. Widening it costs nothing in practice —
 * an accidental match now fails closed at resolution unless some repository
 * genuinely declared that team.
 */
const LINEAR_KEY_RE = /^([A-Za-z][A-Za-z0-9]*)-(\d+)$/;
/**
 * docs/248 req 10 — the two name forms, `planning#123` and `roadmap#SHI-304`.
 *
 * A free slot in the existing grammar: `GITHUB_SHORT_RE` requires the slash and
 * a bare `#42` is deliberately rejected as ambiguous, so adding this makes no
 * existing form ambiguous. A name may look like a GitHub owner (`acme#3` vs
 * `acme/planning#3`) — the slash is what distinguishes them, and since the two
 * never collide, a name that resembles an owner is allowed without a warning.
 */
const NAMED_REF_RE = /^([A-Za-z0-9][A-Za-z0-9._-]*)#([A-Za-z][A-Za-z0-9]*-\d+|\d+)$/;

export function parseIssueRef(raw: string): ParsedIssueRef {
  const issue = raw.trim();

  const linear = LINEAR_URL_RE.exec(issue);
  if (linear) {
    const key = `${linear[1]}-${linear[2]}`.toUpperCase();
    return { tracker: linearTrackerId(linear[1]), identifier: key, issueId: key, url: issue };
  }

  const ghUrl = GITHUB_URL_RE.exec(issue);
  if (ghUrl) {
    return {
      tracker: githubTrackerId({ owner: ghUrl[1], repo: ghUrl[2] }),
      identifier: `${ghUrl[1]}/${ghUrl[2]}#${ghUrl[3]}`,
      issueId: ghUrl[3],
      url: issue,
    };
  }

  const ghShort = GITHUB_SHORT_RE.exec(issue);
  if (ghShort) {
    return {
      tracker: githubTrackerId({ owner: ghShort[1], repo: ghShort[2] }),
      identifier: `${ghShort[1]}/${ghShort[2]}#${ghShort[3]}`,
      issueId: ghShort[3],
      url: `https://github.com/${ghShort[1]}/${ghShort[2]}/issues/${ghShort[3]}`,
    };
  }

  // A bare Linear key (`SHI-28`). No URL is derivable without the workspace
  // slug, and the team prefix is what identifies the declaration (req 5).
  const linearKey = LINEAR_KEY_RE.exec(issue);
  if (linearKey) {
    const key = `${linearKey[1]}-${linearKey[2]}`.toUpperCase();
    return { tracker: linearTrackerId(linearKey[1]), identifier: key, issueId: key };
  }

  // A name form. The destination is whatever the repository declared under that
  // name, so this parser reports the name and stops — see the module docstring.
  const named = NAMED_REF_RE.exec(issue);
  if (named) {
    return {
      tracker: "unknown",
      trackerName: named[1],
      identifier: `${named[1]}#${named[2]}`,
      issueId: named[2],
    };
  }

  // Unknown shape — surface the raw reference, and treat it as a link only if it
  // already looks like an absolute URL.
  return {
    tracker: "unknown",
    identifier: issue,
    url: /^https?:\/\//i.test(issue) ? issue : undefined,
  };
}

/**
 * docs/248 req 15 — the single reference **formatter**. Wherever ShipIt produces
 * a reference string itself it calls this, so a destination that has a declared
 * name renders in the name form everywhere: the Issues UI, the transcript cards,
 * the branch a seeded session pushes, and the identifier the `shipit issue` shim
 * echoes back to the agent.
 *
 * There are only two producers of a reference in the codebase — this parser's
 * branches and the GitHub adapter's `${owner}/${repo}#${number}` — which is why
 * one formatter is enough to cover req 15 rather than an audit of every display
 * site. The agent's own prose is NOT rewritten; ShipIt only instructs it which
 * form to write (an `agent-instructions` change, not a code path), and any
 * recognized form the agent writes still resolves.
 */
export function formatIssueReference(opts: {
  /** The declared name of the destination, when it has one. */
  trackerName?: string | undefined;
  kind: "github" | "linear";
  /** Canonical identity: GitHub `owner/repo`, Linear team key. */
  key?: string | undefined;
  /** Tracker-native id: a GitHub number, a Linear key (`SHI-304`). */
  issueId: string;
}): string {
  if (opts.trackerName) return `${opts.trackerName}#${opts.issueId}`;
  if (opts.kind === "github") return opts.key ? `${opts.key}#${opts.issueId}` : `#${opts.issueId}`;
  return opts.issueId;
}

/**
 * Extract issue references from FREE-FORM text — e.g. a session's first user
 * message — as opposed to the keyword-anchored PR-body parse
 * ({@link parsePrBodyIssueRefs}). Used to recover the issue a session was
 * *started from*: `seedFromIssueRef` plants `You are working on issue <ID>: …`
 * + `Issue link: <url>` as the first message (docs/206).
 *
 * Only UNAMBIGUOUS shapes are matched, on purpose. A bare Linear key pattern
 * (`[A-Z]+-\d+`) collides with everyday tokens — `UTF-8`, `ISO-8601`, `GPT-4`,
 * `H-1B` — so scanning raw text for it would mint phantom issues. The same is
 * true of the docs/248 name form: a bare `foo#12` is indistinguishable from
 * `PR#12` or a heading anchor. The accepted shapes:
 *
 *  - Linear issue URLs   `https://linear.app/<ws>/issue/KEY[/slug]`
 *  - GitHub issue URLs   `https://github.com/<o>/<r>/issues/<n>`
 *  - GitHub short refs   `owner/repo#n`
 *  - Bare Linear keys and docs/248 name refs **only when preceded by the word
 *    `issue`** (case-insensitive: `working on issue SHI-90`, `issue: planning#42`)
 *    — the form the seed always produces and natural phrasing usually does. A
 *    bare `SHI-90` or `planning#42` with no `issue` lead-in is deliberately NOT
 *    matched.
 *
 * Deduped by destination + id in first-seen order; unresolvable tokens drop.
 * Because a canonical tracker id is destination-qualified (docs/248), that key is
 * qualified too — `a/x#42` and `b/y#42` are two refs, not one — and a name form
 * dedupes on its name, which is all it knows.
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
  collect(/https?:\/\/linear\.app\/[^/\s]+\/issue\/[A-Za-z][A-Za-z0-9]*-\d+(?:\/[^\s)]*)?/gi, 0);
  collect(/https?:\/\/github\.com\/[^/\s]+\/[^/\s]+\/issues\/\d+/gi, 0);
  // GitHub short refs `owner/repo#n`. The lookbehind keeps it from biting into
  // a URL's path (`…/issues/5` has no `#`, but `github.com/o/r#5` would).
  collect(/(?<![\w/])[^/\s#]+\/[^/\s#]+#\d+/g, 0);
  // Bare Linear keys, gated on an `issue` lead-in (the separator allows
  // `issue SHI-9`, `issue: SHI-9`, `issue #SHI-9`).
  collect(/\bissue\b[\s:#-]*([A-Za-z][A-Za-z0-9]*-\d+)/gi, 1);
  // docs/248 name refs, gated on the same lead-in (`issue planning#42`).
  collect(/\bissue\b[\s:]*([A-Za-z0-9][A-Za-z0-9._-]*#(?:[A-Za-z][A-Za-z0-9]*-\d+|\d+))/gi, 1);

  candidates.sort((a, b) => a.index - b.index);
  for (const { token } of candidates) {
    const parsed = parseIssueRef(token);
    if (!parsed.issueId) continue;
    if (parsed.tracker === "unknown" && !parsed.trackerName) continue;
    const key = `${parsed.trackerName ?? parsed.tracker}:${parsed.issueId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(parsed);
  }

  return out;
}
