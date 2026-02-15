import { useEffect, useRef } from "react";

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

export function MessageList({
  messages,
  isLoading,
}: {
  messages: ChatMessage[];
  isLoading: boolean;
}) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isLoading]);

  return (
    <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
      {messages.length === 0 && (
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
                {msg.toolUse.map((tool) => (
                  <div
                    key={tool.id}
                    className="text-xs text-gray-400 bg-gray-900 rounded px-2 py-1 font-mono"
                  >
                    Tool: {tool.name}
                    {"command" in tool.input && tool.input.command ? (
                      <span className="ml-2 text-gray-500">
                        {String(tool.input.command).slice(0, 80)}
                      </span>
                    ) : null}
                    {"file_path" in tool.input && tool.input.file_path ? (
                      <span className="ml-2 text-gray-500">
                        {String(tool.input.file_path)}
                      </span>
                    ) : null}
                  </div>
                ))}
              </div>
            )}

            {msg.streaming && (
              <span className="inline-block ml-1 w-2 h-4 bg-blue-400 animate-pulse rounded-sm" />
            )}
          </div>
        </div>
      ))}

      {isLoading && messages[messages.length - 1]?.role === "user" && (
        <div className="flex justify-start">
          <div className="bg-gray-800 rounded-lg px-4 py-3 text-sm text-gray-400">
            Claude is thinking...
          </div>
        </div>
      )}

      <div ref={bottomRef} />
    </div>
  );
}
