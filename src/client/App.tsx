import { useState, useEffect, useRef, useCallback } from "react";
import { useWebSocket } from "./hooks/useWebSocket.js";
import { MessageInput } from "./components/MessageInput.js";
import { MessageList, type ChatMessage } from "./components/MessageList.js";
import { PreviewFrame, type PreviewStatus } from "./components/PreviewFrame.js";
import { GitHistory, type GitCommit } from "./components/GitHistory.js";
import { AuthOverlay } from "./components/AuthOverlay.js";
import { SessionSelector, type SessionInfo } from "./components/SessionSelector.js";

function getWsUrl(): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/ws`;
}

export default function App() {
  const { send, lastMessage, status } = useWebSocket(getWsUrl());
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [preview, setPreview] = useState<PreviewStatus | null>(null);
  const [gitCommits, setGitCommits] = useState<GitCommit[]>([]);
  const [authUrl, setAuthUrl] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
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

    if (data.type === "preview_status") {
      setPreview({
        running: data.running,
        port: data.port,
        url: data.url,
      });
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

    if (data.type === "git_log") {
      setGitCommits(data.commits);
    }

    if (data.type === "git_committed") {
      // Prepend the new commit to the list
      setGitCommits((prev) => [
        { hash: data.hash, message: data.message, date: new Date().toISOString(), author: "Vibe" },
        ...prev,
      ]);
    }

    if (data.type === "rollback_complete") {
      // Refresh the git log after rollback
      send({ type: "get_git_log" });
    }

    if (data.type === "auth_required") {
      setAuthUrl(data.url);
    }

    if (data.type === "auth_complete") {
      setAuthUrl(null);
    }

    if (data.type === "session_list") {
      setSessions(data.sessions);
    }

    if (data.type === "session_started") {
      sessionIdRef.current = data.session.id;
      setSessions((prev) => {
        const exists = prev.some((s) => s.id === data.session.id);
        if (exists) {
          return prev.map((s) => (s.id === data.session.id ? data.session : s));
        }
        return [data.session, ...prev];
      });
    }
  }, [lastMessage, send]);

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

  const handleGitRefresh = useCallback(() => {
    send({ type: "get_git_log" });
  }, [send]);

  const handleRollback = useCallback(
    (hash: string) => {
      send({ type: "rollback", commitHash: hash });
    },
    [send]
  );

  const handleSessionRefresh = useCallback(() => {
    send({ type: "list_sessions" });
  }, [send]);

  const handleSessionResume = useCallback(
    (sessionId: string) => {
      sessionIdRef.current = sessionId;
      setMessages([]);
      setIsLoading(false);
    },
    []
  );

  const handleSessionNew = useCallback(() => {
    sessionIdRef.current = undefined;
    setMessages([]);
    setIsLoading(false);
    send({ type: "new_session" });
  }, [send]);

  const handleSessionDelete = useCallback(
    (sessionId: string) => {
      send({ type: "delete_session", sessionId });
    },
    [send]
  );

  return (
    <div className="flex flex-col h-screen bg-gray-950 text-gray-100">
      {authUrl && <AuthOverlay url={authUrl} />}

      {/* Header */}
      <header className="flex items-center justify-between px-6 py-3 border-b border-gray-800">
        <div className="flex items-center gap-4">
          <h1 className="text-lg font-semibold tracking-tight">Vibe</h1>
          <SessionSelector
            sessions={sessions}
            currentSessionId={sessionIdRef.current}
            onResume={handleSessionResume}
            onNew={handleSessionNew}
            onDelete={handleSessionDelete}
            onRefresh={handleSessionRefresh}
          />
        </div>
        <div className="flex items-center gap-3">
          {preview?.running && (
            <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-900 text-emerald-300">
              preview :{ preview.port}
            </span>
          )}
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
        </div>
      </header>

      {/* Main content: two-column layout */}
      <div className="flex flex-1 min-h-0">
        {/* Left column — Chat */}
        <div className="flex flex-col flex-1 min-w-0 border-r border-gray-800">
          <MessageList messages={messages} isLoading={isLoading} />
          <GitHistory
            commits={gitCommits}
            onRollback={handleRollback}
            onRefresh={handleGitRefresh}
          />
          <MessageInput onSend={handleSend} disabled={isLoading || status !== "open"} />
        </div>

        {/* Right column — Live Preview */}
        <div className="w-1/2 min-w-0 hidden md:flex flex-col bg-gray-900">
          <PreviewFrame preview={preview} />
        </div>
      </div>
    </div>
  );
}
