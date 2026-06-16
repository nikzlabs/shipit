// eslint-disable-next-line no-restricted-imports -- useEffect: URL/route sync (browser navigation is external), session claim (AbortController cleanup)
import { useEffect, useRef, useCallback } from "react";
import type { NavigateFunction } from "react-router-dom";
import type { SessionInfo } from "../../server/shared/types.js";
import { useSessionStore } from "../stores/session-store.js";
import { useUiStore } from "../stores/ui-store.js";
import { useRepoStore } from "../stores/repo-store.js";
import { resumeSessionInternal, resetSessionState } from "../stores/actions/session-actions.js";
import { repoLabelToNewPath, shouldAdoptClaimedSession } from "../utils/repo-label.js";

/**
 * Session resume/claim/routing logic extracted from App: the four route-sync
 * effects (init-from-URL, URL↔store reconciliation, auto-claim on `/{slug}/new`,
 * redirect-home for an unknown slug) plus the new-session claim handlers.
 *
 * The effects are race-condition sensitive — their relative ordering and
 * dependency arrays are preserved exactly. `disableAutoFix` and `navigate` are
 * passed in so the hook reuses App's instances.
 */
export function useSessionActivation(params: {
  urlSessionId: string | undefined;
  sessionId: string | undefined;
  isNewSessionRoute: boolean;
  newSessionRepoSlug: string | undefined;
  newSessionRepoUrl: string | undefined;
  bootstrapLoaded: boolean;
  reposLength: number;
  disableAutoFix: () => void;
  navigate: NavigateFunction;
}): {
  handleNewSessionForRepo: (repoUrl: string) => Promise<void>;
  handleNewSessionShortcut: () => void;
  handleQuickSessionCreated: (session: SessionInfo) => void;
} {
  const {
    urlSessionId,
    sessionId,
    isNewSessionRoute,
    newSessionRepoSlug,
    newSessionRepoUrl,
    bootstrapLoaded,
    reposLength,
    disableAutoFix,
    navigate,
  } = params;

  const claimAbortRef = useRef<AbortController | null>(null);
  const previousNewSessionRouteRef = useRef<string | undefined>(undefined);

  // Initialize sessionId from URL on mount
  // eslint-disable-next-line no-restricted-syntax -- existing usage
  useEffect(() => {
    if (urlSessionId) {
      useSessionStore.getState().setSessionId(urlSessionId);
    }
    if (!urlSessionId && !isNewSessionRoute) {
      useUiStore.getState().setShowTemplates(true);
    }
  }, []);

  // Sync session state with the URL. Keep `sessionId` in the dependency list:
  // late async writers (claim-session/history paths) can update the store
  // after the route is already on a different session, and the URL must win.
  // WS auto-connects/disconnects via useSessionWebSocket(wsSessionId)
  // eslint-disable-next-line no-restricted-syntax -- existing usage
  useEffect(() => {
    const newSessionRouteKey = isNewSessionRoute ? newSessionRepoSlug : undefined;
    if (newSessionRouteKey && previousNewSessionRouteRef.current !== newSessionRouteKey) {
      previousNewSessionRouteRef.current = newSessionRouteKey;
      if (sessionId) {
        useSessionStore.getState().setSessionId(undefined);
        resetSessionState();
        disableAutoFix();
      }
      return;
    }
    if (!newSessionRouteKey) {
      previousNewSessionRouteRef.current = undefined;
    }

    if (urlSessionId && urlSessionId !== sessionId) {
      resumeSessionInternal(urlSessionId);
      disableAutoFix();
    } else if (!urlSessionId && !isNewSessionRoute && sessionId) {
      // Clear stale sessionId — prevents WS from connecting to old session.
      useSessionStore.getState().setSessionId(undefined);
      resetSessionState();
      disableAutoFix();
      useUiStore.getState().setShowTemplates(true);
    }
  }, [urlSessionId, sessionId, isNewSessionRoute, newSessionRepoSlug, disableAutoFix]);

  // Auto-claim session when landing on /{slug}/new (direct URL navigation or page refresh)
  // eslint-disable-next-line no-restricted-syntax -- existing usage
  useEffect(() => {
    if (!isNewSessionRoute || !newSessionRepoUrl || sessionId) return;
    const ac = new AbortController();
    void (async () => {
      const result = await useRepoStore.getState().claimSession(newSessionRepoUrl, ac.signal);
      if (result && !ac.signal.aborted) useSessionStore.getState().setSessionId(result.sessionId);
    })();
    return () => ac.abort();
  }, [isNewSessionRoute, newSessionRepoUrl, sessionId]);

  // Redirect to home if /{slug}/new doesn't match any known repo
  // eslint-disable-next-line no-restricted-syntax -- existing usage
  useEffect(() => {
    if (isNewSessionRoute && !newSessionRepoUrl && bootstrapLoaded && reposLength > 0) {
      void navigate("/", { replace: true });
    }
  }, [isNewSessionRoute, newSessionRepoUrl, bootstrapLoaded, reposLength, navigate]);

  const handleNewSessionForRepo = useCallback(
    async (repoUrl: string) => {
      // Abort any in-flight claim from a previous "New Session" click
      claimAbortRef.current?.abort();
      const ac = new AbortController();
      claimAbortRef.current = ac;

      // 1. Reset state for a fresh view
      useSessionStore.getState().setSessionId(undefined);
      resetSessionState();
      useUiStore.getState().setShowTemplates(false);
      // On mobile, a new session must land in the chat panel — otherwise the
      // session-list drawer (or the Workspace panel) stays in front of the
      // fresh session. No-op on desktop, where these states are unused.
      useUiStore.getState().setMobileSidebarOpen(false);
      useUiStore.getState().setMobilePanel("chat");

      // 2. Navigate instantly (before API call) — user sees /{owner}/{repo}/new
      void navigate(repoLabelToNewPath(repoUrl));

      // 3. Claim session in background — sets sessionId, triggers WS connect + preview
      const result = await useRepoStore.getState().claimSession(repoUrl, ac.signal);
      // Guard against a late-resolving claim clobbering the active session.
      // `ac` is only aborted by a *subsequent* "New Session" click — NOT by the
      // user navigating to an existing session (handleSessionResume) while the
      // claim is in flight. Without the URL check, a claim that resolves after
      // such a navigation would overwrite the store's sessionId with the
      // freshly-claimed warm session, and the user's next message would
      // graduate that warm session into a brand-new session instead of going
      // to the session they switched to. See shouldAdoptClaimedSession.
      if (
        shouldAdoptClaimedSession({
          claimed: !!result,
          aborted: ac.signal.aborted,
          currentPathname: window.location.pathname,
          repoUrl,
        })
      ) {
        useSessionStore.getState().setSessionId(result!.sessionId);
      }
    },
    [navigate],
  );

  // Keyboard shortcut: Cmd/Ctrl+Shift+O. Prefers the current session's repo,
  // then the active repo, then falls back to navigating home.
  const handleNewSessionShortcut = useCallback(() => {
    const session = useSessionStore.getState();
    const currentRepo = session.sessions.find((s) => s.id === session.sessionId)?.remoteUrl;
    const repo = currentRepo ?? useRepoStore.getState().activeRepoUrl;
    if (repo) {
      void handleNewSessionForRepo(repo);
    } else {
      void navigate("/");
    }
  }, [handleNewSessionForRepo, navigate]);

  // Quick-capture (the lightning / lightning+mic buttons) always spawns a
  // *background* session and does NOT navigate — docs/145. It leaves your
  // current `/{slug}/new` draft untouched: the headless claim sets
  // `skipReuse: true`, so the server always mints a fresh session and never
  // recycles the ungraduated draft you're typing in (that hijack-the-draft
  // bug is exactly what `skipReuse` fixes). The returned id therefore never
  // equals the session we're viewing, so the guard below is a defensive
  // no-op kept only against a future claim path that could reuse — if one
  // ever did, we'd graduate the URL to /session/{id} as a normal send does.
  const handleQuickSessionCreated = useCallback(
    (session: SessionInfo) => {
      if (isNewSessionRoute && session.id === useSessionStore.getState().sessionId) {
        void navigate(`/session/${session.id}`, { replace: true });
      }
    },
    [isNewSessionRoute, navigate],
  );

  return { handleNewSessionForRepo, handleNewSessionShortcut, handleQuickSessionCreated };
}
