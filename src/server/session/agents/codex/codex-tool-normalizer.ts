/**
 * Pure tool/diff normalization helpers for the Codex adapter.
 *
 * These translate raw Codex App Server v2 item shapes into the normalized
 * tool-call inputs, diffs, and summaries ShipIt's chat model expects. They are
 * deliberately free of process/protocol state so they can be unit-tested in
 * isolation and reused by both the adapter and its event handler.
 */

/**
 * An item from a Codex turn — message, command, file change, etc.
 *
 * Shapes follow the Codex App Server v2 protocol (CLI 0.132.x). Generate the
 * authoritative schema with `codex app-server generate-json-schema --out DIR`
 * and read `ItemCompletedNotification.json` → `definitions.ThreadItem`. The
 * `type` discriminator selects the variant; the fields below are the union of
 * the variants we map to ShipIt events.
 */
export interface CodexItem {
  type?: string;
  id?: string;
  // agentMessage — final assistant text (a plain string, NOT a content array)
  text?: string;
  // userMessage / reasoning — typed content blocks (we don't surface these)
  content?: { type: string; text?: string }[];
  // commandExecution — shell tool calls
  command?: string;
  cwd?: string;
  aggregatedOutput?: string | null;
  exitCode?: number | null;
  status?: string;
  // fileChange — applied patch (FileUpdateChange[], v2 schema). `diff` is the
  // top-level unified diff. `kind` is an internally-tagged enum object
  // (`{ type: "add"|"delete"|"update", move_path? }`), not the plain string the
  // field name suggests — interpolating it raw was the "[object Object]" bug.
  changes?: { path: string; kind?: string | Record<string, unknown>; diff?: string }[];
  // mcpToolCall / dynamicToolCall — generic tool invocations
  tool?: string;
  arguments?: string; // JSON-encoded arguments
  result?: unknown;
  error?: unknown;
  // webSearch — native Codex internet browsing. `query` is always present on
  // the thread item; `action` distinguishes searching from opening/finding in
  // a fetched page.
  query?: string;
  action?: {
    type?: string;
    query?: string | null;
    queries?: string[] | null;
    url?: string | null;
    pattern?: string | null;
  } | null;
  // collabToolCall — subagent orchestration (spawn_agent, send_input, wait, …)
  prompt?: string;
  receiverThreadId?: string;
  newThreadId?: string;
  agentStatus?: string;
}

/**
 * Strip Codex's shell wrapper so commands read like Claude's Bash tool. Codex
 * runs every shell command as `/bin/bash -lc '<script>'` (the `command` field is
 * that full invocation); we surface just `<script>`. Recognizes an optional path
 * prefix and `bash`/`sh` with a `-c`/`-lc`-style flag, then peels one layer of
 * matching outer quotes. Returns the input unchanged when it doesn't match, so
 * non-wrapped commands (and Claude's already-clean commands) pass through.
 */
export function unwrapShellCommand(command: string): string {
  const m = /^\s*(?:\S*\/)?(?:bash|sh)\s+-[a-z]*c\s+([\s\S]+?)\s*$/.exec(command);
  if (!m) return command;
  const inner = m[1].trim();
  const q = inner[0];
  if ((q === "'" || q === '"') && inner.length >= 2 && inner.endsWith(q)) {
    return inner.slice(1, -1);
  }
  return inner;
}

/**
 * Resolve a human label ("add" | "delete" | "update") for a file change's
 * `kind`. Per the v2 schema (`PatchChangeKind`), Codex sends `kind` as an
 * internally-tagged enum object — `{ type: "update", move_path? }` — so
 * interpolating it directly yields "[object Object]". Accepts a plain string
 * and an externally-tagged single-key object too, for resilience.
 */
export function fileChangeKindLabel(kind: unknown): string {
  if (typeof kind === "string" && kind) return kind;
  if (kind && typeof kind === "object") {
    const obj = kind as Record<string, unknown>;
    if (typeof obj.type === "string" && obj.type) return obj.type;
    const key = Object.keys(obj)[0];
    if (key) return key;
  }
  return "update";
}

/**
 * The display diff for a single file change. Codex App Server 0.136.0 requires a
 * top-level `diff` string, but runtime verification showed add changes carry raw
 * file content there while `turn/diff/updated` carries the full unified diff.
 * Normalize raw add/delete content into the compact +/- shape DiffBlock expects.
 */
export function normalizeFileChangeDiff(change: { diff?: string }, kind: string): string | undefined {
  if (typeof change.diff !== "string" || !change.diff) return undefined;
  if (kind === "add" && !looksLikeUnifiedDiff(change.diff)) {
    return contentToAddedDiff(change.diff) || undefined;
  }
  if (kind === "delete" && !looksLikeUnifiedDiff(change.diff)) {
    return contentToDeletedDiff(change.diff) || undefined;
  }
  return change.diff;
}

