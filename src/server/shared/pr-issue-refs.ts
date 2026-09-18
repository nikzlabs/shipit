import { parseIssueRef, type ParsedIssueRef } from "./issue-ref.js";

export interface PrBodyIssueRefs {
  closes: ParsedIssueRef[];
  refs: ParsedIssueRef[];
}

const CLOSE_RE = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b\s*:?\s+(\S+)/gi;
const REF_RE = /\b(?:references?|refs?)\b\s*:?\s+(\S+)/gi;

function cleanToken(raw: string): string {
  return raw.replace(/^[([`"']+/, "").replace(/[).,;:!?\]`"']+$/, "");
}

function collect(body: string, re: RegExp, seen: Set<string>): ParsedIssueRef[] {
  const out: ParsedIssueRef[] = [];
  for (const match of body.matchAll(re)) {
    const token = cleanToken(match[1] ?? "");
    if (!token) continue;
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

export function parsePrBodyIssueRefs(body: string | null | undefined): PrBodyIssueRefs {
  if (!body) return { closes: [], refs: [] };
  // Shared deduplication gives closing references precedence.
  const seen = new Set<string>();
  const closes = collect(body, CLOSE_RE, seen);
  const refs = collect(body, REF_RE, seen);
  return { closes, refs };
}
