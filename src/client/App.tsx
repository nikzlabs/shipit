import { useState, useEffect, useRef, useCallback } from "react";
import { useWebSocket } from "./hooks/useWebSocket.js";
import { MessageInput } from "./components/MessageInput.js";
import { MessageList, type ChatMessage } from "./components/MessageList.js";

function getWsUrl(): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/ws`;
}

export default function App() {
  const { send, lastMessage, status } = useWebSocket(getWsUrl());
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const sessionIdRef = useRef<string | undefined>(undefined);

  // Process incoming WebSocket messages
  useEffect(() => {
    if (!lastMessage) return;

    let data: any;
    try {
      data = JSON.parse(lastMessage.data);
    } catch {
      return;
    }

    if (data.type === "claude_event") {
      const event = data.event;

      if (event.type === "system" && event.subtype === "init") {
        sessionIdRef.current = event.session_id;
      }

      if (event.type === "assistant") {
        const textBlocks = (event.message?.content ?? [])
          .filter((b: any) => b.type === "text")
          .map((b: any) => b.text)
          .join("");

        const toolUseBlocks = (event.message?.content ?? [])
          .filter((b: any) => b.type === "tool_use");

        if (textBlocks || toolUseBlocks.length > 0) {
          setMessages((prev) => {
            // If the last message is from the assistant and we're still loading,
            // replace it (streaming update)
            const last = prev[prev.length - 1];
            if (last && last.role === "assistant" && last.streaming) {
              return [
                ...prev.slice(0, -1),
                {
                  role: "assistant" as const,
                  text: textBlocks,
                  toolUse: toolUseBlocks,
                  streaming: true,
                },
              ];
            }
            return [
              ...prev,
              {
                role: "assistant" as const,
                text: textBlocks,
                toolUse: toolUseBlocks,
                streaming: true,
              },
            ];
          });
        }
      }

      if (event.type === "result") {
        setIsLoading(false);
        // Mark the last assistant message as no longer streaming
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last && last.role === "assistant") {
            return [...prev.slice(0, -1), { ...last, streaming: false }];
          }
          return prev;
        });
      }
    }

    if (data.type === "error") {
      setIsLoading(false);
      setMessages((prev) => [
        ...prev,
        { role: "assistant", text: `Error: ${data.message}`, streaming: false },
      ]);
    }
  }, [lastMessage]);

  const handleSend = useCallback(
    (text: string) => {
      setMessages((prev) => [...prev, { role: "user", text }]);
      setIsLoading(true);
      send({
        type: "send_message",
        text,
        sessionId: sessionIdRef.current,
      });
    },
    [send]
  );

  return (
    <div className="flex flex-col h-screen bg-gray-950 text-gray-100">
      {/* Header */}
      <header className="flex items-center justify-between px-6 py-3 border-b border-gray-800">
        <h1 className="text-lg font-semibold tracking-tight">Vibe</h1>
        <span
          className={`text-xs px-2 py-0.5 rounded-full ${
            status === "open"
              ? "bg-green-900 text-green-300"
              : status === "connecting"
              ? "bg-yellow-900 text-yellow-300"
              : "bg-red-900 text-red-300"
          }`}
        >
          {status}
        </span>
      </header>

      {/* Chat area */}
      <MessageList messages={messages} isLoading={isLoading} />

      {/* Input */}
      <MessageInput onSend={handleSend} disabled={isLoading || status !== "open"} />
    </div>
  );
}