function looksLikeUnifiedDiff(diff: string): boolean {
  return /^(?:diff --git |@@|--- |\+\+\+ |\+|-)/m.test(diff);
}

export function contentToAddedDiff(content: string): string {
  if (!content) return "";
  const withoutFinalNewline = content.endsWith("\n") ? content.slice(0, -1) : content;
  if (!withoutFinalNewline) return "";
  return withoutFinalNewline.split("\n").map((line) => `+${line}`).join("\n");
}

function contentToDeletedDiff(content: string): string {
  if (!content) return "";
  const withoutFinalNewline = content.endsWith("\n") ? content.slice(0, -1) : content;
  if (!withoutFinalNewline) return "";
  return withoutFinalNewline.split("\n").map((line) => `-${line}`).join("\n");
}

export function summarizeCodexSubagentPrompt(prompt: unknown): string {
  if (typeof prompt !== "string") return "Running agent...";
  const firstLine = prompt.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  if (!firstLine) return "Running agent...";
  return firstLine.length > 90 ? `${firstLine.slice(0, 87)}...` : firstLine;
}

export function normalizeWebSearchItem(item: CodexItem): { name: "WebFetch" | "WebSearch"; input: Record<string, unknown>; summary: string } {
  const action = item.action ?? undefined;
  const actionType = action?.type;
  const query = action?.query ?? item.query ?? action?.queries?.find(Boolean) ?? "";

  if (actionType === "openPage") {
    const url = action?.url ?? item.query ?? "";
    return {
      name: "WebFetch",
      input: { url, query: item.query },
      summary: url ? `Fetched ${url}` : "Fetched page",
    };
  }

  if (actionType === "findInPage") {
    const url = action?.url ?? "";
    const pattern = action?.pattern ?? "";
    return {
      name: "WebFetch",
      input: { url, pattern, query: item.query },
      summary: [url ? `Fetched ${url}` : "Fetched page", pattern ? `Found "${pattern}"` : ""]
        .filter(Boolean)
        .join("\n"),
    };
  }

  const queries = action?.queries?.filter((q) => q.length > 0);
  return {
    name: "WebSearch",
    input: {
      query: query || item.query || "",
      ...(queries && queries.length > 1 ? { queries } : {}),
    },
    summary: query || item.query ? `Searched web for: ${query || item.query}` : "Searched web",
  };
}

/**
 * The bare tool name the ShipIt-managed ask bridge exposes (docs/147). The
 * Codex app-server may surface an MCP tool under a server-qualified name
 * (`AskUserQuestion`, `shipit__AskUserQuestion`, `shipit.AskUserQuestion`,
 * `shipit/AskUserQuestion`), so match the bare name or any of those
 * separator-prefixed forms rather than assuming one shape. Used only to IGNORE
 * the ask tool on the event stream — the question card is surfaced by the
 * bridge's worker round-trip, not from here (see handleItem's mcpToolCall case).
 */
const ASK_TOOL_NAME = "AskUserQuestion";

export function isAskUserQuestionTool(tool: string | undefined): boolean {
  if (!tool) return false;
  if (tool === ASK_TOOL_NAME) return true;
  return /(?:^|[._/]|__)AskUserQuestion$/.test(tool);
}

/**
 * docs/193 — derive a `{ toolName, input }` for the permission broker from a
 * Codex approval request. Best-effort across the v2 (`item.*`) and v1
 * (top-level) param shapes: a file-change approval yields the first changed
 * path as `file_path` (so the broker can render + remember it); a command
 * approval yields the unwrapped shell command. The broker uses these to derive
 * the card's path and summary, falling back to the tool name when absent.
 */
export function buildCodexPermissionInput(
  method: string,
  params: Record<string, unknown>,
): { toolName: string; input: Record<string, unknown> } {
  const item = (params.item ?? params) as Record<string, unknown>;
  if (method.includes("fileChange") || method.includes("applyPatch")) {
    const changes = (item.changes ?? params.changes) as { path?: string }[] | undefined;
    const firstPath = Array.isArray(changes)
      ? changes.find((c) => typeof c?.path === "string")?.path
      : undefined;
    return { toolName: "apply_patch", input: firstPath ? { file_path: firstPath } : {} };
  }
  const rawCommand = item.command ?? params.command;
  const command = Array.isArray(rawCommand)
    ? rawCommand.filter((p) => typeof p === "string").join(" ")
    : typeof rawCommand === "string"
      ? rawCommand
      : undefined;
  const cwd = typeof item.cwd === "string" ? item.cwd : undefined;
  return {
    toolName: "shell",
    input: {
      ...(command ? { command: unwrapShellCommand(command) } : {}),
      ...(cwd ? { cwd } : {}),
    },
  };
}
