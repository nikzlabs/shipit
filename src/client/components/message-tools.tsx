// eslint-disable-next-line no-restricted-imports -- useEffect: xterm auto-scroll for tool group
import { useEffect, useRef, useState } from "react";
import { useMemo } from "react";
import { EyeIcon, PresentationChartIcon, XIcon } from "@phosphor-icons/react";
import hljs from "highlight.js";
import { DiffBlock } from "./DiffBlock.js";
import { ToolSpinner } from "./StreamingIndicator.js";
import { AskUserQuestion, type AskQuestionItem } from "./AskUserQuestion.js";
import { PlanApproval } from "./PlanApproval.js";
import { ToolResult } from "./ToolResult.js";
import { Dialog, DialogContent } from "./ui/dialog.js";
import { sessionRelativePath } from "../path-utils.js";
import { usePresentStore } from "../stores/present-store.js";
import { useUiStore } from "../stores/ui-store.js";
import type { ToolUseBlock, ToolResultBlock } from "./MessageList.js";

/** Scrollable container for consecutive tool calls. Max 5 lines, auto-scrolls during streaming. */
export function ToolCallGroup({ items, isStreaming }: {
  items: { tool: ToolUseBlock; result?: ToolResultBlock; isLast: boolean }[];
  isStreaming: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when new tools are added during streaming
  // eslint-disable-next-line no-restricted-syntax -- existing usage
  useEffect(() => {
    if (isStreaming && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [items.length, isStreaming]);

  return (
    <div
      ref={scrollRef}
      className="max-h-30 overflow-y-hidden hover:overflow-y-auto"
      data-testid="tool-call-group"
    >
      {items.map(({ tool, result, isLast }) => (
        <ToolUseItem
          key={tool.id}
          tool={tool}
          result={result}
          isLast={isLast}
          isStreaming={isStreaming}
          isQuestionDisabled
          grouped
        />
      ))}
    </div>
  );
}

export function ToolUseItem({ tool, result, isLast, isStreaming, onAnswerQuestion, onSendFollowUp, isQuestionDisabled, grouped: _grouped, planContent }: { tool: ToolUseBlock; result?: ToolResultBlock; isLast: boolean; isStreaming: boolean; onAnswerQuestion?: (toolUseId: string, answers: Record<string, string>, text: string) => void; onSendFollowUp?: (text: string) => void; isQuestionDisabled: boolean; grouped?: boolean; planContent?: string }) {
  // IMPORTANT: all hooks must be called before any conditional `return` below.
  // `tool.name` and `tool.input` can change between renders while a tool is
  // streaming in (e.g. `AskUserQuestion` only matches once `input.questions`
  // arrives as an array), and any branch that returns early before this hook
  // would change the hook count across renders → React error #310.
  const [showModal, setShowModal] = useState(false);

  // Show a spinner on the last tool when the message is still streaming
  const inProgress = isLast && isStreaming && !result;
  const hasResult = !!result;

  // Render file-modifying tools as diff blocks
  if (tool.name === "Edit") {
    const filePath = (tool.input.file_path as string) ?? "unknown";
    const oldString = tool.input.old_string !== null && tool.input.old_string !== undefined ? (tool.input.old_string as string) : undefined;
    const newString = tool.input.new_string !== null && tool.input.new_string !== undefined ? (tool.input.new_string as string) : undefined;
    return (
      <div>
        <DiffBlock filePath={filePath} oldString={oldString} newString={newString} />
        {inProgress && <ToolProgressBar tool={tool.name} />}
      </div>
    );
  }

  if (tool.name === "Write") {
    const filePath = (tool.input.file_path as string) ?? "unknown";
    const content = tool.input.content !== null && tool.input.content !== undefined ? (tool.input.content as string) : "";
    return (
      <div>
        <DiffBlock filePath={filePath} newString={content} isWrite />
        {inProgress && <ToolProgressBar tool={tool.name} />}
      </div>
    );
  }

  // Codex's apply_patch — render one diff block per changed file, mirroring
  // how Claude's Edit/Write render. `changes` carries { path, kind, diff };
  // older payloads only have `files` (paths, no diff) — render those as bare lines.
  if (tool.name === "apply_patch") {
    const changes = Array.isArray(tool.input.changes)
      ? (tool.input.changes as { path: string; kind?: string; diff?: string }[])
      : Array.isArray(tool.input.files)
        ? (tool.input.files as string[]).map((path) => ({ path, kind: "update", diff: undefined }))
        : [];
    return (
      <div>
        {changes.map((c, i) => (
          <DiffBlock
            key={`${c.path}-${i}`}
            filePath={c.path}
            unifiedDiff={c.diff ?? ""}
            label={patchKindVerb(c.kind)}
          />
        ))}
        {inProgress && <ToolProgressBar tool="apply_patch" />}
      </div>
    );
  }

  if (tool.name === "AskUserQuestion" && Array.isArray(tool.input.questions)) {
    const questions = tool.input.questions as AskQuestionItem[];
    return (
      <AskUserQuestion
        toolUseId={tool.id}
        questions={questions}
        onAnswer={onAnswerQuestion ?? (() => {})}
        disabled={isQuestionDisabled}
        // `result` (when present) is the agent's tool_result for this
        // question — its content carries the answer text. Passing it lets
        // the component render the answered state on reload (where the
        // component's own `submittedAnswers` state has been lost).
        resolvedAnswer={result?.content}
      />
    );
  }

  if (tool.name === "ExitPlanMode") {
    return (
      <PlanApproval
        onSend={onSendFollowUp ?? (() => {})}
        disabled={isQuestionDisabled}
        planContent={planContent}
        // Same purpose as above — when a tool_result exists for the
        // ExitPlanMode tool the plan has already been responded to, so
        // render the read-only confirmation rather than the action buttons.
        resolved={!!result}
      />
    );
  }

  if (tool.name === "TodoWrite") {
    return null; // latest is rendered outside the bubble; older ones are hidden
  }

  const presentResult = parsePresentToolResult(tool, result);
  if (presentResult) {
    return (
      <PresentToolChip
        presentId={presentResult.presentId}
        title={presentResult.title}
        inProgress={inProgress}
      />
    );
  }

  // Fallback: compact one-liner for non-file tools, with optional tool result
  // (showModal state is hoisted to the top of the component — see comment there)

  // Build a summary of the command/input for the tool line
  const commandText = "command" in tool.input && tool.input.command
    ? (tool.input.command as string).slice(0, 80)
    : null;
  const filePathText = "file_path" in tool.input && tool.input.file_path
    ? sessionRelativePath(tool.input.file_path)
    : null;
  const patternText = "pattern" in tool.input && tool.input.pattern
    ? (tool.input.pattern as string)
    : null;
  const queryText = "query" in tool.input && tool.input.query
    ? (tool.input.query as string)
    : null;
  const urlText = "url" in tool.input && tool.input.url
    ? (tool.input.url as string)
    : null;

  return (
    <div className="min-w-0 overflow-hidden">
      <div
        className={`group/tool text-xs text-(--color-text-secondary) pl-[1em] py-1 font-mono flex items-center gap-2 opacity-70 border-l-2 border-(--color-text-tertiary)/40${hasResult ? " [@media(pointer:coarse)]:active:opacity-50" : ""}`}
        onClick={hasResult ? () => setShowModal(true) : undefined}
      >
        {inProgress && <ToolSpinner />}
        <FormattedToolName name={tool.name} highlight={inProgress} />
        {commandText ? (
          <span className="ml-1 text-(--color-text-secondary) truncate">
            {commandText}
          </span>
        ) : null}
        {filePathText ? (
          <span className="ml-1 text-(--color-text-secondary) truncate">
            {filePathText}
          </span>
        ) : null}
        {patternText ? (
          <span className="ml-1 text-(--color-text-secondary) truncate">
            {patternText}
          </span>
        ) : null}
        {queryText ? (
          <span className="ml-1 text-(--color-text-secondary) truncate">
            {queryText}
          </span>
        ) : null}
        {urlText ? (
          <span className="ml-1 text-(--color-text-secondary) truncate">
            {urlText}
          </span>
        ) : null}
        {hasResult && (
          <button
            onClick={() => setShowModal(true)}
            className="hidden group-hover/tool:inline-flex items-center gap-1 ml-1 text-(--color-text-tertiary) hover:text-(--color-text-primary) transition-colors cursor-pointer"
            aria-label="Show output"
          >
            <EyeIcon size={12} />
            <span className="whitespace-nowrap">Show output</span>
          </button>
        )}
      </div>
      {showModal && result && (
        <ToolOutputModal
          toolName={tool.name}
          input={tool.input}
          result={result}
          onClose={() => setShowModal(false)}
        />
      )}
    </div>
  );
}

/** Maps a Codex file-change kind to a verb in Claude's vocabulary for visual parity. */
function patchKindVerb(kind?: string): string {
  switch (kind) {
    case "add": return "Write";
    case "delete": return "Delete";
    case "update": return "Edit";
    default: return kind ? kind.charAt(0).toUpperCase() + kind.slice(1) : "Edit";
  }
}

/** Parses an MCP tool name like "mcp__playwright__browser_take_screenshot" into { server, tool } parts. */
function parseMcpToolName(name: string): { server: string; tool: string } | null {
  if (!name.startsWith("mcp__")) return null;
  const parts = name.split("__");
  if (parts.length < 3) return null;
  return { server: parts[1], tool: parts.slice(2).join("__") };
}

/** Renders a tool name with an MCP server chip when applicable. */
function FormattedToolName({ name, highlight }: { name: string; highlight: boolean }) {
  const parsed = parseMcpToolName(name);
  if (!parsed) {
    return <span className={highlight ? "text-(--color-accent)" : ""}>{name}</span>;
  }
  return (
    <span className={`inline-flex items-center gap-1.5${highlight ? " text-(--color-accent)" : ""}`}>
      <span className="border border-current rounded px-1 py-px text-[10px] leading-tight opacity-70">{parsed.server}</span>
      <span>{parsed.tool}</span>
    </span>
  );
}

interface PresentToolResult {
  presentId: string;
  title?: string;
}

function parsePresentToolResult(tool: ToolUseBlock, result: ToolResultBlock | undefined): PresentToolResult | null {
  if (!isPresentTool(tool.name)) return null;
  if (!result) return null;

  const fallbackTitle = typeof tool.input.title === "string" ? tool.input.title : undefined;

  // The bridge returns `{ presentId, title? }`, but the agent's tool_result
  // wraps it: MCP results arrive as a content-block array
  // (`[{ type: "text", text: "<json>" }]`) which agent-event.ts JSON-stringifies
  // into `result.content`. So the raw string is usually the stringified array,
  // not the bare object — unwrap it before reading `presentId`.
  const payload = extractPresentPayload(result.content);
  if (payload && typeof payload.presentId === "string" && payload.presentId.length > 0) {
    return {
      presentId: payload.presentId,
      title: typeof payload.title === "string" ? payload.title : fallbackTitle,
    };
  }

  // Last resort: scan for a bare presentId token (e.g. inner text wasn't valid
  // JSON, or the content was a plain string).
  const match = /\bpres_[A-Za-z0-9_-]+\b/.exec(result.content);
  if (match) return { presentId: match[0], title: fallbackTitle };
  return null;
}

/**
 * Pull the `{ presentId, title? }` payload out of a tool_result content string,
 * tolerating both the bare-object shape and the MCP content-block-array shape
 * (`[{ type: "text", text: "<json>" }]`) that the real agent pipeline produces.
 */
function extractPresentPayload(raw: string): { presentId?: unknown; title?: unknown } | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (Array.isArray(value)) {
    const textBlock = value.find(
      (b): b is { type: string; text: string } =>
        !!b && typeof b === "object"
        && (b as { type?: unknown }).type === "text"
        && typeof (b as { text?: unknown }).text === "string",
    );
    if (!textBlock) return null;
    try {
      return JSON.parse(textBlock.text) as { presentId?: unknown; title?: unknown };
    } catch {
      return null;
    }
  }
  if (value && typeof value === "object") {
    return value as { presentId?: unknown; title?: unknown };
  }
  return null;
}

function isPresentTool(name: string): boolean {
  if (name === "present") return true;
  const parsed = parseMcpToolName(name);
  return parsed?.server === "shipit-present" && parsed.tool === "present";
}

function PresentToolChip({
  presentId,
  title,
  inProgress,
}: {
  presentId: string;
  title: string | undefined;
  inProgress: boolean;
}) {
  const focus = () => {
    usePresentStore.getState().focusById(presentId);
    useUiStore.getState().setRightTab("present");
    useUiStore.getState().setMobilePanel("preview");
    useUiStore.getState().setMobileSidebarOpen(false);
  };

  return (
    <div className="min-w-0 overflow-hidden py-1">
      <div className="inline-flex max-w-full items-center gap-2 rounded-md border border-(--color-border-secondary) bg-(--color-bg-secondary) px-2.5 py-1.5 text-xs text-(--color-text-secondary)">
        {inProgress ? <ToolSpinner /> : <PresentationChartIcon size={14} className="shrink-0 text-(--color-accent)" />}
        <span className="truncate text-(--color-text-primary)">
          {title ?? "Presentation"}
        </span>
        <button
          type="button"
          onClick={focus}
          className="shrink-0 rounded px-1.5 py-0.5 text-(--color-text-link) hover:bg-(--color-bg-hover) hover:text-(--color-text-primary) transition-colors"
          aria-label="View presentation"
        >
          View
        </button>
      </div>
    </div>
  );
}

/** Full-screen modal showing the agent's tool input and the tool's output. */
function ToolOutputModal({ toolName, input, result, onClose }: {
  toolName: string;
  input: Record<string, unknown>;
  result: ToolResultBlock;
  onClose: () => void;
}) {
  return (
    <Dialog open onOpenChange={(isOpen) => { if (!isOpen) onClose(); }}>
    <DialogContent className="w-[min(90vw,56rem)] max-h-[80vh] flex flex-col" aria-label="Tool output">
      <div className="flex items-center justify-between px-4 py-3 border-b border-(--color-border-primary)">
        <span className="text-xs font-semibold text-(--color-text-primary) shrink-0">Tool Call</span>
        <button
          onClick={onClose}
          className="p-1 rounded text-(--color-text-tertiary) hover:text-(--color-text-primary) hover:bg-(--color-bg-hover) transition-colors shrink-0 cursor-pointer"
          aria-label="Close"
        >
          <XIcon size={16} />
        </button>
      </div>
      <div className="flex-1 overflow-auto p-4">
        <ToolInput toolName={toolName} input={input} />
        <div className="text-[11px] font-semibold uppercase tracking-wide text-(--color-text-tertiary) mb-2">Output</div>
        <ToolResult tool={toolName} result={result} />
      </div>
    </DialogContent>
    </Dialog>
  );
}

/** Renders the agent's tool-call input as labeled fields above the output. */
function ToolInput({ toolName, input }: { toolName: string; input: Record<string, unknown> }) {
  const keys = Object.keys(input);
  return (
    <div className="mb-4 pb-4 border-b border-(--color-border-secondary)">
      <div className="text-xs text-(--color-text-secondary) font-mono mb-2">{toolName === "shell" ? "Shell" : toolName}</div>
      {keys.length === 0 ? (
        <div className="text-xs text-(--color-text-tertiary) font-mono italic">(no input)</div>
      ) : (
        <div className="flex flex-col gap-3">
          {keys.map((key) => (
            <ToolInputField key={key} toolName={toolName} fieldKey={key} value={input[key]} />
          ))}
        </div>
      )}
    </div>
  );
}

/** Renders one input field: bash-highlighted command, add/remove-tinted diff strings, or plain/JSON value. */
function ToolInputField({ toolName, fieldKey, value }: { toolName: string; fieldKey: string; value: unknown }) {
  // Codex's "shell" is bash too — give its command the same highlighted treatment as Claude's Bash.
  const isBash = toolName === "Bash" || toolName === "shell";
  const isCommand = fieldKey === "command" && typeof value === "string";
  const highlighted = useMemo(() => {
    if (!isCommand || !isBash || typeof value !== "string") return null;
    try {
      return hljs.highlight(value, { language: "bash" }).value;
    } catch {
      return null;
    }
  }, [isCommand, isBash, value]);

  const tone: "add" | "del" | "plain" =
    fieldKey === "new_string" || (toolName === "Write" && fieldKey === "content")
      ? "add"
      : fieldKey === "old_string"
        ? "del"
        : "plain";

  const isPath = (fieldKey === "file_path" || fieldKey === "path") && typeof value === "string";
  const display = isPath
    ? sessionRelativePath(value)
    : typeof value === "string"
      ? value
      : JSON.stringify(value, null, 2);

  const toneClass =
    tone === "add"
      ? "bg-(--color-success)/10 text-(--color-success)"
      : tone === "del"
        ? "bg-(--color-error)/10 text-(--color-error)"
        : "bg-(--color-bg-secondary) text-(--color-text-primary)";

  return (
    <div>
      <div className="text-[11px] font-mono text-(--color-accent) mb-1 flex items-center gap-1.5">
        <span>{fieldKey}</span>
        {tone === "del" && <ToolInputTag label="removed" />}
        {tone === "add" && <ToolInputTag label="added" />}
      </div>
      <pre className={`text-xs font-mono whitespace-pre-wrap wrap-break-word rounded p-3 leading-relaxed ${toneClass}`}>
        {highlighted ? (
          <code className="hljs bg-transparent!" dangerouslySetInnerHTML={{ __html: highlighted }} />
        ) : (
          <code>{display}</code>
        )}
      </pre>
    </div>
  );
}

function ToolInputTag({ label }: { label: string }) {
  return (
    <span className="text-[9px] border border-current rounded px-1 py-px leading-tight opacity-60 text-(--color-text-tertiary)">
      {label}
    </span>
  );
}

/** Shows a small progress bar under file-modifying tools while they're running. */
export function ToolProgressBar({ tool }: { tool: string }) {
  return (
    <div className="flex items-center gap-1.5 mt-1 text-xs text-(--color-accent)">
      <ToolSpinner />
      <span>{tool === "Write" ? "Writing..." : "Applying edit..."}</span>
    </div>
  );
}
