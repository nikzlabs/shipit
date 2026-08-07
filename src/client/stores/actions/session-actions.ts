import { useSessionStore } from "../session-store.js";
import { useGitStore } from "../git-store.js";
import { useFileStore } from "../file-store.js";
import { useTerminalStore } from "../terminal-store.js";
import { useLogStore } from "../log-store.js";
import { useUiStore } from "../ui-store.js";
import { usePreviewStore } from "../preview-store.js";
import { usePresentStore } from "../present-store.js";
import { usePrStore } from "../pr-store.js";
import { useSettingsStore } from "../settings-store.js";
import { useRepoStore } from "../repo-store.js";
import { useIssuesStore } from "../issues-store.js";
import type { AgentId, SessionInfo } from "../../../server/shared/types.js";

/**
 * The repository a session belongs to, as the Issues tab sees it: the session's
 * own remote. With no session at all (the `/{slug}/new` route) it's the
 * sidebar's active repo — the same fallback `IssuesPanel` uses to decide which
 * repo to offer starting a session on, so the tab is scoped to what it targets.
 *
 * A session the list doesn't know yet (a direct URL landing before the session
 * list loads) gets a per-session sentinel rather than that fallback: the honest
 * answer is "unknown", and the sidebar's active repo is only a guess, which
 * would keep an issue open across a repo change (observed with warm sessions,
 * which aren't in the list). A sentinel differs from every other scope, so an
 * unknown session always re-scopes — fail closed, per docs/248 req 11.
 */
function sessionRepoUrl(sessionId?: string): string | null {
  const session = useSessionStore.getState();
  const id = sessionId ?? session.sessionId;
  if (!id) return useRepoStore.getState().activeRepoUrl ?? null;
  const found = session.sessions.find((s) => s.id === id);
  return found ? (found.remoteUrl ?? null) : `session:${id}`;
}

/**
 * planning#327 — re-scope the Issues tab to the repository we're moving to. Issue
 * trackers are declared per repository (`shipit.yaml`, docs/248), so an open
 * issue and the loaded lists belong to the repository they were opened from;
 * carrying them into a repository that doesn't declare that tracker leaves an
 * unreachable destination on screen, which req 11 forbids. No-ops when the
 * repository is unchanged, so switching between two sessions of one repository
 * leaves the open issue alone. `fetchTrackers` (fired on the session change by
 * `App`) then applies the authoritative check against the new declarations.
 */
function scopeIssuesToSession(sessionId?: string) {
  useIssuesStore.getState().setRepoScope(sessionRepoUrl(sessionId));
}

/**
 * Resets all session-specific state across all stores.
 * Replaces the three duplicated reset blocks in the old codebase.
 */
export function resetSessionState() {
  useSessionStore.getState().reset();
  useGitStore.getState().reset();
  useFileStore.getState().reset();
  useTerminalStore.getState().reset();
  useLogStore.getState().reset();
  useUiStore.getState().reset();
  usePreviewStore.getState().reset();
  usePresentStore.getState().reset();
  // Not an unconditional reset: the issues store is repo-scoped, not
  // session-scoped, and only drops its contents when the repo actually changes.
  scopeIssuesToSession();
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
  session.setContainerFreshness(null);
  // docs/178 — the "Compacting…" spinner is a global, transient flag. Clear it
  // on switch so a compaction in flight on the outgoing session doesn't bleed
  // its spinner into the incoming one (it's never persisted, so history reload
  // won't bring it back).
  session.setCompacting(false);
  // docs/144 — sub-agent spawn chips are transient + per-session; clear on switch.
  useSessionStore.setState({ subAgentSpawns: {} });
  useUiStore.getState().setShowTemplates(false);

  // Reset session-specific UI state
  useFileStore.getState().reset();
  useGitStore.getState().reset();
  useTerminalStore.getState().reset();
  useLogStore.getState().reset();
  useUiStore.getState().reset();
  usePresentStore.getState().reset();
  // Repo-scoped, not session-scoped (planning#327): clears only when the incoming
  // session belongs to a different repository than the outgoing one.
  scopeIssuesToSession(sessionId);

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
  // Move the route first. App chrome is intentionally keyed to the URL so a
  // late async store write cannot visually hijack the session being viewed.
  // Updating the store first creates a transient split render: the selected
  // session is new while the URL (and therefore the top chrome) still points
  // at the previous session. This was visible when entering a Sandbox as the
  // previous session's title bar flashing before the Sandbox banner.
  navigate(`/session/${sessionId}`);
  resumeSessionInternal(sessionId);
}

/**
 * Full reset of all stores (used when the server broadcasts full_reset_complete).
 */
export function fullResetAllStores() {
  useSessionStore.getState().reset();
  useGitStore.getState().reset();
  useFileStore.getState().reset();
  useTerminalStore.getState().reset();
  useLogStore.getState().reset();
  useUiStore.getState().reset();
  usePreviewStore.getState().reset();
  usePresentStore.getState().reset();
  usePrStore.getState().reset();
  useSettingsStore.getState().reset();
  useRepoStore.getState().reset();
  // Every repo is gone, so nothing declares a tracker any more.
  useIssuesStore.setState({ repoScope: null, trackers: [], infoByTracker: {} });
  useIssuesStore.getState().reset();
}

export async function createHeadlessSession(opts: {
  repoUrl: string;
  initialPrompt: string;
  branch?: string;
  agent?: AgentId;
  model?: string;
  /**
   * docs/217 — per-session reasoning effort (Control B) for the new session's
   * first turn. Unlike the WS `?reasoning=` connect param (which only reaches
   * WS-driven turns), this rides the creation request so the server-dispatched
   * first turn runs with it. Persistence to localStorage stays in the picker.
   */
  reasoning?: string;
  /**
   * docs/175 — arm auto-merge for the new session at creation time. Per-session
   * and never persisted (decision #1): the overlay does NOT remember it in
   * localStorage, unlike the model/agent pickers.
   */
  armAutoMerge?: boolean;
  /**
   * docs/144 — the prompt was dictated by voice. The server folds a
   * `<dictated_input>` note into the first turn's prompt so the agent reads
   * mis-heard terms and missing punctuation as transcription artifacts. Rides
   * the JSON body, or the multipart form as the string "true".
   */
  dictated?: boolean;
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
      // Booleans (armAutoMerge) and any non-string field are stringified; the
      // multipart route reads each part's value as a string and parses it.
      form.append(k, typeof v === "string" ? v : String(v));
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

/**
 * docs/205 — optimistic quick-session start. Called fire-and-forget from the
 * (synchronous) quick-capture submit *after* the overlay has closed, so the user
 * isn't blocked behind a modal spinner during the boot. Success is silent — the
 * new session appears in the sidebar via `createHeadlessSession`'s store update
 * (and the `session_list` SSE broadcast); `onCreated` lets the /{repo}/new route
 * graduate its URL. A failure surfaces as an error toast since the overlay is
 * gone. Living here (not in the component) means it survives the overlay unmount.
 */
export function startQuickSessionInBackground(
  opts: Parameters<typeof createHeadlessSession>[0],
  onCreated?: (session: SessionInfo) => void,
): void {
  void (async () => {
    try {
      const created = await createHeadlessSession(opts);
      onCreated?.(created);
    } catch (err) {
      useUiStore.getState().setToast({
        message: err instanceof Error ? err.message : "Couldn't start session — try again",
        variant: "error",
      });
    }
  })();
}
