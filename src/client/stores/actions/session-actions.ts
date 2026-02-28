import { useSessionStore } from "../session-store.js";
import { useGitStore } from "../git-store.js";
import { useFileStore } from "../file-store.js";
import { useThreadStore } from "../thread-store.js";
import { useTerminalStore } from "../terminal-store.js";
import { useUiStore } from "../ui-store.js";
import { usePreviewStore } from "../preview-store.js";
import { useDeployStore } from "../deploy-store.js";
import { usePrStore } from "../pr-store.js";
import { useSettingsStore } from "../settings-store.js";
import { useRepoStore } from "../repo-store.js";
import type { WsClientMessage } from "../../../server/shared/types.js";
import type { ChatMessage } from "../../components/MessageList.js";
import type { GitCommit } from "../../components/GitHistory.js";
import type { FileTreeNode } from "../../components/FileTree.js";
import type { ThreadInfo } from "../../components/ThreadIndicator.js";

/**
 * Resets all session-specific state across all stores.
 * Replaces the three duplicated reset blocks in the old codebase.
 */
export function resetSessionState() {
  useSessionStore.getState().reset();
  useGitStore.getState().reset();
  useFileStore.getState().reset();
  useThreadStore.getState().reset();
  useTerminalStore.getState().reset();
  useUiStore.getState().reset();
  usePreviewStore.getState().reset();
}

/**
 * Internal session resume — resets state, fetches history via HTTP, activates via WS.
 * Used by popstate/URL changes and public resume.
 */
export function resumeSessionInternal(
  sessionId: string,
  send: (msg: WsClientMessage) => void,
) {
  const session = useSessionStore.getState();
  session.setSessionId(sessionId);
  session.setMessages([]);
  session.setIsLoading(false);
  session.setQueuedMessages([]);
  useUiStore.getState().setShowTemplates(false);

  // Reset session-specific UI state
  useFileStore.getState().reset();
  useGitStore.getState().reset();
  useThreadStore.getState().reset();
  useTerminalStore.getState().reset();
  useUiStore.getState().reset();

  // 1. Fetch session data via HTTP
  fetch(`/api/sessions/${sessionId}/history`)
    .then((res) => res.json())
    .then((data: {
      messages: Array<{ role: "user" | "assistant"; text: string; toolUse?: unknown[]; images?: unknown[]; files?: unknown[]; isError?: boolean }>;
      commits: GitCommit[];
      fileTree: FileTreeNode[];
      threads: ThreadInfo[];
      activeThreadId: string;
    }) => {
      useSessionStore.getState().setMessages(
        data.messages.map((m) => ({ ...m, streaming: false } as ChatMessage)),
      );
      useGitStore.getState().setCommits(data.commits);
      useFileStore.getState().setTree(data.fileTree);
      useThreadStore.getState().setThreads(data.threads);
      useThreadStore.getState().setActiveThreadId(data.activeThreadId);
    })
    .catch((err) => console.error("[api] Failed to load session history:", err));

  // 2. Activate session over WS
  send({ type: "activate_session", sessionId });
}

/**
 * Public session resume — also navigates to update the URL.
 */
export function handleSessionResume(
  sessionId: string,
  send: (msg: WsClientMessage) => void,
  navigate: (path: string) => void,
) {
  resumeSessionInternal(sessionId, send);
  navigate(`/session/${sessionId}`);
}

/**
 * Start a new session — resets state, navigates to /, sends new_session WS.
 */
export function newSession(
  send: (msg: WsClientMessage) => void,
  navigate: (path: string) => void,
) {
  useSessionStore.getState().setSessionId(undefined);
  resetSessionState();
  useUiStore.getState().setShowTemplates(true);
  navigate("/");
  send({ type: "new_session" });
}

/**
 * Full reset of all stores (used when the server broadcasts full_reset_complete).
 */
export function fullResetAllStores() {
  useSessionStore.getState().reset();
  useGitStore.getState().reset();
  useFileStore.getState().reset();
  useThreadStore.getState().reset();
  useTerminalStore.getState().reset();
  useUiStore.getState().reset();
  usePreviewStore.getState().reset();
  useDeployStore.getState().reset();
  usePrStore.getState().reset();
  useSettingsStore.getState().reset();
  useRepoStore.getState().reset();
}
