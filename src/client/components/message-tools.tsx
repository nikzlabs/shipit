// eslint-disable-next-line no-restricted-imports -- useEffect: xterm auto-scroll for tool group
import { useEffect, useRef, useState } from "react";
import { useMemo } from "react";
import {
  DownloadSimpleIcon,
  EyeIcon,
  FilesIcon,
  GlobeIcon,
  type Icon,
  MagnifyingGlassIcon,
  NotebookIcon,
  PresentationChartIcon,
  ScrollIcon,} from "@phosphor-icons/react";
import { highlightCode } from "../syntax-highlight.js";
import { DiffBlock } from "./DiffBlock.js";
import { ToolSpinner } from "./StreamingIndicator.js";
import { AskUserQuestion, type AskQuestionItem, type AnswerQuestionFn } from "./AskUserQuestion.js";
import { PlanApproval } from "./PlanApproval.js";
import { ToolResult } from "./ToolResult.js";
import { Dialog, DialogContent } from "./ui/dialog.js";
import { Button } from "./ui/button.js";
import { ICON_SIZE } from "../design-tokens.js";
import { sessionRelativePath } from "../path-utils.js";
import { usePresentStore } from "../stores/present-store.js";
import { revealWorkspaceTab } from "../utils/reveal-workspace-tab.js";
import { parseMcpToolName, isPresentTool } from "./tool-names.js";
import { COMMAND_SUMMARY_CHARS } from "../../server/shared/transcript-input-policy.js";
import { isTaskListTool } from "../../server/shared/task-list-tools.js";
import { useLazyToolInput } from "../hooks/useLazyToolInput.js";
import type { ToolUseBlock, ToolResultBlock } from "./MessageList.js";

