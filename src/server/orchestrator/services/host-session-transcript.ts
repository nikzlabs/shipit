/** docs/326-ops-session-transcript — the ops read that returns what a session said. Read-only. */
import type { PersistedMessage } from "../chat-history.js";
import type { SessionManager } from "../sessions.js";
import type { ToolResultEntry } from "../session-runner.js";
import { parseTimeBound, resolveHostSessionTarget } from "./host-session-logs.js";
import { redactCredentials } from "./redaction.js";
import { ServiceError } from "./types.js";

export const DEFAULT_TRANSCRIPT_MESSAGES = 40;
export const MAX_TRANSCRIPT_MESSAGES = 400;
export const TRANSCRIPT_BODY_CHARS = 4_000;
export const TRANSCRIPT_FULL_BODY_CHARS = 200_000;
/** For a page, and for each message in it: the newest message is always returned. */
export const MAX_TRANSCRIPT_RESPONSE_CHARS = 2_000_000;
/**
 * Stored text that one read may redact, for a page and for each message in it. Redaction reads
 * all of a text before the cut, on the orchestrator's main thread, at about 20 ms for each
 * million characters.
 */
export const MAX_TRANSCRIPT_SCAN_CHARS = 8_000_000;

export interface TranscriptStoreReader {
  listRowTimes(sessionId: string): { id: number; createdAt: string | null }[];
  loadRowById(sessionId: string, id: number): PersistedMessage | undefined;
  transcriptRevision(sessionId: string): number;
}

export interface HostSessionTranscriptQuery {
  /** ISO timestamp or relative age, such as 30m. */
  since?: string;
  until?: string;
  last?: number;
  /** Only messages whose position is lower; the cursor for older pages. */
  before?: number;
  full?: boolean;
  nowMs?: number;
}

export interface HostSessionTranscriptEntry {
  /** 1-based place in the stored transcript. */
  position: number;
  /**
   * When ShipIt inserted the row. A turn's rows are inserted again as the turn advances, and a
   * rewind inserts every row again; a later change to a card in the row does not move it.
   */
  storedAt: string;
  message: PersistedMessage;
  /** `message` is then a placeholder: the stored row could not be decoded, or is over the size limit. */
  withheld?: "unreadable" | "too-large";
}

export interface HostSessionTranscriptResult {
  sessionId: string;
  title: string;
  diskTier: "hot" | "light" | "evicted";
  archived?: boolean;
  entries: HostSessionTranscriptEntry[];
  /** Messages the session stores now. */
  stored: number;
  /** Matches before the tail limit and the size budget. */
  total: number;
  truncated: boolean;
  /** The `--before` value that returns the messages before this page. */
  olderBefore?: number;
  bodyChars: number;
  cutBodies: number;
  redactions: number;
  /**
   * With `stored: 0`: true is proof that messages were stored and then removed. False is not
   * proof that none ever was: the write count is younger than the oldest sessions.
   */
  everStored: boolean;
}

interface Tally {
  cutBodies: number;
  redactions: number;
  scannedChars: number;
  outputChars: number;
}

function newTally(): Tally {
  return { cutBodies: 0, redactions: 0, scannedChars: 0, outputChars: 0 };
}

function normalizeCount(value: number | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new ServiceError(400, `Invalid ${flag} value: must be a positive integer, got ${value}.`);
  }
  return value;
}

// SQLite's datetime('now') is UTC without a zone designator.
function toIso(createdAt: string | null): string {
  if (!createdAt) return "";
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(createdAt)
    ? `${createdAt.replace(" ", "T")}Z`
    : createdAt;
}

function redact(text: string, tally: Tally): string {
  const result = redactCredentials(text);
  tally.redactions += result.redactedCount;
  tally.scannedChars += text.length;
  return result.text;
}

// A text is redacted whole or not read: there is no safe place to stop in the middle of one.
function overLimit(text: string, tally: Tally): boolean {
  return (
    tally.scannedChars + text.length > MAX_TRANSCRIPT_SCAN_CHARS ||
    tally.outputChars > MAX_TRANSCRIPT_RESPONSE_CHARS
  );
}

