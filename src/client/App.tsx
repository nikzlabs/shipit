import { useState, useEffect, useRef, useCallback } from "react";
import { useWebSocket } from "./hooks/useWebSocket.js";
import { useResizablePanel } from "./hooks/useResizablePanel.js";
import { useSearch } from "./hooks/useSearch.js";
import { useIsMobile } from "./hooks/useMediaQuery.js";
import { useNotification } from "./hooks/useNotification.js";
import { MessageInput } from "./components/MessageInput.js";
import { MessageList, type ChatMessage } from "./components/MessageList.js";
import { PreviewFrame, type PreviewStatus } from "./components/PreviewFrame.js";
import { GitHistory, type GitCommit } from "./components/GitHistory.js";
import { AuthOverlay } from "./components/AuthOverlay.js";
import { SessionSelector, type SessionInfo } from "./components/SessionSelector.js";
import { DocsViewer } from "./components/DocsViewer.js";
import { FileTree, type FileTreeNode } from "./components/FileTree.js";
import { FileContentViewer } from "./components/FileContentViewer.js";
import { TerminalPanel, type LogEntry } from "./components/TerminalPanel.js";
import { ResizeHandle } from "./components/ResizeHandle.js";
import { SearchBar } from "./components/SearchBar.js";
import { activityFromTool, type StreamingActivity } from "./components/StreamingIndicator.js";
import { ConnectionBanner } from "./components/ConnectionBanner.js";
import { MobileTabBar, type MobilePanel } from "./components/MobileTabBar.js";
import { KeyboardShortcutsOverlay } from "./components/KeyboardShortcutsOverlay.js";
import type { WsServerMessage, WsSessionRenamed, ClaudeContentBlock, ClaudeContentBlockText, ClaudeContentBlockToolUse, WsChatHistoryMessage } from "../server/types.js";

type RightTab = "preview" | "docs" | "files" | "terminal";

const SESSION_STORAGE_KEY = "vibe-current-session";