export function ToolCallGroup({ items, isStreaming }: {
  items: { tool: ToolUseBlock; result?: ToolResultBlock; isLast: boolean }[];
  isStreaming: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);

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

export function ToolUseItem({ tool, result, isLast, isStreaming, onAnswerQuestion, onSendFollowUp, isQuestionDisabled, grouped: _grouped, planContent }: { tool: ToolUseBlock; result?: ToolResultBlock; isLast: boolean; isStreaming: boolean; onAnswerQuestion?: AnswerQuestionFn; onSendFollowUp?: (text: string) => void; isQuestionDisabled: boolean; grouped?: boolean; planContent?: string }) {
  // IMPORTANT: all hooks must be called before any conditional `return` below.

  const [showModal, setShowModal] = useState(false);

  const inProgress = isLast && isStreaming && !result;
  const hasResult = !!result;

  if (tool.name === "Edit") {
    const filePath = (tool.input.file_path as string) ?? "unknown";
    const oldString = tool.input.old_string !== null && tool.input.old_string !== undefined ? (tool.input.old_string as string) : undefined;
    const newString = tool.input.new_string !== null && tool.input.new_string !== undefined ? (tool.input.new_string as string) : undefined;
    return (
      <div>
        <DiffBlock
          filePath={filePath}
          oldString={oldString}
          newString={newString}
          toolUseId={tool.id}
          {...(tool.diffStats ? { stats: tool.diffStats } : {})}
        />
        {inProgress && <ToolProgressBar tool={tool.name} />}
      </div>
    );
  }

  if (tool.name === "Write") {
    const filePath = (tool.input.file_path as string) ?? "unknown";
    const content = tool.input.content !== null && tool.input.content !== undefined ? (tool.input.content as string) : "";
    return (
      <div>
        <DiffBlock
          filePath={filePath}
          newString={content}
          isWrite
          toolUseId={tool.id}
          {...(tool.diffStats ? { stats: tool.diffStats } : {})}
        />
        {inProgress && <ToolProgressBar tool={tool.name} />}
      </div>
    );
  }

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

        onAnswer={onAnswerQuestion ?? (() => false)}
        disabled={isQuestionDisabled}

        resolvedAnswer={result?.content}
      />
    );
  }

  if (tool.name === "EnterPlanMode") {
    return (
      <div className="mt-2 rounded-lg border border-(--color-border-secondary) bg-(--color-bg-secondary)/80 overflow-hidden p-3" data-testid="plan-mode-entered">
        <div className="flex items-center gap-2 text-sm text-(--color-text-primary)">
          <ScrollIcon size={ICON_SIZE.SM} weight="fill" className="text-(--color-accent)" />
          <span>Plan mode started.</span>
        </div>
      </div>
    );
  }

  if (tool.name === "ExitPlanMode") {
    return (
      <PlanApproval
        onSend={onSendFollowUp ?? (() => {})}
        disabled={isQuestionDisabled}
        planContent={planContent}

        resolved={!!result}
      />
    );
  }

  if (isTaskListTool(tool.name)) {
    return null;
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

  const isInspectable = inProgress || hasResult;

  const commandText = "command" in tool.input && tool.input.command
    ? (tool.input.command as string).slice(0, COMMAND_SUMMARY_CHARS)
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

  const isCommandTool = tool.name === "Bash" || tool.name === "shell";

  return (
    <div className="min-w-0 overflow-hidden">
      <div
        className={`group/tool text-xs text-(--color-text-secondary) pl-[1em] py-1 font-mono flex items-center gap-2 opacity-70 border-l-2 border-(--color-text-tertiary)/40${isInspectable ? " cursor-pointer [@media(pointer:coarse)]:active:opacity-50" : ""}`}
        onClick={isInspectable ? () => setShowModal(true) : undefined}
      >
        {inProgress && <ToolSpinner />}
        {!isCommandTool && <FormattedToolName name={tool.name} highlight={inProgress} />}
        {commandText ? (
          <span className={`${isCommandTool ? "" : "ml-1 "}text-(--color-text-secondary) truncate`}>
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
        {isInspectable && (
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setShowModal(true)}

            // vertical padding so revealing it on hover never grows the row.

            className="hidden group-hover/tool:inline-flex ml-1 cursor-pointer h-4 py-0"
            aria-label={hasResult ? "Show output" : "Show input"}
          >
            <EyeIcon size={12} />
            <span className="whitespace-nowrap">{hasResult ? "Show output" : "Show input"}</span>
          </Button>
        )}
      </div>
      {showModal && (
        <ToolOutputModal
          toolName={tool.name}
          input={tool.input}
          toolUseId={tool.id}
          bodyTruncated={tool.bodyTruncated}
          startedAt={tool.startedAt}
          result={result}
          onClose={() => setShowModal(false)}
        />
      )}
    </div>
  );
}

function patchKindVerb(kind?: string): string {
  switch (kind) {
    case "add": return "Write";
    case "delete": return "Delete";
    case "update": return "Edit";
    default: return kind ? kind.charAt(0).toUpperCase() + kind.slice(1) : "Edit";
  }
}

/**
 * Per-tool glyph + short verb for the inline tool line. The icon anchors the
 * eye; the one-word `label` keeps the verb visible (not hover-only) so it reads
 * on touch too. Labels are kept to a single word so the line never wraps.
 *
 * Only tools that actually reach `FormattedToolName` are listed — the read-only
 * / fetch tools that fall through to the compact one-liner. These are Claude's
 * PascalCase names; Codex emits only `shell` and `apply_patch` on this surface,
 * both handled before we ever look here, so it needs no entry.
 *
 * Intentionally absent:
 *   - Bash / shell → command tools render flush with no icon (see `isCommandTool`).
 *   - Edit / Write / apply_patch → file changes render as DiffBlocks; their glyph
 *     comes from `VerbBadge` (DiffBlock.tsx), not this map.
 *   - Task → subagent calls render as a dedicated `SubagentCall` element.
 * Earlier this map also carried lowercase canonical aliases (`grep`, `glob`,
 * `file_*`, `web_*`, `browser`); they were dropped because no backend emits them
 * on this surface — an unknown name correctly falls through to the text fallback.
 */
const TOOL_ICONS: Record<string, { Icon: Icon; label: string }> = {
  Read: { Icon: ScrollIcon, label: "Read" },
  Grep: { Icon: MagnifyingGlassIcon, label: "Grep" },
  Glob: { Icon: FilesIcon, label: "Glob" },
  WebFetch: { Icon: DownloadSimpleIcon, label: "Fetch" },
  WebSearch: { Icon: GlobeIcon, label: "Search" },
  NotebookEdit: { Icon: NotebookIcon, label: "Notebook" },
};

function FormattedToolName({ name, highlight }: { name: string; highlight: boolean }) {
  const parsed = parseMcpToolName(name);
  if (parsed) {
    return (
      <span className={`inline-flex shrink-0 items-center gap-1.5${highlight ? " text-(--color-accent)" : ""}`}>
        <span className="shrink-0 border border-current rounded px-1 py-px text-[10px] leading-tight opacity-70">{parsed.server}</span>
        <span>{parsed.tool}</span>
      </span>
    );
  }
  const mapped = TOOL_ICONS[name];
  if (mapped) {
    const { Icon, label } = mapped;
    return (
      <span className={`inline-flex shrink-0 items-center gap-1.5${highlight ? " text-(--color-accent)" : ""}`}>
        <Icon size={ICON_SIZE.SM} aria-hidden />
        <span>{label}</span>
      </span>
    );
  }
  return <span className={highlight ? "text-(--color-accent)" : ""}>{name}</span>;
}

interface PresentToolResult {
  presentId: string;
  title?: string;
}

// Exported for the docs/244 req-4 guard: the projection must never slice a

export function parsePresentToolResult(tool: ToolUseBlock, result: ToolResultBlock | undefined): PresentToolResult | null {
  if (!isPresentTool(tool.name)) return null;
  if (!result) return null;

  const fallbackTitle = typeof tool.input.title === "string" ? tool.input.title : undefined;

  const payload = extractPresentPayload(result.content);
  if (payload && typeof payload.presentId === "string" && payload.presentId.length > 0) {
    return {
      presentId: payload.presentId,
      title: typeof payload.title === "string" ? payload.title : fallbackTitle,
    };
  }

  const match = /\bpres_[A-Za-z0-9_-]+\b/.exec(result.content);
  if (match) return { presentId: match[0], title: fallbackTitle };
  return null;
}

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
    return value;
  }
  return null;
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
    revealWorkspaceTab("present");
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

