export interface ParsedSubagentReport {
  text: string;
  meta: string | null;
}

const SUBAGENT_META_KEYS = new Set([
  "agentId",
  "subagent_tokens",
  "tool_uses",
  "duration_ms",
]);

export function parseSubagentReport(content: string): ParsedSubagentReport {
  if (!content.startsWith("[")) return { text: content, meta: null };

  let blocks: unknown;
  try {
    blocks = JSON.parse(content);
  } catch {
    return { text: content, meta: null };
  }
  if (!Array.isArray(blocks)) return { text: content, meta: null };

  const texts: string[] = [];
  for (const block of blocks as Record<string, unknown>[]) {
    if (block?.type === "text" && typeof block.text === "string") texts.push(block.text);
  }
  if (texts.length === 0) return { text: content, meta: null };

  // Require known keys on every footer line to avoid hiding report text.
  const last = texts[texts.length - 1];
  if (isSubagentMetaBlock(last)) {
    return { text: texts.slice(0, -1).join("\n\n"), meta: last };
  }
  return { text: texts.join("\n\n"), meta: null };
}

function isSubagentMetaBlock(text: string): boolean {
  const lines = text.split("\n").filter((l) => l.trim());
  if (lines.length === 0) return false;
  return lines.every((line) => {
    const key = line.slice(0, line.indexOf(":")).trim();
    return line.includes(":") && SUBAGENT_META_KEYS.has(key);
  });
}

export interface SubagentReportMeta {
  tokens?: number;
  toolUses?: number;
  durationMs?: number;
}

export function parseReportMeta(meta: string | null): SubagentReportMeta | null {
  if (!meta) return null;
  const out: SubagentReportMeta = {};
  for (const line of meta.split("\n")) {
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    const value = Number(line.slice(idx + 1).trim());
    if (!Number.isFinite(value)) continue;
    if (key === "subagent_tokens") out.tokens = value;
    else if (key === "tool_uses") out.toolUses = value;
    else if (key === "duration_ms") out.durationMs = value;
  }
  return Object.keys(out).length > 0 ? out : null;
}

const LAUNCH_ACK_MAX_BYTES = 2_000;

// The Task input's run_in_background field is unavailable after reload.
export function isBackgroundLaunchAck(text: string): boolean {
  if (text.length > LAUNCH_ACK_MAX_BYTES) return false;
  const head = text.trimStart();
  // OpenCode 2's `subagent` with `background: true` (2.2.5).
  if (/^The subagent is working in the background \(sessionID: \S+\)\./.test(head)) return true;
  if (!head.startsWith("Async agent launched successfully")) return false;
  return /^agentId:/m.test(head) || /^output_file:/m.test(head);
}

// For short reports, slice markers and a fetch cost more than the saved text.
export const REPORT_STRIP_FLOOR_BYTES = 200;

/** What a retired background subagent's result says when it was stopped (docs/109 reqs 10–11). */
export const STOPPED_TEXT = "_The subagent was stopped before it finished, so there is no report._";

export interface SlicedReport {
  content: string;
  totalLines: number;
  totalBytes: number;
}

/**
 * docs/339 — the transcript draws no report, only a sub-agent's line, so the
 * report text ships empty and the dialog fetches it on open. Kept on the wire:
 * the footer (the line's time and tool count), non-text blocks, and the two
 * short texts that decide the line's status — a background-launch
 * acknowledgement, and the stopped note, which is under the floor. Text is cut from the parsed blocks,
 * never the raw JSON, so the array stays parseable.
 */
export function sliceSubagentReport(content: string): SlicedReport | null {
  const { text, meta } = parseSubagentReport(content);
  const totalBytes = utf8Length(content);
  if (utf8Length(text) <= REPORT_STRIP_FLOOR_BYTES) return null;
  if (isBackgroundLaunchAck(text)) return null;

  const totalLines = countLines(text);
  if (meta === null && !content.startsWith("[")) {
    return { content: "", totalLines, totalBytes };
  }
  return { content: rebuildBlocks(content, "", meta), totalLines, totalBytes };
}

function rebuildBlocks(content: string, head: string, meta: string | null): string {
  let blocks: unknown;
  try {
    blocks = JSON.parse(content);
  } catch {
    return JSON.stringify([{ type: "text", text: head }]);
  }
  if (!Array.isArray(blocks)) return JSON.stringify([{ type: "text", text: head }]);

  // Earlier report text may repeat the footer; use the last match.
  let metaIndex = -1;
  if (meta !== null) {
    for (let i = (blocks as unknown[]).length - 1; i >= 0; i--) {
      const block = (blocks as unknown[])[i];
      if (isTextBlock(block) && (block as { text: string }).text === meta) {
        metaIndex = i;
        break;
      }
    }
  }

  let headEmitted = false;
  const out: unknown[] = [];
  for (const [i, block] of blocks.entries()) {
    if (!isTextBlock(block)) {
      out.push(block);
      continue;
    }
    if (i === metaIndex) {
      out.push(block);
      continue;
    }
    if (headEmitted) continue;
    headEmitted = true;
    out.push({ ...(block as Record<string, unknown>), text: head });
  }
  return JSON.stringify(out);
}

function isTextBlock(block: unknown): boolean {
  if (typeof block !== "object" || block === null) return false;
  const b = block as Record<string, unknown>;
  return b.type === "text" && typeof b.text === "string";
}

function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}

function countLines(text: string): number {
  let lines = 1;
  for (const ch of text) if (ch === "\n") lines++;
  return lines;
}
