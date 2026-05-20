// eslint-disable-next-line no-restricted-imports -- useEffect: xterm auto-scroll for tool group
import { useEffect, useRef, useState } from "react";
import { useMemo } from "react";
import { EyeIcon, XIcon } from "@phosphor-icons/react";
import hljs from "highlight.js";
import { DiffBlock } from "./DiffBlock.js";
import { ToolSpinner } from "./StreamingIndicator.js";
import { AskUserQuestion, type AskQuestionItem } from "./AskUserQuestion.js";
import { PlanApproval } from "./PlanApproval.js";
import { ToolResult } from "./ToolResult.js";
import { Dialog, DialogContent } from "./ui/dialog.js";
import { sessionRelativePath } from "../path-utils.js";
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

export function ToolUseItem({ tool, result, isLast, isStreaming, onAnswerQuestion, onSendFollowUp, isQuestionDisabled, grouped: _grouped, planContent }: { tool: ToolUseBlock; result?: ToolResultBlock; isLast: boolean; isStreaming: boolean; onAnswerQuestion?: (toolUseId: string, answers: Record<string, string>) => void; onSendFollowUp?: (text: string) => void; isQuestionDisabled: boolean; grouped?: boolean; planContent?: string }) {
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
  // Short description (e.g. Agent/Task subagent task) — only used as a
  // fallback when no more specific input field applies, so tools like Bash
  // (which carry both `command` and `description`) don't render twice.
  const descriptionText = !commandText && !filePathText && !patternText && !queryText && !urlText
    && "description" in tool.input && tool.input.description
    ? (tool.input.description as string)
    : null;

  // Full command text for the modal header
  const fullCommandText = "command" in tool.input && tool.input.command
    ? (tool.input.command as string)
    : filePathText ?? patternText ?? queryText ?? urlText ?? descriptionText ?? "";

  return (
    <div className="min-w-0 overflow-hidden">
      <div className="group/tool text-xs text-(--color-text-secondary) pl-[1em] py-1 font-mono flex items-center gap-2 opacity-70 border-l-2 border-(--color-text-tertiary)/40">
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
        {descriptionText ? (
          <span className="ml-1 text-(--color-text-secondary) truncate">
            {descriptionText}
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
          command={fullCommandText}
          result={result}
          onClose={() => setShowModal(false)}
        />
      )}
    </div>
  );
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

/** Full-screen modal showing tool command and output. */
function ToolOutputModal({ toolName, command, result, onClose }: {
  toolName: string;
  command: string;
  result: ToolResultBlock;
  onClose: () => void;
}) {
  const isBash = toolName === "Bash";
  const highlighted = useMemo(() => {
    if (!isBash || !command) return null;
    try {
      return hljs.highlight(command, { language: "bash" }).value;
    } catch {
      return null;
    }
  }, [isBash, command]);

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
        {isBash && command ? (
          <div className="mb-4 pb-4 border-b border-(--color-border-secondary)">
            <div className="text-xs text-(--color-text-secondary) font-mono mb-1">Bash</div>
            <pre className="text-xs font-mono whitespace-pre-wrap wrap-break-word rounded bg-(--color-bg-secondary) p-3 leading-relaxed">
              {highlighted ? (
              <code className="hljs bg-transparent!" dangerouslySetInnerHTML={{ __html: highlighted }} />
            ) : (
              <code className="text-(--color-text-primary)">{command}</code>
            )}
            </pre>
          </div>
        ) : (
          <pre className="text-xs text-(--color-text-secondary) font-mono whitespace-pre-wrap break-all mb-4 pb-4 border-b border-(--color-border-secondary)">{toolName}{command ? ` ${command}` : ""}</pre>
        )}
        <ToolResult tool={toolName} result={result} />
      </div>
    </DialogContent>
    </Dialog>
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
