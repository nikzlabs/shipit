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
  handleNewSessionForRepo: (repoUrl: string, opts?: { preserveMobileView?: boolean }) => Promise<void>;
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

  // eslint-disable-next-line no-restricted-syntax -- existing usage; mount-only, see above
  useEffect(() => {
    if (urlSessionId) {
      useSessionStore.getState().setSessionId(urlSessionId);
    }
    if (!urlSessionId && !isNewSessionRoute) {
      useUiStore.getState().setShowTemplates(true);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only by design — the URL->store sync for later changes is the separate effect below (see above)
  }, []);

  // after the route is already on a different session, and the URL must win.

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

      useSessionStore.getState().setSessionId(undefined);
      resetSessionState();
      disableAutoFix();
      useUiStore.getState().setShowTemplates(true);
    }
  }, [urlSessionId, sessionId, isNewSessionRoute, newSessionRepoSlug, disableAutoFix]);

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

  // eslint-disable-next-line no-restricted-syntax -- existing usage
  useEffect(() => {
    if (isNewSessionRoute && !newSessionRepoUrl && bootstrapLoaded && reposLength > 0) {
      void navigate("/", { replace: true });
    }
  }, [isNewSessionRoute, newSessionRepoUrl, bootstrapLoaded, reposLength, navigate]);

  const handleNewSessionForRepo = useCallback(
    async (repoUrl: string, opts?: { preserveMobileView?: boolean }) => {

      claimAbortRef.current?.abort();
      const ac = new AbortController();
      claimAbortRef.current = ac;

      useSessionStore.getState().setSessionId(undefined);
      resetSessionState();
      useUiStore.getState().setShowTemplates(false);
      // On mobile, a new session must land in the chat panel — otherwise the

      if (!opts?.preserveMobileView) {
        useUiStore.getState().setMobileSidebarOpen(false);
        useUiStore.getState().setMobilePanel("chat");
      }

      void navigate(repoLabelToNewPath(repoUrl));

      const result = await useRepoStore.getState().claimSession(repoUrl, ac.signal);

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

  // `skipReuse: true`, so the server always mints a fresh session and never

  // bug is exactly what `skipReuse` fixes). The returned id therefore never

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
