import { useSessionStore } from "../session-store.js";
import { useGitStore } from "../git-store.js";
import { useFileStore } from "../file-store.js";
import { useTerminalStore } from "../terminal-store.js";
import { useUiStore } from "../ui-store.js";
import { usePreviewStore } from "../preview-store.js";
import { usePresentStore } from "../present-store.js";
import { usePrStore } from "../pr-store.js";
import { useSettingsStore } from "../settings-store.js";
import { useRepoStore } from "../repo-store.js";
import type { AgentId, SessionInfo } from "../../../server/shared/types.js";
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
  usePresentStore.getState().reset();
}

/**
 * Internal session resume — resets state, fetches history via HTTP.
 * WS connects automatically via the per-session WS URL; no activate_session needed.
 */
export function resumeSessionInternal(sessionId: string) {
  // Snapshot outgoing session's preview state before switching
  const outgoingSessionId = useSessionStore.getState().sessionId;
  const preview = usePreviewStore.getState();
  if (outgoingSessionId) preview.snapshotSession(outgoingSessionId);

  const session = useSessionStore.getState();
  session.setSessionId(sessionId);
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
  usePresentStore.getState().reset();

  // Restore incoming session's preview state (or reset to defaults)
  preview.restoreSession(sessionId);

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
  usePresentStore.getState().reset();
  usePrStore.getState().reset();
  useSettingsStore.getState().reset();
  useRepoStore.getState().reset();
}

export async function createHeadlessSession(opts: {
  repoUrl: string;
  initialPrompt: string;
  branch?: string;
  agent?: AgentId;
  model?: string;
  /**
   * Raw files to attach to the new session. When present we POST as
   * multipart/form-data so the orchestrator can save them into the new
   * session's uploads dir before dispatching the prompt; otherwise we keep
   * the simpler JSON path. See `docs/145-quick-capture-overlay/plan.md`.
   */
  files?: File[];
}): Promise<SessionInfo> {
  const { files, ...jsonBody } = opts;
  let res: Response;
  if (files && files.length > 0) {
    const form = new FormData();
    // All current jsonBody fields are strings (or undefined). The multipart
    // route reads each part's `value` as a string and parses agent/branch/etc.
    // itself, so we just pass values through without coercion.
    for (const [k, v] of Object.entries(jsonBody)) {
      if (v === undefined) continue;
      form.append(k, v);
    }
    for (const f of files) {
      form.append("file", f, f.name);
    }
    res = await fetch("/api/sessions/headless", {
      method: "POST",
      headers: { Accept: "application/json" },
      body: form,
    });
  } else {
    res = await fetch("/api/sessions/headless", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(jsonBody),
    });
  }
  const body = await res.json().catch(() => ({})) as { error?: string; session?: SessionInfo };
  if (!res.ok || !body.session) {
    throw new Error(body.error ?? `Failed to start quick session (${res.status})`);
  }
  useSessionStore.getState().setSessions((sessions) => {
    const without = sessions.filter((s) => s.id !== body.session!.id);
    return [body.session!, ...without];
  });
  return body.session;
}