// Redact all of the text before the cut: a cut through a credential leaves a part that no
// pattern matches, and a credential has no maximum length.
function sanitizeText(text: string, cap: number, tally: Tally): string {
  let out: string;
  if (overLimit(text, tally)) {
    tally.cutBodies++;
    out = `[… ShipIt withheld ${text.length} characters: this message is over the size limit of one read …]`;
  } else {
    out = redact(text, tally);
    if (out.length > cap) {
      tally.cutBodies++;
      const head = Math.floor(cap * 0.75);
      out = `${out.slice(0, head)}\n[… ShipIt cut ${out.length - cap} characters …]\n${out.slice(out.length - (cap - head))}`;
    }
  }
  tally.outputChars += out.length;
  return out;
}

// Every string in the message goes through here, keys included, so a new field cannot skip redaction.
function sanitizeDeep(value: unknown, cap: number, tally: Tally): unknown {
  if (typeof value === "string") return sanitizeText(value, cap, tally);
  if (Array.isArray(value)) return value.map((item) => sanitizeDeep(item, cap, tally));
  if (value !== null && typeof value === "object") {
    const used = new Set<string>();
    const next = new Map<string, number>();
    return Object.fromEntries(
      Object.entries(value).map(([rawKey, item]) => {
        const base = overLimit(rawKey, tally) ? "[… key withheld …]" : redact(rawKey, tally);
        // Two keys that come out as the same text must not replace each other.
        let n = next.get(base) ?? 1;
        let key = base;
        while (used.has(key)) key = `${base} (${++n})`;
        next.set(base, n);
        used.add(key);
        tally.outputChars += key.length;
        return [key, sanitizeDeep(item, cap, tally)];
      }),
    );
  }
  return value;
}

// One content block as text, or null for anything that is not exactly a text or an image block.
function contentBlockText(block: unknown): string | null {
  if (typeof block !== "object" || block === null) return null;
  const b = block as Record<string, unknown>;
  if (Object.keys(b).length !== 2) return null;
  if (b.type === "text" && typeof b.text === "string") return b.text;
  if (b.type !== "image" || typeof b.source !== "object" || b.source === null) return null;
  const source = b.source as Record<string, unknown>;
  if (typeof source.data !== "string") return null;
  return `[image ${typeof source.media_type === "string" ? source.media_type : "of unknown type"}]`;
}

// A result can be stored as a JSON array of content blocks. As text it reads better, the
// redaction patterns see real line ends, and the bytes of an image do not fill the cut limit.
// Other JSON that a tool printed stays as it is: an array of objects is not always blocks.
function flattenResultBlocks(content: unknown): unknown {
  if (typeof content !== "string" || !content.startsWith("[")) return content;
  let blocks: unknown;
  try {
    blocks = JSON.parse(content);
  } catch {
    return content;
  }
  if (!Array.isArray(blocks) || blocks.length === 0) return content;
  const parts: string[] = [];
  for (const block of blocks) {
    const text = contentBlockText(block);
    if (text === null) return content;
    parts.push(text);
  }
  return parts.join("\n");
}

function withoutImageBytes(message: PersistedMessage): PersistedMessage {
  const strip = (results: ToolResultEntry[]): ToolResultEntry[] =>
    results.map((r) => ({ ...r, content: flattenResultBlocks(r.content) as string }));
  return {
    ...message,
    ...(Array.isArray(message.images)
      ? { images: message.images.map((img) => ({ mediaType: img.mediaType })) }
      : {}),
    ...(Array.isArray(message.toolResults) ? { toolResults: strip(message.toolResults) } : {}),
    ...(Array.isArray(message.subagentEvents)
      ? {
          subagentEvents: message.subagentEvents.map((ev) =>
            ev.kind === "tool_result" && Array.isArray(ev.toolResults)
              ? { ...ev, toolResults: strip(ev.toolResults) }
              : ev),
        }
      : {}),
  };
}

const WITHHELD_MESSAGE: PersistedMessage = { role: "assistant", text: "" };

interface ReadEntry {
  message: PersistedMessage;
  size: number;
  tally: Tally;
  withheld?: HostSessionTranscriptEntry["withheld"];
}

