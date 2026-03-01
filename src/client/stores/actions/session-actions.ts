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
 * Internal session resume — resets state, fetches history via HTTP.
 * WS connects automatically via the per-session WS URL; no activate_session needed.
 */
export function resumeSessionInternal(sessionId: string) {
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
  usePreviewStore.getState().reset();

  // Fetch session data via HTTP
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
}

/**
 * Public session resume — also navigates to update the URL.
 * WS connects automatically when React re-renders with the new session ID.
 */
export function handleSessionResume(
  sessionId: string,
  navigate: (path: string) => void,
) {
  resumeSessionInternal(sessionId);
  navigate(`/session/${sessionId}`);
}

/**
 * Start a new session — resets state and navigates to /.
 * No WS message needed; the WS disconnects when leaving a session URL.
 */
export function newSession(
  navigate: (path: string) => void,
) {
  useSessionStore.getState().setSessionId(undefined);
  resetSessionState();
  useUiStore.getState().setShowTemplates(true);
  navigate("/");
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