export function formatToolDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  return s < 10 ? `${s.toFixed(1)} s` : `${Math.round(s)} s`;
}

/** Adds the date for tool calls from another day; invalid timestamps render nothing. */
export function formatToolCallTime(iso: string | undefined, now: Date = new Date()): string {
  if (!iso) return "";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  const time = at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const sameDay = at.getFullYear() === now.getFullYear()
    && at.getMonth() === now.getMonth()
    && at.getDate() === now.getDate();
  if (sameDay) return time;
  return `${at.toLocaleDateString([], { month: "short", day: "numeric" })}, ${time}`;
}

/** Shows complete stored input and supports a pending result. */
function ToolOutputModal({ toolName, input, toolUseId, bodyTruncated, startedAt, result, onClose }: {
  toolName: string;
  input: Record<string, unknown>;
  toolUseId?: string;
  bodyTruncated?: true;
  startedAt?: string;
  result?: ToolResultBlock;
  onClose: () => void;
}) {
  const lazy = useLazyToolInput(toolUseId, !!bodyTruncated);
  const duration = typeof result?.durationMs === "number" ? formatToolDuration(result.durationMs) : "";
  const calledAt = formatToolCallTime(startedAt);
  const resolvedInput = lazy.input ?? input;
  const filePath = typeof resolvedInput.file_path === "string" ? resolvedInput.file_path : undefined;
  return (
    <Dialog open onOpenChange={(isOpen) => { if (!isOpen) onClose(); }}>
    {/* The header row below is 40px tall, so the close button — a 28px box —
        centres on it at (40 - 28) / 2 = 6px rather than the 12px default, which
        left it 6px low and grazing the row's bottom border. */}
    <DialogContent
      className="w-[min(90vw,56rem)] max-h-[80vh] flex flex-col [--dialog-close-top:0.375rem]"
      aria-label="Tool output"
    >
      {/* `pr-12` keeps the time clear of that close button (12px inset + a 28px
          box = 40px), with the row's own 8px gap left between the two. */}
      <div className="flex items-center gap-2 pl-4 pr-12 py-3 border-b border-(--color-border-primary)">
        <span className="text-xs font-semibold text-(--color-text-primary) shrink-0">Tool Call</span>
        {calledAt ? (
          <span
            data-testid="tool-call-time"
            className="ml-auto text-[11px] font-mono text-(--color-text-tertiary) shrink-0"
            title={`Called at ${new Date(startedAt!).toLocaleString()}`}
          >
            {calledAt}
          </span>
        ) : null}
      </div>
      <div className="flex-1 overflow-auto p-4">
        <ToolInput
          toolName={toolName}
          input={resolvedInput}
          loading={lazy.loading}
          error={lazy.error}
        />
        <div className="flex items-baseline gap-2 mb-2">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-(--color-text-tertiary)">Output</span>
          {duration ? (
            <span
              className="text-[11px] font-mono text-(--color-text-tertiary)"
              title="Time from the tool call to its result. For tools that wait on approval, this includes that wait."
            >
              {duration}
            </span>
          ) : null}
        </div>
        {result ? (
          <ToolResult tool={toolName} result={result} {...(filePath ? { filePath } : {})} />
        ) : (
          <div className="flex items-center gap-2 text-xs text-(--color-text-tertiary) font-mono italic">
            <ToolSpinner />
            <span>Running…</span>
          </div>
        )}
      </div>
    </DialogContent>
    </Dialog>
  );
}

