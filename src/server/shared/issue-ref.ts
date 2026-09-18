import type { TrackerId } from "./types/domain-types/issue.js";
import { githubTrackerId, linearTrackerId } from "./tracker-id.js";

export interface ParsedIssueRef {
  /** Named references stay unknown until resolved against tracker declarations. */
  tracker: TrackerId | "unknown";
  trackerName?: string;
  identifier: string;
  /** Tracker-native id, or the raw suffix for a named reference. */
  issueId?: string;
  url?: string;
}

const LINEAR_URL_RE = /^https?:\/\/linear\.app\/[^/]+\/issue\/([A-Za-z][A-Za-z0-9]*)-(\d+)/i;
const GITHUB_URL_RE = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/i;
const GITHUB_SHORT_RE = /^([^/\s]+)\/([^/\s#]+)#(\d+)$/;
const LINEAR_KEY_RE = /^([A-Za-z][A-Za-z0-9]*)-(\d+)$/;
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

  const linearKey = LINEAR_KEY_RE.exec(issue);
  if (linearKey) {
    const key = `${linearKey[1]}-${linearKey[2]}`.toUpperCase();
    return { tracker: linearTrackerId(linearKey[1]), identifier: key, issueId: key };
  }

  const named = NAMED_REF_RE.exec(issue);
  if (named) {
    return {
      tracker: "unknown",
      trackerName: named[1],
      identifier: `${named[1]}#${named[2]}`,
      issueId: named[2],
    };
  }

  return {
    tracker: "unknown",
    identifier: issue,
    url: /^https?:\/\//i.test(issue) ? issue : undefined,
  };
}

export function formatIssueReference(opts: {
  trackerName?: string | undefined;
  kind: "github" | "linear";
  key?: string | undefined;
  issueId: string;
}): string {
  if (opts.trackerName) return `${opts.trackerName}#${opts.issueId}`;
  if (opts.kind === "github") return opts.key ? `${opts.key}#${opts.issueId}` : `#${opts.issueId}`;
  return opts.issueId;
}

// Keep 'issue <identifier>' adjacent for extractIssueRefsFromText.
export function buildIssueSeedPrompt(issue: { identifier: string; title: string }): string {
  const identifier = issue.identifier.trim();
  const title = issue.title.trim();
  const header = title ? `Work on issue ${identifier}: ${title}` : `Work on issue ${identifier}`;
  return `${header}\n\nRead it with \`shipit issue view ${identifier}\` before starting.`;
}

/** Require an 'issue' lead-in for bare keys to avoid matches such as UTF-8 or PR#12. */
export function extractIssueRefsFromText(text: string | null | undefined): ParsedIssueRef[] {
  if (!text) return [];
  const out: ParsedIssueRef[] = [];
  const seen = new Set<string>();
  const candidates: { index: number; token: string }[] = [];
  const collect = (re: RegExp, group: number) => {
    for (const m of text.matchAll(re)) {
      candidates.push({ index: m.index ?? 0, token: m[group] ?? "" });
    }
  };
  collect(/https?:\/\/linear\.app\/[^/\s]+\/issue\/[A-Za-z][A-Za-z0-9]*-\d+(?:\/[^\s)]*)?/gi, 0);
  collect(/https?:\/\/github\.com\/[^/\s]+\/[^/\s]+\/issues\/\d+/gi, 0);
  collect(/(?<![\w/])[^/\s#]+\/[^/\s#]+#\d+/g, 0);
  collect(/\bissue\b[\s:#-]*([A-Za-z][A-Za-z0-9]*-\d+)/gi, 1);
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
