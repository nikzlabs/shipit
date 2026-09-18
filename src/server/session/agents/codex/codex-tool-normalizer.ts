// Schema: codex app-server generate-json-schema --out DIR → ItemCompletedNotification.ThreadItem.
export interface CodexItem {
  type?: string;
  id?: string;
  text?: string;
  content?: { type: string; text?: string }[];
  command?: string;
  cwd?: string;
  aggregatedOutput?: string | null;
  exitCode?: number | null;
  status?: string;
  changes?: { path: string; kind?: string | Record<string, unknown>; diff?: string }[];
  server?: string;
  tool?: string;
  arguments?: string; // JSON-encoded arguments
  result?: unknown;
  error?: unknown;
  query?: string;
  action?: {
    type?: string;
    query?: string | null;
    queries?: string[] | null;
    url?: string | null;
    pattern?: string | null;
  } | null;
  prompt?: string;
  senderThreadId?: string;
  receiverThreadIds?: string[];
  agentsStates?: Record<string, { status?: string; message?: string | null }>;
  model?: string | null;
  reasoningEffort?: string | null;
  // Legacy fields accepted for old persisted/test fixtures.
  receiverThreadId?: string;
  newThreadId?: string;
  agentStatus?: string;
  agentThreadId?: string;
  agentPath?: string;
  kind?: string;
}

export function normalizeMcpToolName(server: string | undefined, tool: string | undefined): string {
  const name = tool?.trim() || "tool";
  if (name.startsWith("mcp__") || !server?.trim()) return name;
  return `mcp__${server.trim()}__${name}`;
}

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

// Codex 0.136.0 sends raw file content in add changes, despite naming the field diff.
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

const ASK_TOOL_NAME = "AskUserQuestion";

export function isAskUserQuestionTool(tool: string | undefined): boolean {
  if (!tool) return false;
  if (tool === ASK_TOOL_NAME) return true;
  return /(?:^|[._/]|__)AskUserQuestion$/.test(tool);
}

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