function ToolInput({ toolName, input, loading, error }: {
  toolName: string;
  input: Record<string, unknown>;
  loading?: boolean;
  error?: boolean;
}) {
  const keys = Object.keys(input);
  return (
    <div className="mb-4 pb-4 border-b border-(--color-border-secondary)">
      <div className="text-xs text-(--color-text-secondary) font-mono mb-2">{toolName === "shell" ? "Shell" : toolName}</div>
      {keys.length === 0 && !loading && !error ? (
        <div className="text-xs text-(--color-text-tertiary) font-mono italic">(no input)</div>
      ) : (
        <div className="flex flex-col gap-3">
          {keys.map((key) => (
            <ToolInputField key={key} toolName={toolName} fieldKey={key} value={input[key]} />
          ))}
        </div>
      )}
      {loading && (
        <div className="mt-2 text-xs text-(--color-text-tertiary) font-mono italic" role="status">Loading input…</div>
      )}
      {error && (
        <div className="mt-2 text-xs text-(--color-error)" role="status">Couldn&apos;t load the full input.</div>
      )}
    </div>
  );
}

function ToolInputField({ toolName, fieldKey, value }: { toolName: string; fieldKey: string; value: unknown }) {

  const isBash = toolName === "Bash" || toolName === "shell";
  const isCommand = fieldKey === "command" && typeof value === "string";
  const highlighted = useMemo(() => {
    if (!isCommand || !isBash || typeof value !== "string") return null;
    return highlightCode(value, "bash");
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

export function ToolProgressBar({ tool }: { tool: string }) {
  return (
    <div className="flex items-center gap-1.5 mt-1 text-xs text-(--color-accent)">
      <ToolSpinner />
      <span>{tool === "Write" ? "Writing..." : "Applying edit..."}</span>
    </div>
  );
}