function readEntry(
  store: TranscriptStoreReader,
  sessionId: string,
  rowId: number,
  bodyChars: number,
): ReadEntry | null {
  const tally = newTally();
  try {
    const stored = store.loadRowById(sessionId, rowId);
    if (!stored) return null;
    const message = sanitizeDeep(withoutImageBytes(stored), bodyChars, tally) as PersistedMessage;
    const size = JSON.stringify(message).length;
    // Many small values can pass the limit that the texts are counted against.
    if (size <= 2 * MAX_TRANSCRIPT_RESPONSE_CHARS) return { message, size, tally };
    return { message: WITHHELD_MESSAGE, size: 0, tally, withheld: "too-large" };
  } catch {
    // The error can quote the stored text, so none of it is passed on.
    return { message: WITHHELD_MESSAGE, size: 0, tally, withheld: "unreadable" };
  }
}

export function queryHostSessionTranscript(
  sessionManager: SessionManager,
  store: TranscriptStoreReader,
  target: string,
  query: HostSessionTranscriptQuery = {},
): HostSessionTranscriptResult {
  const session = resolveHostSessionTarget(sessionManager, target);
  const nowMs = query.nowMs ?? Date.now();
  const sinceMs = query.since !== undefined ? parseTimeBound(query.since, "--since", nowMs) : undefined;
  const untilMs = query.until !== undefined ? parseTimeBound(query.until, "--until", nowMs) : undefined;
  if (sinceMs !== undefined && untilMs !== undefined && sinceMs > untilMs) {
    throw new ServiceError(400, "--since is after --until: the window is empty.");
  }
  const last = Math.min(normalizeCount(query.last, "--last") ?? DEFAULT_TRANSCRIPT_MESSAGES, MAX_TRANSCRIPT_MESSAGES);
  const before = normalizeCount(query.before, "--before");
  const bodyChars = query.full ? TRANSCRIPT_FULL_BODY_CHARS : TRANSCRIPT_BODY_CHARS;

  const rows = store.listRowTimes(session.id);
  const matched = rows
    .map((row, index) => ({ id: row.id, position: index + 1, storedAt: toIso(row.createdAt) }))
    .filter((row) => {
      if (before !== undefined && row.position >= before) return false;
      if (sinceMs === undefined && untilMs === undefined) return true;
      const ts = Date.parse(row.storedAt);
      if (Number.isNaN(ts)) return false;
      return (sinceMs === undefined || ts >= sinceMs) && (untilMs === undefined || ts <= untilMs);
    });

  const tally = newTally();
  const entries: HostSessionTranscriptEntry[] = [];
  let size = 0;
  // Newest first, so that a limit drops the oldest messages of the page. One row at a time, so
  // that a page of large rows is never in memory together.
  for (const row of matched.slice(-last).reverse()) {
    if (entries.length > 0 && tally.scannedChars > MAX_TRANSCRIPT_SCAN_CHARS) break;
    const read = readEntry(store, session.id, row.id, bodyChars);
    if (!read) continue;
    if (entries.length > 0 && size + read.size > MAX_TRANSCRIPT_RESPONSE_CHARS) break;
    size += read.size;
    tally.scannedChars += read.tally.scannedChars;
    if (!read.withheld) {
      tally.cutBodies += read.tally.cutBodies;
      tally.redactions += read.tally.redactions;
    }
    entries.unshift({
      position: row.position,
      storedAt: row.storedAt,
      message: read.message,
      ...(read.withheld ? { withheld: read.withheld } : {}),
    });
  }

  const title = redact(session.title, tally);
  const truncated = entries.length < matched.length;
  const result: HostSessionTranscriptResult = {
    sessionId: session.id,
    title,
    diskTier: session.diskTier ?? "hot",
    entries,
    stored: rows.length,
    total: matched.length,
    truncated,
    bodyChars,
    cutBodies: tally.cutBodies,
    redactions: tally.redactions,
    everStored: rows.length > 0 || store.transcriptRevision(session.id) > 0,
  };
  if (truncated && entries.length > 0) result.olderBefore = entries[0].position;
  if (session.userArchived) result.archived = true;
  return result;
}