function getWsUrl(): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/ws`;
}

function getSavedSessionId(): string | undefined {
  try {
    return localStorage.getItem(SESSION_STORAGE_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

function saveSessionId(id: string | undefined): void {
  try {
    if (id) {
      localStorage.setItem(SESSION_STORAGE_KEY, id);
    } else {
      localStorage.removeItem(SESSION_STORAGE_KEY);
    }
  } catch {
    // localStorage may be unavailable
  }
}

export default function App() {
  const { send, lastMessage, status, reconnectAttempt, reconnect } = useWebSocket(getWsUrl());
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [preview, setPreview] = useState<PreviewStatus | null>(null);
  const [selectedPort, setSelectedPort] = useState<number | null>(null);
  const detectedPorts = preview?.detectedPorts ?? [];
  const [gitCommits, setGitCommits] = useState<GitCommit[]>([]);
  const [authUrl, setAuthUrl] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [rightTab, setRightTab] = useState<RightTab>("preview");
  const [docFiles, setDocFiles] = useState<string[]>([]);
  const [selectedDoc, setSelectedDoc] = useState<string | null>(null);
  const [docContent, setDocContent] = useState<string | null>(null);
  const [fileTree, setFileTree] = useState<FileTreeNode[]>([]);
  const [viewingFile, setViewingFile] = useState<string | null>(null);
  const [viewingFileContent, setViewingFileContent] = useState<string | null>(null);
  const [viewingFileBinary, setViewingFileBinary] = useState(false);
  const [activity, setActivity] = useState<StreamingActivity | undefined>(undefined);
  const [logEntries, setLogEntries] = useState<LogEntry[]>([]);
  const [unreadLogCount, setUnreadLogCount] = useState(0);
  const sessionIdRef = useRef<string | undefined>(getSavedSessionId());
  // Track whether we've already requested history for the current connection
  const historyLoadedRef = useRef(false);

  const { fraction, isDragging, onMouseDown, onTouchStart, containerRef } = useResizablePanel({
    initialFraction: 0.5,
    minFraction: 0.25,
    storageKey: "vibe-panel-split",
  });

  const isMobile = useIsMobile();
  const [mobilePanel, setMobilePanel] = useState<MobilePanel>("chat");

  const [searchOpen, setSearchOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const search = useSearch(messages);

  const { notify, requestPermission } = useNotification();

  // Ctrl+F / Cmd+F to toggle search bar
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "f") {
        e.preventDefault();
        setSearchOpen((prev) => {
          if (prev) {
            search.clear();
            return false;
          }
          return true;
        });
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [search]);

  // ? to toggle keyboard shortcuts overlay (only when not typing in an input)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "?" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const tag = (e.target as HTMLElement)?.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
        e.preventDefault();
        setShortcutsOpen((prev) => !prev);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  // On WebSocket connect, restore chat history for the saved session
  useEffect(() => {
    if (status === "open" && !historyLoadedRef.current && sessionIdRef.current) {
      historyLoadedRef.current = true;
      send({ type: "get_chat_history", sessionId: sessionIdRef.current });
    }
    if (status === "closed") {
      historyLoadedRef.current = false;
    }
  }, [status, send]);

  // Handle WebSocket disconnection during streaming —
  // if the connection drops while Claude is responding, clean up the
  // loading state and show an error message so the user isn't stuck.
  const prevStatusRef = useRef(status);
  useEffect(() => {
    const wasOpen = prevStatusRef.current === "open";
    prevStatusRef.current = status;

    if (wasOpen && status === "closed" && isLoading) {
      setIsLoading(false);
      setActivity(undefined);
      setMessages((prev) => {
        // Mark any streaming assistant message as no longer streaming
        const last = prev[prev.length - 1];
        const updated =
          last && last.role === "assistant" && last.streaming
            ? [...prev.slice(0, -1), { ...last, streaming: false }]
            : prev;
        return [
          ...updated,
          {
            role: "assistant" as const,
            text: "Error: Connection lost while Claude was responding. Your message may be incomplete.",
            streaming: false,
            isError: true,
          },
        ];
      });
    }
  }, [status, isLoading]);

  // Process incoming WebSocket messages
  useEffect(() => {
    if (!lastMessage) return;

    let data: WsServerMessage;
    try {
      data = JSON.parse(lastMessage.data) as WsServerMessage;
    } catch {
      return;
    }

    if (data.type === "preview_status") {
      setPreview({
        running: data.running,
        port: data.port,
        url: data.url,
        source: data.source,
        detectedPorts: data.detectedPorts,
      });
      // Reset user selection if the selected port is no longer available
      setSelectedPort((prev) => {
        if (prev === null) return null;
        const allAvailable = [...(data.detectedPorts ?? [])];
        if (data.source === "vite") allAvailable.push(data.port);
        return allAvailable.includes(prev) ? prev : null;
      });
    }

    if (data.type === "claude_event") {
      const event = data.event;

      if (event.type === "system" && event.subtype === "init") {
        sessionIdRef.current = event.session_id;
        saveSessionId(event.session_id);
      }

      if (event.type === "assistant") {
        const textBlocks = (event.message?.content ?? [])
          .filter((b: ClaudeContentBlock): b is ClaudeContentBlockText => b.type === "text")
          .map((b) => b.text)
          .join("");

        const toolUseBlocks = (event.message?.content ?? [])
          .filter((b: ClaudeContentBlock): b is ClaudeContentBlockToolUse => b.type === "tool_use");

        // Update activity based on what's in this event
        if (toolUseBlocks.length > 0) {
          const lastTool = toolUseBlocks[toolUseBlocks.length - 1];
          setActivity(activityFromTool(lastTool.name, lastTool.input));
        } else if (textBlocks) {
          setActivity({ label: "Thinking..." });
        }

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

      // Track tool result events — Claude is processing results
      if (event.type === "user") {
        setActivity({ label: "Processing results..." });
      }

      if (event.type === "result") {
        setIsLoading(false);
        setActivity(undefined);
        notify("Claude has finished responding.");
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
      setActivity(undefined);
      // Mark any in-flight streaming message as done, then append the error
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        const updated =
          last && last.role === "assistant" && last.streaming
            ? [...prev.slice(0, -1), { ...last, streaming: false }]
            : prev;
        return [
          ...updated,
          { role: "assistant", text: `Error: ${data.message}`, streaming: false, isError: true },
        ];
      });
    }

    if (data.type === "git_log") {
      setGitCommits(data.commits);
    }

    if (data.type === "git_committed") {
      // Prepend the new commit to the list
      setGitCommits((prev) => [
        { hash: data.hash, message: data.message, date: new Date().toISOString(), author: "ShipIt" },
        ...prev,
      ]);
      // Refresh file tree if the Files tab is active (files likely changed)
      if (rightTab === "files") {
        send({ type: "get_file_tree" });
        // Re-fetch the viewed file's content so it stays up to date
        if (viewingFile) {
          send({ type: "get_file_content", path: viewingFile });
        }
      }
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
      saveSessionId(data.session.id);
      setSessions((prev) => {
        const exists = prev.some((s) => s.id === data.session.id);
        if (exists) {
          return prev.map((s) => (s.id === data.session.id ? data.session : s));
        }
        return [data.session, ...prev];
      });
    }

    if (data.type === "session_renamed") {
      const renamed = (data as WsSessionRenamed).session;
      setSessions((prev) =>
        prev.map((s) => (s.id === renamed.id ? renamed : s))
      );
    }

    if (data.type === "doc_list") {
      setDocFiles(data.files);
    }

    if (data.type === "doc_content") {
      setDocContent(data.content);
    }

    if (data.type === "file_tree") {
      setFileTree(data.tree);
    }

    if (data.type === "file_content") {
      setViewingFileContent(data.content);
      setViewingFileBinary(data.isBinary ?? false);
    }

    if (data.type === "chat_history") {
      // Replace messages with the persisted history (loaded messages are never streaming)
      const loaded: ChatMessage[] = data.messages.map((m: WsChatHistoryMessage) => ({
        role: m.role,
        text: m.text,
        toolUse: m.toolUse,
        isError: m.isError,
        streaming: false,
      }));
      setMessages(loaded);
    }

    if (data.type === "log_entry") {
      setLogEntries((prev) => {
        const next = [...prev, { source: data.source, text: data.text, timestamp: data.timestamp }];
        // Cap at 500 entries on the client to avoid memory growth
        return next.length > 500 ? next.slice(-500) : next;
      });
      // Increment unread count when terminal tab is not active
      if (rightTab !== "terminal") {
        setUnreadLogCount((prev) => prev + 1);
      }
    }
  }, [lastMessage, send, rightTab, viewingFile, notify]);

  const handleSend = useCallback(
    (text: string) => {
      requestPermission();
      setMessages((prev) => [...prev, { role: "user", text }]);
      setIsLoading(true);
      setActivity({ label: "Thinking..." });
      send({
        type: "send_message",
        text,
        sessionId: sessionIdRef.current,
      });
    },
    [send, requestPermission]
  );

  const handleEditMessage = useCallback(
    (messageIndex: number, newText: string) => {
      requestPermission();
      // Truncate messages from the edited index onward, then append the new user message
      setMessages((prev) => [
        ...prev.slice(0, messageIndex),
        { role: "user" as const, text: newText },
      ]);
      setIsLoading(true);
      setActivity({ label: "Thinking..." });
      send({
        type: "send_message",
        text: newText,
        sessionId: sessionIdRef.current,
      });
    },
    [send, requestPermission]
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
      saveSessionId(sessionId);
      setMessages([]);
      setIsLoading(false);
      // Load persisted chat history for this session
      send({ type: "get_chat_history", sessionId });
    },
    [send]
  );

  const handleSessionNew = useCallback(() => {
    sessionIdRef.current = undefined;
    saveSessionId(undefined);
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

  const handleSessionRename = useCallback(
    (sessionId: string, title: string) => {
      send({ type: "rename_session", sessionId, title });
    },
    [send]
  );

  const handleDocRefresh = useCallback(() => {
    send({ type: "list_docs" });
  }, [send]);

  const handleSelectPort = useCallback((port: number) => {
    setSelectedPort(port);
  }, []);

  const handleFileTreeRefresh = useCallback(() => {
    send({ type: "get_file_tree" });
  }, [send]);

  const handleFileClick = useCallback(
    (filePath: string) => {
      setViewingFile(filePath);
      setViewingFileContent(null);
      setViewingFileBinary(false);
      send({ type: "get_file_content", path: filePath });
    },
    [send]
  );

  const handleFileViewerClose = useCallback(() => {
    setViewingFile(null);
    setViewingFileContent(null);
    setViewingFileBinary(false);
  }, []);

  const handleDocSelect = useCallback(
    (filePath: string) => {
      setSelectedDoc(filePath);
      setDocContent(null);
      send({ type: "get_doc", path: filePath });
    },
    [send]
  );

  const handleAnswerQuestion = useCallback(
    (toolUseId: string, answers: Record<string, string>) => {
      // Format the answer as readable text for the chat history
      const answerParts = Object.values(answers);
      const answerText = answerParts.join(", ");
      send({
        type: "answer_question",
        toolUseId,
        answers,
      });
      // Show the user's answer as a message in the chat
      setMessages((prev) => [...prev, { role: "user", text: answerText }]);
      setIsLoading(true);
      setActivity({ label: "Thinking..." });
    },
    [send]
  );

  const handleClearLogs = useCallback(() => {
    setLogEntries([]);
    send({ type: "clear_logs" });
  }, [send]);

  // Request data when switching to docs or files tab
  const handleTabChange = useCallback(
    (tab: RightTab) => {
      setRightTab(tab);
      if (tab === "docs" && docFiles.length === 0) {
        send({ type: "list_docs" });
      }
      if (tab === "files") {
        send({ type: "get_file_tree" });
      }
      if (tab === "terminal") {
        setUnreadLogCount(0);
      }
    },
    [send, docFiles.length]
  );

  // Shared right-panel content (Preview / Docs / Files with tab bar)
  const rightPanel = (
    <>
      {/* Tab bar */}
      <div className="flex border-b border-gray-700 bg-gray-900">
        <button
          onClick={() => handleTabChange("preview")}
          className={`px-4 py-2 text-sm font-medium transition-colors ${
            rightTab === "preview"
              ? "text-gray-100 border-b-2 border-blue-500"
              : "text-gray-500 hover:text-gray-300"
          }`}
        >
          Preview
        </button>
        <button
          onClick={() => handleTabChange("docs")}
          className={`px-4 py-2 text-sm font-medium transition-colors ${
            rightTab === "docs"
              ? "text-gray-100 border-b-2 border-blue-500"
              : "text-gray-500 hover:text-gray-300"
          }`}
        >
          Docs
        </button>
        <button
          onClick={() => handleTabChange("files")}
          className={`px-4 py-2 text-sm font-medium transition-colors ${
            rightTab === "files"
              ? "text-gray-100 border-b-2 border-blue-500"
              : "text-gray-500 hover:text-gray-300"
          }`}
        >
          Files
        </button>
        <button
          onClick={() => handleTabChange("terminal")}
          className={`px-4 py-2 text-sm font-medium transition-colors relative ${
            rightTab === "terminal"
              ? "text-gray-100 border-b-2 border-blue-500"
              : "text-gray-500 hover:text-gray-300"
          }`}
        >
          Terminal
          {unreadLogCount > 0 && rightTab !== "terminal" && (
            <span className="ml-1.5 inline-flex items-center justify-center min-w-[1.1rem] h-[1.1rem] px-1 text-[10px] font-semibold rounded-full bg-blue-600 text-white">
              {unreadLogCount > 99 ? "99+" : unreadLogCount}
            </span>
          )}
        </button>
      </div>

      {/* Tab content */}
      <div className="flex-1 min-h-0">
        {rightTab === "preview" ? (
          <PreviewFrame
            preview={preview}
            detectedPorts={detectedPorts}
            selectedPort={selectedPort}
            onSelectPort={handleSelectPort}
          />
        ) : rightTab === "docs" ? (
          <DocsViewer
            files={docFiles}
            selectedFile={selectedDoc}
            content={docContent}
            onSelectFile={handleDocSelect}
            onRefresh={handleDocRefresh}
          />
        ) : rightTab === "terminal" ? (
          <TerminalPanel
            entries={logEntries}
            onClear={handleClearLogs}
          />
        ) : viewingFile ? (
          <FileContentViewer
            filePath={viewingFile}
            content={viewingFileContent}
            isBinary={viewingFileBinary}
            onClose={handleFileViewerClose}
          />
        ) : (
          <FileTree
            tree={fileTree}
            onRefresh={handleFileTreeRefresh}
            onFileClick={handleFileClick}
            selectedFile={viewingFile}
          />
        )}
      </div>
    </>
  );

  // Shared chat panel content
  const chatPanel = (
    <>
      {searchOpen && (
        <SearchBar
          query={search.query}
          onQueryChange={search.setQuery}
          matches={search.matches}
          currentMatchIndex={search.currentMatchIndex}
          onNext={search.goToNext}
          onPrev={search.goToPrev}
          onClose={() => {
            setSearchOpen(false);
            search.clear();
          }}
        />
      )}
      <MessageList
        messages={messages}
        isLoading={isLoading}
        activity={activity}
        searchMatches={search.matches}
        currentMatch={search.currentMatch}
        onEditMessage={handleEditMessage}
        onAnswerQuestion={handleAnswerQuestion}
      />
      <GitHistory
        commits={gitCommits}
        onRollback={handleRollback}
        onRefresh={handleGitRefresh}
      />
      <MessageInput onSend={handleSend} disabled={isLoading || status !== "open"} activity={isLoading ? activity : undefined} />
    </>
  );

  return (
    <div className="flex flex-col h-screen bg-gray-950 text-gray-100">
      {authUrl && <AuthOverlay url={authUrl} />}
      {shortcutsOpen && <KeyboardShortcutsOverlay onClose={() => setShortcutsOpen(false)} />}

      {/* Header */}
      <header className="flex items-center justify-between px-4 sm:px-6 py-3 border-b border-gray-800">
        <div className="flex items-center gap-3 sm:gap-4 min-w-0">
          <h1 className="text-lg font-semibold tracking-tight shrink-0">ShipIt</h1>
          <SessionSelector
            sessions={sessions}
            currentSessionId={sessionIdRef.current}
            onResume={handleSessionResume}
            onNew={handleSessionNew}
            onDelete={handleSessionDelete}
            onRename={handleSessionRename}
            onRefresh={handleSessionRefresh}
          />
        </div>
        <div className="flex items-center gap-2 sm:gap-3 shrink-0">
          {preview?.running && (
            <span className={`hidden sm:inline text-xs px-2 py-0.5 rounded-full ${
              preview.source === "detected"
                ? "bg-yellow-900 text-yellow-300"
                : "bg-emerald-900 text-emerald-300"
            }`}>
              preview :{selectedPort ?? preview.port}
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

      <ConnectionBanner status={status} reconnectAttempt={reconnectAttempt} onReconnect={reconnect} />

      {isMobile ? (
        /* ── Mobile: single panel with bottom tab bar ── */
        <>
          <div className="flex flex-col flex-1 min-h-0">
            {mobilePanel === "chat" ? (
              <div className="flex flex-col flex-1 min-h-0">{chatPanel}</div>
            ) : (
              <div className="flex flex-col flex-1 min-h-0 bg-gray-900">{rightPanel}</div>
            )}
          </div>
          <MobileTabBar activePanel={mobilePanel} onChangePanel={setMobilePanel} />
        </>
      ) : (
        /* ── Desktop: side-by-side resizable layout ── */
        <div ref={containerRef} className="flex flex-1 min-h-0">
          {/* Left column — Chat */}
          <div
            className="flex flex-col min-w-0 border-r border-gray-800"
            style={{ width: `${fraction * 100}%` }}
          >
            {chatPanel}
          </div>

          {/* Drag handle */}
          <ResizeHandle isDragging={isDragging} onMouseDown={onMouseDown} onTouchStart={onTouchStart} />

          {/* Right column — Tabbed (Preview / Docs) */}
          <div
            className="min-w-0 flex flex-col bg-gray-900"
            style={{ width: `${(1 - fraction) * 100}%` }}
          >
            {rightPanel}
          </div>
        </div>
      )}
    </div>
  );
}
