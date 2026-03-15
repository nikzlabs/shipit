// eslint-disable-next-line no-restricted-imports -- useEffect: xterm auto-scroll for tool group
import { useEffect, useRef, useState } from "react";
import { DiffBlock } from "./DiffBlock.js";
import { ToolSpinner } from "./StreamingIndicator.js";
import { AskUserQuestion, type AskQuestionItem } from "./AskUserQuestion.js";
import { PlanApproval } from "./PlanApproval.js";
import { ToolResult } from "./ToolResult.js";
import { Button } from "./ui/button.js";
import { sessionRelativePath } from "../path-utils.js";
import type { ToolUseBlock, ToolResultBlock } from "./MessageList.js";

/** Scrollable container for consecutive tool calls. Max 5 lines, auto-scrolls during streaming. */
export function ToolCallGroup({ items, isStreaming }: {
  items: { tool: ToolUseBlock; result?: ToolResultBlock; isLast: boolean }[];
  isStreaming: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when new tools are added during streaming
  useEffect(() => {
    if (isStreaming && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [items.length, isStreaming]);

  return (
    <div
      ref={scrollRef}
      className="bg-(--color-bg-secondary) rounded max-h-30 overflow-y-auto"
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

export function ToolUseItem({ tool, result, isLast, isStreaming, onAnswerQuestion, onSendFollowUp, isQuestionDisabled, grouped }: { tool: ToolUseBlock; result?: ToolResultBlock; isLast: boolean; isStreaming: boolean; onAnswerQuestion?: (toolUseId: string, answers: Record<string, string>) => void; onSendFollowUp?: (text: string) => void; isQuestionDisabled: boolean; grouped?: boolean }) {
  // Show a spinner on the last tool when the message is still streaming
  const inProgress = isLast && isStreaming && !result;
  const [collapsed, setCollapsed] = useState(true);
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
        disabled={isQuestionDisabled || isStreaming}
      />
    );
  }

  if (tool.name === "ExitPlanMode") {
    return (
      <PlanApproval
        onSend={onSendFollowUp ?? (() => {})}
        disabled={isQuestionDisabled || isStreaming}
      />
    );
  }

  if (tool.name === "TodoWrite") {
    return null; // latest is rendered outside the bubble; older ones are hidden
  }

  // Fallback: compact one-liner for non-file tools, with optional tool result
  return (
    <div className="min-w-0 overflow-hidden">
      <div className={`text-xs text-(--color-text-secondary) px-2 py-1 font-mono flex items-center gap-2${grouped ? "" : " bg-(--color-bg-secondary) rounded"}`}>
        {inProgress && <ToolSpinner />}
        <span className={inProgress ? "text-(--color-accent)" : ""}>
          {tool.name}
        </span>
        {"command" in tool.input && tool.input.command ? (
          <span className="ml-1 text-(--color-text-secondary) truncate max-w-xs">
            {(tool.input.command as string).slice(0, 80)}
          </span>
        ) : null}
        {"file_path" in tool.input && tool.input.file_path ? (
          <span className="ml-1 text-(--color-text-secondary) truncate max-w-xs">
            {sessionRelativePath(tool.input.file_path)}
          </span>
        ) : null}
        {"pattern" in tool.input && tool.input.pattern ? (
          <span className="ml-1 text-(--color-text-secondary) truncate max-w-xs">
            {tool.input.pattern as string}
          </span>
        ) : null}
        {hasResult && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setCollapsed(!collapsed)}
            className="ml-auto shrink-0 py-0"
            aria-label={collapsed ? "Show output" : "Hide output"}
            aria-expanded={!collapsed}
          >
            {collapsed ? "▶ Show output" : "▼ Hide output"}
          </Button>
        )}
      </div>
      {hasResult && !collapsed && (
        <ToolResult tool={tool.name} result={result} />
      )}
    </div>
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
