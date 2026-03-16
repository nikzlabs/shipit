import { useSessionStore } from "../session-store.js";
import { useGitStore } from "../git-store.js";
import { useFileStore } from "../file-store.js";
import { useTerminalStore } from "../terminal-store.js";
import { useUiStore } from "../ui-store.js";
import { usePreviewStore } from "../preview-store.js";
import { useDeployStore } from "../deploy-store.js";
import { usePrStore } from "../pr-store.js";
import { useSettingsStore } from "../settings-store.js";
import { useRepoStore } from "../repo-store.js";
/**
 * Resets all session-specific state across all stores.
 * Replaces the three duplicated reset blocks in the old codebase.
 */
export function resetSessionState() {
  useSessionStore.getState().reset();
  useGitStore.getState().reset();
  useFileStore.getState().reset();
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
  session.clearUnseen(sessionId);
  session.setMessages([]);
  session.setIsLoading(false);
  session.setActivity(undefined);
  session.setQueuedMessages([]);
  useUiStore.getState().setShowTemplates(false);

  // Reset session-specific UI state
  useFileStore.getState().reset();
  useGitStore.getState().reset();
  useTerminalStore.getState().reset();
  useUiStore.getState().reset();
  usePreviewStore.getState().reset();

  // Session data is loaded via HTTP by useConnectionSync when the per-session WS connects.
  // Don't load here — it races with the WS connection and causes double-loading.
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
 * Full reset of all stores (used when the server broadcasts full_reset_complete).
 */
export function fullResetAllStores() {
  useSessionStore.getState().reset();
  useGitStore.getState().reset();
  useFileStore.getState().reset();
  useTerminalStore.getState().reset();
  useUiStore.getState().reset();
  usePreviewStore.getState().reset();
  useDeployStore.getState().reset();
  usePrStore.getState().reset();
  useSettingsStore.getState().reset();
  useRepoStore.getState().reset();
}
