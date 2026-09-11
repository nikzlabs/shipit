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
import { usePluginReposStore } from "../plugin-repos-store.js";
import type { AgentId, SessionInfo } from "../../../server/shared/types.js";

function sessionRepoUrl(sessionId?: string): string | null {
  const session = useSessionStore.getState();
  const id = sessionId ?? session.sessionId;
  if (!id) return useRepoStore.getState().activeRepoUrl ?? null;
  const found = session.sessions.find((s) => s.id === id);
  return found ? (found.remoteUrl ?? null) : `session:${id}`;
}

function scopeIssuesToSession(sessionId?: string) {
  useIssuesStore.getState().setRepoScope(sessionRepoUrl(sessionId));
}

export function resetSessionState() {
  useSessionStore.getState().reset();
  useGitStore.getState().reset();
  useFileStore.getState().reset();
  useTerminalStore.getState().reset();
  useLogStore.getState().reset();
  useUiStore.getState().reset();
  usePreviewStore.getState().reset();
  usePresentStore.getState().reset();

  usePluginReposStore.getState().reset();

  scopeIssuesToSession();
}

/**
 * docs/291-composer-before-claim — **give back a message the browser is still
 * holding, when the session it was typed for stops being the one we are on.**
 *
 * `sendUserMessage`'s callers stash a frame rather than dropping it when the socket
 * is not open yet — a message typed on `/{repo}/new` moments after the claim lands,
 * or one caught by a reconnect. `useConnectionSync` then flushes it *addressed from
 * the store*:
 *
 * ```ts
 * if (send({ ...pending, sessionId } as WsClientMessage)) …
 * ```
 *
 * So a stash the user has moved away from is not merely stranded — it is **sent
 * into whatever session the store holds by then**. That is why this exists and why
 * it is not simply `setPendingWsMessage(undefined)`: it undoes exactly what
 * `sendUserMessage` did — the bubble (matched on the `requestId` the stash carries),
 * the spinner, the stash itself — and says so, because a message that silently
 * evaporates is half of the failure it is here to prevent.
 *
 * A no-op when nothing is held, so callers do not have to check first.
 */
export function discardHeldFirstMessage(reason: string) {
  const session = useSessionStore.getState();
  const held = session.pendingWsMessage;
  if (!held) return;
  const requestId = held.requestId;
  session.setPendingWsMessage(undefined);
  session.setMessages((prev) => prev.filter((m) => m.clientRequestId !== requestId));
  session.setIsLoading(false);
  session.setActivity(undefined);
  useUiStore.getState().setToast({ message: reason });
}

export function resumeSessionInternal(sessionId: string) {

  const outgoingSessionId = useSessionStore.getState().sessionId;

  // so hydration re-runs. On a real switch that is safe because the new session

  if (outgoingSessionId === sessionId) return;

  discardHeldFirstMessage(
    "Your message wasn't sent — you switched sessions before it was ready.",
  );
  const preview = usePreviewStore.getState();
  if (outgoingSessionId) preview.snapshotSession(outgoingSessionId);

  const session = useSessionStore.getState();
  session.setSessionId(sessionId);
  session.setMessages([]);
  session.setIsLoading(false);
  session.setActivity(undefined);
  session.setQueuedMessages([]);
  session.setContainerFreshness(null);

  // because `setStatus("connecting")` is then a no-op and the effect never

  session.setHistoryLoaded(false);

  // its spinner into the incoming one (it's never persisted, so history reload

  session.setCompacting(false);

  useSessionStore.setState({ subAgentSpawns: {} });
  useUiStore.getState().setShowTemplates(false);

  useFileStore.getState().reset();
  useGitStore.getState().reset();
  useTerminalStore.getState().reset();
  useLogStore.getState().reset();
  useUiStore.getState().reset();
  usePresentStore.getState().reset();

  // so the incoming session never gates its tab (or warn dot) on them. The

  usePluginReposStore.getState().reset();

  scopeIssuesToSession(sessionId);

  preview.restoreSession(sessionId);

}

export function handleSessionResume(
  sessionId: string,
  navigate: (path: string) => void,
) {
  // Move the route first. App chrome is intentionally keyed to the URL so a
  // late async store write cannot visually hijack the session being viewed.

  navigate(`/session/${sessionId}`);
  resumeSessionInternal(sessionId);
}

export function fullResetAllStores() {
  useSessionStore.getState().reset();
  useGitStore.getState().reset();
  useFileStore.getState().reset();
  useTerminalStore.getState().reset();
  useLogStore.getState().reset();
  useUiStore.getState().reset();
  usePreviewStore.getState().reset();

  usePreviewStore.getState().clearPreviewPaths();

  usePreviewStore.getState().clearViewportMemory();

  usePreviewStore.getState().clearPreviewTargetMemory();
  usePresentStore.getState().reset();
  usePluginReposStore.getState().reset();
  usePrStore.getState().reset();
  useSettingsStore.getState().reset();
  useRepoStore.getState().reset();

  useIssuesStore.setState({ repoScope: null, trackers: [], infoByTracker: {} });
  useIssuesStore.getState().reset();
}

export async function createHeadlessSession(opts: {
  repoUrl: string;
  initialPrompt: string;
  agent?: AgentId;
  model?: string;

  reasoning?: string;

  role?: string;
  /**
   * docs/175 — arm auto-merge for the new session at creation time. Per-session
   * and never persisted (decision #1): the overlay does NOT remember it in
   * localStorage, unlike the model/agent pickers.
   */
  armAutoMerge?: boolean;
  /**
   * docs/285 reqs 2, 3 — the network mode picked in the overlay, in force from
   * this session's first turn. `true` = Contained, `false` = Open; omitted means
   * inherit the workspace setting, which is where every new session starts
   * (req 8). Like `armAutoMerge`, never persisted.
   */
  networkMode?: boolean;

  dictated?: boolean;

  files?: File[];
}): Promise<SessionInfo> {
  const { files, ...jsonBody } = opts;
  let res: Response;
  if (files && files.length > 0) {
    const form = new FormData();

    for (const [k, v] of Object.entries(jsonBody)) {
      if (v === undefined) continue;

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
