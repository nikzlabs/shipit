import { useEffect, useRef } from "react";
import { DiffBlock } from "./DiffBlock.js";
import {
  ThinkingIndicator,
  TypingDots,
  ToolSpinner,
  type StreamingActivity,
} from "./StreamingIndicator.js";

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ChatMessage {
  role: "user" | "assistant";
  text: string;
  toolUse?: ToolUseBlock[];
  streaming?: boolean;
}

function ToolUseItem({ tool, isLast, isStreaming }: { tool: ToolUseBlock; isLast: boolean; isStreaming: boolean }) {
  // Show a spinner on the last tool when the message is still streaming
  const inProgress = isLast && isStreaming;

  // Render file-modifying tools as diff blocks
  if (tool.name === "Edit") {
    const filePath = String(tool.input.file_path ?? "unknown");
    const oldString = tool.input.old_string != null ? String(tool.input.old_string) : undefined;
    const newString = tool.input.new_string != null ? String(tool.input.new_string) : undefined;
    return (
      <div>
        <DiffBlock filePath={filePath} oldString={oldString} newString={newString} />
        {inProgress && <ToolProgressBar tool={tool.name} />}
      </div>
    );
  }

  if (tool.name === "Write") {
    const filePath = String(tool.input.file_path ?? "unknown");
    const content = tool.input.content != null ? String(tool.input.content) : "";
    // For Write, show a truncated preview — full files can be very long
    const preview = content.length > 2000 ? content.slice(0, 2000) + "\n... (truncated)" : content;
    return (
      <div>
        <DiffBlock filePath={filePath} newString={preview} isWrite />
        {inProgress && <ToolProgressBar tool={tool.name} />}
      </div>
    );
  }

  // Fallback: compact one-liner for non-file tools
  return (
    <div className="text-xs text-gray-400 bg-gray-900 rounded px-2 py-1 font-mono flex items-center gap-2">
      {inProgress && <ToolSpinner />}
      <span className={inProgress ? "text-blue-400" : ""}>
        {tool.name}
      </span>
      {"command" in tool.input && tool.input.command ? (
        <span className="ml-1 text-gray-500 truncate max-w-xs">
          {String(tool.input.command).slice(0, 80)}
        </span>
      ) : null}
      {"file_path" in tool.input && tool.input.file_path ? (
        <span className="ml-1 text-gray-500 truncate max-w-xs">
          {String(tool.input.file_path)}
        </span>
      ) : null}
      {"pattern" in tool.input && tool.input.pattern ? (
        <span className="ml-1 text-gray-500 truncate max-w-xs">
          {String(tool.input.pattern)}
        </span>
      ) : null}
    </div>
  );
}

/** Shows a small progress bar under file-modifying tools while they're running. */
function ToolProgressBar({ tool }: { tool: string }) {
  return (
    <div className="flex items-center gap-1.5 mt-1 text-xs text-blue-400">
      <ToolSpinner />
      <span>{tool === "Write" ? "Writing..." : "Applying edit..."}</span>
    </div>
  );
}

export function MessageList({
  messages,
  isLoading,
  activity,
}: {
  messages: ChatMessage[];
  isLoading: boolean;
  activity?: StreamingActivity;
}) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isLoading]);

  return (
    <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
      {messages.length === 0 && !isLoading && (
        <div className="flex items-center justify-center h-full text-gray-500">
          <p>Send a message to start coding with Claude.</p>
        </div>
      )}

      {messages.map((msg, i) => (
        <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
          <div
            className={`max-w-2xl rounded-lg px-4 py-3 text-sm whitespace-pre-wrap ${
              msg.role === "user"
                ? "bg-blue-600 text-white"
                : "bg-gray-800 text-gray-100"
            }`}
          >
            {msg.text}

            {msg.toolUse && msg.toolUse.length > 0 && (
              <div className="mt-2 space-y-1">
                {msg.toolUse.map((tool, toolIdx) => (
                  <ToolUseItem
                    key={tool.id}
                    tool={tool}
                    isLast={toolIdx === msg.toolUse!.length - 1}
                    isStreaming={!!msg.streaming}
                  />
                ))}
              </div>
            )}

            {msg.streaming && (
              <span className="inline-flex items-center ml-1 align-middle">
                <TypingDots />
              </span>
            )}
          </div>
        </div>
      ))}

      {/* Thinking indicator — shown when loading and no assistant message has arrived yet */}
      {isLoading && messages[messages.length - 1]?.role === "user" && (
        <ThinkingIndicator activity={activity} />
      )}

      <div ref={bottomRef} />
    </div>
  );
}
