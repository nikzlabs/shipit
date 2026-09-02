// eslint-disable-next-line no-restricted-imports -- useEffect: auth-blocked detection + iframe refresh (external system sync)
import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { useEventListener } from "../../hooks/useEventListener.js";
import { WarningIcon, CircleNotchIcon, ArrowClockwiseIcon, ArrowSquareOutIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../../design-tokens.js";
import { Button } from "../ui/button.js";
import type { PreviewError } from "../../hooks/usePreviewErrors.js";
import { usePreviewStore } from "../../stores/preview-store.js";
import { resolvePointerNavigation } from "../../utils/preview-link-navigation.js";
import { useUiStore } from "../../stores/ui-store.js";
import { resolvePreviewHost, suggestWildcardHost } from "../../utils/preview-host.js";
import { StartupSteps } from "../StartupSteps.js";
import { useIframePool } from "../../hooks/useIframePool.js";
import { useReleaseStoppedPreviews } from "../../hooks/usePreviewsStopped.js";
import { usePreviewSlot, buildSubdomainUrl } from "../../hooks/usePreviewSlot.js";
import { useDeviceFrame } from "./DeviceFrame.js";
import { ViewportResizeHandles } from "./ViewportResizeHandles.js";
import { CUSTOM_SIZE_MIN, CUSTOM_SIZE_MAX } from "../device-presets.js";
import { PreviewToolbar, type PortInfo } from "./PreviewToolbar.js";
import { PreviewErrors } from "./PreviewErrors.js";
import { ComposeErrorBanner } from "./ComposeErrorBanner.js";
import { PreviewSetupInvite } from "./PreviewSetupInvite.js";
import { SecretsMissingBanner } from "./SecretsMissingBanner.js";
import { handleAgentInterfaceRequest } from "../../agent-interface-sdk/handle-request.js";
import type { AgentInterfaceProvenance } from "../../../server/shared/agent-interface-sdk/protocol.js";

export interface PreviewStatus {
  running: boolean;
  port: number;
  url: string;
  /** "vite" for bundled Vite server, "managed" for command mode, "detected" for auto-detected ports. */
  source?: "vite" | "managed" | "detected";
  /** All ports found by port scanning (non-Vite dev servers). */
  detectedPorts?: number[];
  /** Non-null when the preview server crashed. Contains the process exit code. */
  exitCode?: number | null;
  /** Last lines of preview output captured before the crash. */
  errorOutput?: string;
}

const READY_BUFFER_LIMIT = 8;
const READY_BUFFER_TTL_MS = 2_000;

function previewOrigin(url: string): string | null {
  try {
    return new URL(url, window.location.href).origin;
  } catch {
    return null;
  }
}

interface PreviewFrameProps {
  preview: PreviewStatus | null;
  /** Current session ID — part of the iframe-pool slot key (`sessionId:port`). */
  sessionId?: string;
  /** All detected ports available for selection. */
  detectedPorts: number[];
  /** The currently selected port override, or null to use the default. */
  selectedPort: number | null;
  /** Called when the user selects a different port. */
  onSelectPort: (port: number) => void;
  /** Captured preview errors from the iframe. */
  errors: PreviewError[];
  /** Called when user clicks "Send to Agent" to fix errors. */
  onSendErrors: (errors: PreviewError[]) => void;
  /** Called to clear all errors. */
  onClearErrors: () => void;
  /** Called when user clicks "Send to agent" to send error info to the agent. */
  onSendCrashToAgent?: () => void;
  /** Called when the user asks the agent to set a preview up for this repo. */
  onSendComposeHintToAgent?: () => void;
  onAgentInterfaceMessage?: (text: string, provenance: AgentInterfaceProvenance) => Promise<void>;
  /**
   * Whether this pane is actually ON SCREEN, as opposed to merely mounted.
   *
   * The pane is deliberately kept mounted behind the other right-panel tabs and
   * behind the mobile Chat tab, so returning to it is instant. But a preview
   * that is not on screen must stop rendering AND be told it is hidden, or it
   * keeps a WebGL canvas drawing and its audio playing behind the Files tree
   * (nikzlabs/shipit#2418, second site). `PreviewFrame` cannot work this out for
   * itself: the class that hides it is applied by an ancestor, and
   * `visibility: hidden` is invisible to geometry — an `IntersectionObserver`
   * on the iframe reports it as intersecting.
   *
   * Defaults to `true` so the signal can only ever *remove* visibility: a caller
   * that does not pass it gets exactly the previous behavior.
   */
  paneVisible?: boolean;
}

export function PreviewFrame({
  preview,
  sessionId,
  detectedPorts,
  selectedPort,
  onSelectPort,
  errors,
  onSendErrors,
  onClearErrors,
  onSendCrashToAgent,
  onSendComposeHintToAgent,
  onAgentInterfaceMessage,
  paneVisible = true,
}: PreviewFrameProps) {
  const autoFixEnabled = usePreviewStore((s) => s.autoFixEnabled);
  const [refreshKey, setRefreshKey] = useState(0);
  // Current path per slot, as reported by each page's injected script. Kept per
  // slot so switching sessions shows that preview's own route rather than the
  // last one seen anywhere, and held in the store rather than in component
  // state so it also survives this component unmounting — a slot recreated
  // later re-enters at the same path instead of the front page.
  const slotPaths = usePreviewStore((s) => s.previewPaths);
  // Whether each slot's preview has a history entry of its own, as reported by
  // the injected script. Deliberately component state and NOT in the store
  // beside `previewPaths`: a path is a destination worth restoring, but this
  // describes the live frame's history. A remount recreates the iframe with no
  // history at all, so a persisted `true` would enable a Back button that has
  // nowhere to go. Starting empty ("unknown") is the honest state, and the
  // first report from the page corrects it.
  const [slotCanGoBack, setSlotCanGoBack] = useState<Map<string, boolean>>(new Map());
  const [errorPanelOpen, setErrorPanelOpen] = useState(false);
  const [portSelectorOpen, setPortSelectorOpen] = useState(false);

  // ---- Device frame measurement ----
  // When a preset is active, we resize the iframe to the preset width/height
  // and scale it down with `transform: scale()` if it doesn't fit the panel.
  const {
    deviceContainerRef,
    deviceFrameActive,
    deviceWidth,
    deviceHeight,
    deviceScale,
    deviceScalePercent,
    availableWidth,
    availableHeight,
  } = useDeviceFrame();

  // What the Freeform menu row activates on first use: the panel itself, so
  // the drag handles appear around what the user was already looking at
  // (docs/278). Null while the container is unmeasured.
  const freeformPanelSize = availableWidth > 0 && availableHeight > 0
    ? {
      width: Math.min(Math.max(Math.round(availableWidth), CUSTOM_SIZE_MIN), CUSTOM_SIZE_MAX),
      height: Math.min(Math.max(Math.round(availableHeight), CUSTOM_SIZE_MIN), CUSTOM_SIZE_MAX),
    }
    : null;

  // Compute active port early so hooks can reference it (0 when not running).
  //
  // A retained `selectedPort` outranks "nothing is running" (planning#478). The
  // commonest restart of all is the one where the parked service is the ONLY
  // preview service: everything is then down, and discarding the port here
  // would lose the very identity the pane needs to say what it is waiting for —
  // the user would get the generic "No preview running" instead of "api is not
  // running", for exactly the case this feature exists to handle.
  const activePort = preview?.running ? (selectedPort ?? preview.port) : (selectedPort ?? 0);

  // Host + protocol for container-mode subdomain URLs (e.g. "localhost:3001").
  // On a Tailscale MagicDNS deploy this routes previews through the sslip host
  // over http: while the app/WS stay on the native .ts.net host (docs/216).
  const tailnetPreviewHost = useUiStore((s) => s.tailnetPreviewHost);
  const { host: apiHost, protocol: apiProtocol } = resolvePreviewHost(window.location.host, tailnetPreviewHost);

  // ---- Iframe pool: one iframe per (session, port) ----
  // Slots are keyed by "sessionId:port". Only the active slot is visible.
  // Background slots keep their iframes alive in the DOM. See `useIframePool`
  // for LRU eviction and `usePreviewSlot` for slot creation.
  const { slots, slotOrder, iframeRefs, createdSlotsRef, promoteSlot, setSlot, dropSlot, dropSessionSlots, getSlot } = useIframePool();

  // planning#496 — a session's previews stopped, so the iframes this pool holds
  // for it are renderer processes kept for a document whose containers are gone.
  // Release them; a later visit recreates the slot at its remembered path. The
  // active session is never touched — see the hook.
  //
  // `slotCanGoBack` is component state keyed by slot, so it has to be forgotten
  // alongside the slot: a rebuilt iframe has no history of its own, and a
  // retained `true` would offer a Back button with nowhere to go — the same
  // reason this is not persisted with `previewPaths` in the first place.
  const releaseStoppedSession = useCallback((stoppedSessionId: string) => {
    const dropped = dropSessionSlots(stoppedSessionId);
    if (dropped.length > 0) {
      setSlotCanGoBack((prev) => {
        const next = new Map(prev);
        for (const key of dropped) next.delete(key);
        return next;
      });
    }
    return dropped;
  }, [dropSessionSlots]);
  useReleaseStoppedPreviews(sessionId, releaseStoppedSession);

  const activeSlotKey = activePort ? `${sessionId ?? "_"}:${activePort}` : null;
  const activeSlot = activeSlotKey ? slots.get(activeSlotKey) ?? null : null;

  // Container mode detection for the current preview
  const isContainerMode = !!(preview?.url?.startsWith("/preview/"));

  // The service that owns the active port. Same derivation as the toolbar
  // label below, so the slot's recorded owner and the row the user sees can't
  // disagree. The health poller compares it with a retained slot's recorded
  // owner and drops the slot when the port changed hands (planning#394).
  const services = usePreviewStore((s) => s.services);
  /**
   * The service this session's pane is parked on, by NAME — the same identity
   * the store resolves `selectedPort` from. Resolving the row by port alone
   * would disagree with it: ShipIt warns about two project services declaring
   * the same port but permits it, and `find` then returns whichever is listed
   * first. That is how the pane could sit forever saying "A is not running"
   * while the remembered B served that very port.
   */
  const targetServiceName = usePreviewStore((s) => (sessionId ? s.previewTargetMemory[sessionId]?.service : undefined));
  const activeServiceState = activePort
    ? (targetServiceName
      ? services.find((s) => s.name === targetServiceName && s.port === activePort)
      : undefined) ?? services.find((s) => s.port === activePort)
    : undefined;
  const activeService = activeServiceState?.name;

  /**
   * The pane is parked on a Compose service that is not up right now
   * (planning#478). The session's target is remembered by service name and the
   * pane holds it through a restart, a stopped service and a reclaimed
   * container, so this is the state where it waits instead of showing whatever
   * else happens to be running.
   *
   * Keyed on the remembered NAME, not on finding a row: during the gap before
   * `service_list` lands there is no row at all, and reading that as "not
   * waiting" would let the poller probe a dead port and drop a slot behind the
   * overlay. A preview no service owns (Vite) has no name and is never this.
   */
  const waitingForService = !!activePort && !!targetServiceName && activeServiceState?.status !== "running";

  // Create/update the active slot when session/port changes.
  usePreviewSlot({
    activeSlotKey,
    activePort,
    sessionId,
    preview,
    apiHost,
    apiProtocol,
    createdSlotsRef,
    promoteSlot,
    setSlot,
    getSlot,
    dropSlot,
    activeService,
    waitingForService,
  });

  // Derive active slot state for overlay/UI logic
  const activeSlotUrl = activeSlot?.url ?? null;
  const activePath = activeSlotKey ? slotPaths[activeSlotKey] ?? null : null;
  const activeCanGoBack = activeSlotKey ? slotCanGoBack.get(activeSlotKey) : undefined;
  // Resolve against the slot URL to recover the absolute URL for click-to-copy.
  // `activePath` is untrusted and `sanitizePreviewPath` has already rejected
  // everything that could escape the origin — but this value goes to the user's
  // clipboard, so re-check the resolved origin here rather than inheriting that
  // guarantee. A mismatch means the sanitizer missed something; show no URL.
  const activeFullUrl = useMemo(() => {
    if (!activePath || !activeSlotUrl) return null;
    try {
      const resolved = new URL(activePath, activeSlotUrl);
      return resolved.origin === new URL(activeSlotUrl).origin ? resolved.href : null;
    } catch {
      return null;
    }
  }, [activePath, activeSlotUrl]);
  const showIframe = slotOrder.length > 0;
  const activeSlotReady = !!activeSlot;
  const isTransitioning = !activeSlotReady && activePort > 0 && preview?.running && showIframe;

  // --- Auth-blocked detection ---
  // The injected script (see preview-proxy.ts HMR_WS_PATCH) posts a "loaded"
  // message when the iframe finishes parsing the response HTML. If no message
  // arrives within MAX_AUTH_TIMEOUT_MS, we suspect the preview is auth-gated
  // (e.g. Cloudflare Zero Trust). When the timer expires with no "loaded"
  // signal, the effect silently bumps refreshKey to force-reload the iframe
  // a couple of times before surfacing the overlay — most false positives
  // clear on a single retry.
  //
  // Per-slot tracking note: `loadedSlotsRef` records which iframe-pool slots
  // have already sent a successful "loaded" postMessage. Without this, the
  // detection mis-fires when the user switches back to a previously visited
  // session: the cached iframe doesn't re-fetch (its `src` is unchanged and
  // visibility-toggling doesn't trigger a reload), so no fresh postMessage
  // arrives, the timer expires, and the iframe gets force-reloaded — losing
  // all in-iframe state (scroll, form inputs, SPA route). Keying loaded
  // state per slot lets us skip the timer for slots we've already confirmed
  // came up cleanly.
  //
  // A confirmed load is not the only way a slot stops being a fresh fetch,
  // though. The timer's whole premise is "we just requested this URL and heard
  // nothing back" — on a revisit there was no request, so an expiry carries no
  // signal at all. `authSettledRef` therefore records the verdict for a slot
  // whose detection already ran to a conclusion, so returning to a preview that
  // never reported "loaded" (non-HTML root, failed injection, a 502 served
  // during startup) re-shows that verdict instead of force-reloading the cached
  // iframe again. Both are cleared by a manual refresh, which IS a fresh fetch.
  const [authBlockedSlots, setAuthBlockedSlots] = useState<ReadonlySet<string>>(() => new Set());
  const authSettledRef = useRef<Map<string, string>>(new Map());
  const markAuthBlocked = (key: string, blocked: boolean) =>
    setAuthBlockedSlots((prev) => {
      if (prev.has(key) === blocked) return prev;
      const next = new Set(prev);
      if (blocked) next.add(key);
      else next.delete(key);
      return next;
    });
  const loadedSlotsRef = useRef<Set<string>>(new Set());
  // Windows that have reported "loaded", i.e. the injected preview script is
  // running there and will honour a "shipit-toolbar" command. Unlike
  // `loadedSlotsRef` this is NOT cleared on refresh — it records a capability,
  // not the state of the current load. Keyed by slot but storing the window so
  // a remounted iframe (new element, new contentWindow, script not yet run)
  // doesn't inherit the old element's confirmation.
  const reloadableWindowsRef = useRef<Map<string, MessageEventSource>>(new Map());
  const pendingReadyRef = useRef<{ source: MessageEventSource; origin: string; receivedAt: number }[]>([]);
  const authRetryRef = useRef(0);
  const lastAuthUrlRef = useRef<string | null>(null);
  // Mirror `activeSlotKey` into a ref so the postMessage listener (registered
  // once on mount) can read the current active slot without re-subscribing.
  const activeSlotKeyRef = useRef<string | null>(activeSlotKey);
  activeSlotKeyRef.current = activeSlotKey;
  /**
   * Auth-detection state is keyed by slot key AND generation, never by the key
   * alone. A slot rebuilt after an ownership takeover (planning#394) reuses the
   * key and mounts a *different* iframe loading a *different* app, so the
   * previous owner's "loaded" confirmation or "blocked" verdict says nothing
   * about it — inherited, they skip detection for a frame that never reported,
   * or leave a stale overlay over a working one.
   */
  const slotGenerationsRef = useRef<Map<string, number>>(new Map());
  slotGenerationsRef.current = new Map(
    [...slots].map(([k, s]) => [k, s.generation ?? 0] as const),
  );
  const authKey = (key: string) => `${key}#${slotGenerationsRef.current.get(key) ?? 0}`;
  const MAX_AUTH_TIMEOUT_MS = 5000;
  const MAX_AUTH_RETRIES = 2;
  const authBlocked = !!activeSlotKey && authBlockedSlots.has(activeSlotKey);

  /**
   * Which pool slot a postMessage came from. We can't trust the message
   * contents for this — the injected script doesn't know the slot key — so
   * match `event.source` against each iframe's contentWindow.
   */
  const slotKeyForWindow = (source: MessageEventSource): string | null => {
    for (const [key, el] of iframeRefs.current.entries()) {
      if (el?.contentWindow && el.contentWindow === source) return key;
    }
    return null;
  };

  const replyToVisibilityReady = (
    source: MessageEventSource,
    origin: string,
  ): "sent" | "rejected" | "unmatched" => {
    for (const [key, el] of iframeRefs.current.entries()) {
      if (!el?.contentWindow || el.contentWindow !== source) continue;
      const slot = slots.get(key);
      const expectedOrigin = slot ? previewOrigin(slot.url) : null;
      if (!expectedOrigin || origin !== expectedOrigin) return "rejected";
      el.contentWindow.postMessage({
        source: "shipit-preview",
        type: "visibility",
        visible: key === activeSlotKeyRef.current && !hideIframe,
      }, expectedOrigin);
      return "sent";
    }
    return "unmatched";
  };

  const drainPendingReady = () => {
    const now = Date.now();
    pendingReadyRef.current = pendingReadyRef.current.filter((pending) => {
      if (now - pending.receivedAt > READY_BUFFER_TTL_MS) return false;
      return replyToVisibilityReady(pending.source, pending.origin) === "unmatched";
    });
  };

  useEventListener(window, "message", (event) => {
    const data = event.data as { source?: string; type?: string } | undefined;
    if (data?.source !== "shipit-preview") return;
    if (data.type === "agent_message" && onAgentInterfaceMessage && activeSlotKeyRef.current) {
      const iframe = iframeRefs.current.get(activeSlotKeyRef.current);
      const slot = slots.get(activeSlotKeyRef.current);
      const expectedOrigin = slot ? previewOrigin(slot.url) : null;
      if (iframe && expectedOrigin) {
        void handleAgentInterfaceRequest({
          event,
          iframe,
          expectedOrigin,
          surface: "preview",
          dispatch: onAgentInterfaceMessage,
        });
      }
      return;
    }
    if (data.type === "ready" && event.source) {
      const result = replyToVisibilityReady(event.source, event.origin);
      if (result === "unmatched") {
        const pending = pendingReadyRef.current.filter(
          (entry) => Date.now() - entry.receivedAt <= READY_BUFFER_TTL_MS,
        );
        pending.push({ source: event.source, origin: event.origin, receivedAt: Date.now() });
        pendingReadyRef.current = pending.slice(-READY_BUFFER_LIMIT);
      }
      return;
    }
    if (data.type === "path" && event.source) {
      // The payload is untrusted (authored by the previewed page); the store
      // sanitizes the path and drops anything that isn't a same-document
      // absolute path. Which slot it came from is decided here by matching the
      // source window, never by trusting the message.
      const key = slotKeyForWindow(event.source);
      if (!key) return;
      usePreviewStore.getState().setPreviewPath(key, (data as { path?: unknown }).path);
      // Equally untrusted, and absent when the page never ran our injected
      // script at all (a non-proxied local preview). Anything that isn't a
      // boolean is ignored, leaving the slot "unknown" and Back enabled — so a
      // page can't clear a value it already reported by following up with a
      // malformed one.
      const rawCanGoBack = (data as { canGoBack?: unknown }).canGoBack;
      if (typeof rawCanGoBack === "boolean") {
        setSlotCanGoBack((prev) => (
          prev.get(key) === rawCanGoBack ? prev : new Map(prev).set(key, rawCanGoBack)
        ));
      }
      return;
    }
    if (data.type !== "loaded") return;
    // Identify which pool slot the message came from by matching
    // `event.source` against each iframe's contentWindow. We can't trust
    // the message contents for this — the injected script doesn't know
    // the slot key, and we wouldn't trust user-controllable content for
    // it anyway.
    for (const [key, el] of iframeRefs.current.entries()) {
      if (el?.contentWindow && el.contentWindow === event.source) {
        loadedSlotsRef.current.add(authKey(key));
        reloadableWindowsRef.current.set(key, el.contentWindow);
        // A late "loaded" overturns a blocked verdict — the page came up after
        // all, so the slot must not stay settled or the overlay would come back
        // on the next visit.
        authSettledRef.current.delete(authKey(key));
        markAuthBlocked(key, false);
        if (key === activeSlotKeyRef.current) authRetryRef.current = 0;
        return;
      }
    }
  });

  const isLocalPreview = /^(localhost|127\.\d+\.\d+\.\d+|::1)(:|$)/i.test(apiHost);
  const previewSubdomainUrl = isContainerMode && sessionId ? buildSubdomainUrl(sessionId, activePort, apiHost, apiProtocol) : null;

  // eslint-disable-next-line no-restricted-syntax -- existing usage
  useEffect(() => {
    if (!activeSlotUrl || !previewSubdomainUrl || isLocalPreview) return;
    if (!activeSlotKey) return;
    // Slot already confirmed loaded — e.g. revisiting a cached iframe in the
    // pool. Skip the timer entirely; we know the URL is reachable and the
    // injected script ran the first time around, so there's nothing to detect.
    // Without this guard the timer would expire (no fresh postMessage on
    // revisit), force-reload the iframe, and discard the user's in-iframe state.
    if (loadedSlotsRef.current.has(authKey(activeSlotKey))) {
      markAuthBlocked(activeSlotKey, false);
      return;
    }
    // Detection already concluded for this slot at this URL. Re-arming would
    // time out against a cached iframe that isn't fetching anything and reload
    // it for no reason; the recorded verdict is already on screen.
    if (authSettledRef.current.get(authKey(activeSlotKey)) === activeSlotUrl) return;
    // Reset the retry budget when the user navigates to a different preview URL.
    // refreshKey changes (manual or auto retry) keep the existing budget.
    if (lastAuthUrlRef.current !== activeSlotUrl) {
      lastAuthUrlRef.current = activeSlotUrl;
      authRetryRef.current = 0;
    }
    markAuthBlocked(activeSlotKey, false);
    const timer = setTimeout(() => {
      if (loadedSlotsRef.current.has(authKey(activeSlotKey))) return;
      if (authRetryRef.current < MAX_AUTH_RETRIES) {
        // Silent auto-reload: the refreshKey effect below will set el.src
        // again, which forces the iframe to re-fetch and re-run the injected
        // script. Most "auth required" false positives clear on a single retry.
        authRetryRef.current += 1;
        setRefreshKey((k) => k + 1);
        return;
      }
      authSettledRef.current.set(authKey(activeSlotKey), activeSlotUrl);
      markAuthBlocked(activeSlotKey, true);
    }, MAX_AUTH_TIMEOUT_MS);
    return () => clearTimeout(timer);
    // `activeSlot?.generation` is a dep so a rebuilt slot re-arms detection for
    // the new element instead of resting on the old one's verdict.
  }, [activeSlotKey, activeSlotUrl, previewSubdomainUrl, isLocalPreview, refreshKey, activeSlot?.generation]);

  // ---- Agent-authored pointers (docs/258) ----
  // A `shipit-preview://` click records a destination; by the time it reaches
  // this slot, everything else has already happened (the service is running and
  // its port is selected). All that is left is to put the frame there.
  //
  // The destination is handed to the injected preview script, for the same
  // reason refresh is: a `src` assignment is always a *document load*, so a
  // pointer at a place inside the page the user is already on tore the app down
  // and rebuilt it — a visible blink, and every bit of in-page state gone. The
  // script sits on the other side of the cross-origin boundary, where the live
  // `location` is readable, so it can tell a same-document destination (only
  // the fragment differs) from one that genuinely needs a new document.
  //
  // Slots without that script — a non-proxied local preview, a 502, an
  // auth-gated response — never reported "loaded", and fall back to the `src`
  // assignment, which is a document load but at least arrives.
  const previewLinkIntent = usePreviewStore((s) => s.previewLinkIntent);
  // eslint-disable-next-line no-restricted-syntax -- navigates a live iframe to an agent-authored destination
  useEffect(() => {
    if (!previewLinkIntent || !activeSlotKey || !activeSlotUrl) return;
    if (previewLinkIntent.slotKey !== activeSlotKey) return;
    if (previewLinkIntent.sessionId !== sessionId) return;
    // No slot yet — the health poller creates it *at* the destination, so
    // there is nothing to do here and nothing to report.
    const el = iframeRefs.current.get(activeSlotKey);
    if (!el) return;

    const clearIntent = () =>
      usePreviewStore.getState().clearPreviewLinkIntent(previewLinkIntent.clickId);

    const outcome = resolvePointerNavigation(
      previewLinkIntent.targetPath,
      activeSlotUrl,
      usePreviewStore.getState().previewPaths[activeSlotKey],
    );
    clearIntent();

    if (outcome.kind === "navigate") {
      const win = el.contentWindow;
      // Targeted at the slot's own origin, never `"*"`. A `WindowProxy` keeps
      // its identity across document AND origin changes, so a frame that has
      // since navigated itself somewhere else still matches the capability
      // gate — and this message carries the agent-authored URL, which a foreign
      // page must not be handed. A mismatch drops the message in the browser;
      // that leaves the click doing nothing, which is the accepted best-effort
      // class (req 10), not a leak.
      const expectedOrigin = previewOrigin(activeSlotUrl);
      if (win && expectedOrigin && reloadableWindowsRef.current.get(activeSlotKey) === win) {
        win.postMessage({ source: "shipit-toolbar", type: "navigate", url: outcome.url }, expectedOrigin);
      } else {
        el.src = outcome.url;
      }
    } else if (outcome.kind === "outside-preview") {
      useUiStore.getState().setToast({
        message: "That link can't be opened — it points outside the preview.",
        variant: "error",
      });
    }
  }, [previewLinkIntent, activeSlotKey, activeSlotUrl, sessionId, iframeRefs]);

  // Force-reload the active iframe on refresh click
  const lastRefreshKey = useRef(refreshKey);
  // eslint-disable-next-line no-restricted-syntax -- existing usage
  useEffect(() => {
    if (refreshKey !== lastRefreshKey.current) {
      lastRefreshKey.current = refreshKey;
      if (activeSlotKey) {
        markAuthBlocked(activeSlotKey, false);
        // A manual refresh (or the auth-retry escalation) intentionally
        // throws away the cached "loaded" state and any settled verdict for
        // this slot so the detection timer re-arms and a genuinely
        // auth-blocked response can be re-detected. This is a real fetch, so
        // an expiry means something again.
        loadedSlotsRef.current.delete(activeSlotKey);
        authSettledRef.current.delete(activeSlotKey);
        const el = iframeRefs.current.get(activeSlotKey);
        // Reload the page the preview is CURRENTLY on. Re-assigning `src`
        // navigates back to the slot's entry URL, so a user who had clicked
        // into a sub-route (or an SPA route) lost their place and landed on
        // the front page. The iframe is cross-origin, so we ask the injected
        // preview script (preview-proxy.ts) to call `location.reload()`.
        // Slots without that script — a direct non-proxied local preview, a
        // 502, an auth-gated response — never reported "loaded", and fall
        // back to the `src` re-assignment, which is also what the auth-retry
        // escalation needs (a genuinely blocked slot must re-fetch).
        if (el?.contentWindow && reloadableWindowsRef.current.get(activeSlotKey) === el.contentWindow) {
          el.contentWindow.postMessage({ source: "shipit-toolbar", type: "reload" }, "*");
        } else if (el && activeSlotUrl) {
          el.src = activeSlotUrl;
        }
      }
    }
  }, [refreshKey, activeSlotKey, activeSlotUrl, iframeRefs]);

  // Reload the pane when the service it waited for comes back (planning#478).
  // The slot is retained through the outage by design (docs/089), so promoting
  // it would re-show the document the service served before it went down — the
  // wait would end on a stale page. Only a slot that actually exists needs
  // this; a new one enters at the right URL on its own.
  //
  // The ref holds the SLOT KEY that was waiting, never a bare boolean. A key
  // carries the session, and a boolean cannot: switching from a waiting session
  // A straight to a running session B reads as A-waiting → B-running, and the
  // reload would land on B's retained iframe — destroying exactly the in-page
  // state the iframe pool exists to keep. And the edge is `running`, not merely
  // "no longer waiting", so a row that blinks out of the list is not mistaken
  // for a recovery and reloaded on its way back.
  const waitingSlotRef = useRef<string | null>(null);
  // eslint-disable-next-line no-restricted-syntax -- reacts to a service returning to `running` over WS
  useEffect(() => {
    const waitingSlot = waitingSlotRef.current;
    waitingSlotRef.current = waitingForService ? activeSlotKey : null;
    if (
      waitingSlot
      && waitingSlot === activeSlotKey
      && activeServiceState?.status === "running"
      && createdSlotsRef.current.has(activeSlotKey)
    ) {
      setRefreshKey((k) => k + 1);
    }
  }, [waitingForService, activeSlotKey, activeServiceState?.status, createdSlotsRef]);

  // Remember the last port label so the top bar doesn't flash "Preview" during session switch
  const lastPortLabel = useRef<string | null>(null);

  // ---- Determine overlay content (replaces early returns) ----
  // By computing overlay content instead of returning early, we keep a single
  // DOM tree so the iframe element is never destroyed/recreated.
  const isRunning = !!preview?.running;
  const startupSteps = usePreviewStore((s) => s.startupSteps);

  // Compute current port label and remember it for transitions
  // Prefer service name over raw port number for detected services
  const serviceForPort = (port: number) => services.find(s => s.port === port);
  // Keyed on `activePort`, not on `isRunning`: the pane can be parked on a
  // service while nothing at all is up (planning#478), and the toolbar has to
  // keep naming it — that name is what says WHAT the pane is waiting for.
  const currentPortLabel = activePort
    ? (activeServiceState?.name ?? serviceForPort(activePort)?.name ?? (preview?.url?.startsWith("/preview/") ? `port ${activePort}` : `localhost:${activePort}`))
    : null;
  if (currentPortLabel) {
    lastPortLabel.current = currentPortLabel;
  }
  // Show last known port label during transitions (old iframe still visible)
  const portLabel = currentPortLabel ?? (showIframe ? lastPortLabel.current : null);

  // Build the list of all available ports for the selector
  const allPorts: PortInfo[] = [];
  if (isRunning && (preview.source === "vite" || preview.source === "managed")) {
    const label = preview.source === "vite" ? "Vite" : "Preview";
    allPorts.push({ port: preview.port, label, status: "running" });
  }
  if (isRunning) {
    for (const p of detectedPorts) {
      if (p !== preview.port || (preview.source !== "vite" && preview.source !== "managed")) {
        const svc = serviceForPort(p);
        allPorts.push({ port: p, label: svc?.name ?? `port ${p}`, status: svc?.status ?? "running" });
      }
    }
  }

  // The pane can be parked on a service that is NOT running, so its row is
  // missing from `detectedPorts` above — add it, or the selector would have no
  // entry for what the pane is actually on and (with one other service up)
  // would not render at all, leaving no way back but the drawer.
  if (isRunning && activeServiceState && !allPorts.some(p => p.port === activePort)) {
    allPorts.push({ port: activePort, label: activeServiceState.name, status: activeServiceState.status });
  }
  const showSelector = isRunning && (
    allPorts.length > 1
    || detectedPorts.length > 1
    || ((preview.source === "vite" || preview.source === "managed") && detectedPorts.length > 0)
  );

  // The service's OWN status, not "whatever the port list says": a waiting pane
  // must show its service stopped/starting rather than a green dot.
  const activeStatus = activeServiceState?.status
    ?? allPorts.find(p => p.port === activePort)?.status
    ?? (isRunning ? "running" : "stopped");

  const hasErrors = errors.length > 0;
  const composeError = usePreviewStore((s) => s.composeError);
  const composeNotConfigured = usePreviewStore((s) => s.composeNotConfigured);
  const showComposeError = !!composeError && !isRunning;
  const showComposeHint = composeNotConfigured && !isRunning && !showComposeError;
  const showStartupSteps = startupSteps.length > 0 && !isRunning && !showComposeError && !showComposeHint;
  const showStarting = !showStartupSteps && !showComposeError && !showComposeHint && !preview && !!sessionId;
  const showServices = services.length > 0 && !isRunning && !showComposeError && !showStartupSteps && !showComposeHint;

  // Container preview is running, but the host ShipIt is reached on can't carry a
  // wildcard subdomain (a raw IP / IPv6 literal). No subdomain URL can be built,
  // so the poller created no iframe slot — surface *why* instead of a blank pane.
  // Subdomain routing is the only supported container-preview path (the old
  // path-based fallback is gone — it 404'd every absolute asset URL).
  const cannotSubdomainPreview = isContainerMode && isRunning && !!activePort && !!sessionId && previewSubdomainUrl === null;
  // A concrete host the user could switch to, when one exists (docs/254-local-bind-and-tailnet-access req 8).
  const suggestedWildcardHost = cannotSubdomainPreview ? suggestWildcardHost(apiHost) : null;

  // When not running, hide the iframe behind the overlay (but keep DOM element
  // alive) — and likewise whenever this pane is not the one on screen, or while
  // it waits for its service to come back. All three reasons feed the same flag
  // because they have the same two consequences: the slot is given
  // `display: none`, which is what actually stops it rendering, and every
  // mounted page is told `visible: false`.
  const hideIframe = (!isRunning && !showStarting) || !paneVisible || waitingForService;

  // Keep every mounted page informed when its ShipIt surface becomes visible
  // or hidden. Background slots remain alive by design, so CSS alone is not a
  // sufficient lifecycle signal for audio, animation, or automatic work.
  // `iframeRefs` is a ref (stable) and `drainPendingReady` is only invoked, never
  // captured — the effect must fire on slot/visibility changes, not on either
  // identity, so both stay out of the deps.
  // eslint-disable-next-line no-restricted-syntax -- synchronize cooperative child visibility with iframe-pool state
  useEffect(() => {
    drainPendingReady();
    for (const [key, el] of iframeRefs.current.entries()) {
      const slot = slots.get(key);
      const expectedOrigin = slot ? previewOrigin(slot.url) : null;
      if (!el?.contentWindow || !expectedOrigin) continue;
      el.contentWindow.postMessage({
        source: "shipit-preview",
        type: "visibility",
        visible: key === activeSlotKey && !hideIframe,
      }, expectedOrigin);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `iframeRefs` is a ref and `drainPendingReady` is only invoked; this must fire on slot/visibility changes, not on either identity
  }, [activeSlotKey, hideIframe, slotOrder, slots]);

  // Determine overlay content for the main area
  let overlayContent: React.ReactNode = null;
  if (showStartupSteps) {
    overlayContent = <StartupSteps steps={startupSteps} />;
  } else if (showComposeError) {
    overlayContent = <ComposeErrorBanner composeError={composeError} onSendToAgent={onSendCrashToAgent} />;
  } else if (showComposeHint) {
    overlayContent = <PreviewSetupInvite onSendToAgent={onSendComposeHintToAgent} />;
  } else if (waitingForService && activeServiceState) {
    // The pane holds its service through an outage rather than showing another
    // one (planning#478). `starting` is a wait with an end in sight; `stopped`
    // and `error` are not, so those say what the pane is waiting FOR and leave
    // the Start control to the Services drawer docked right below, which owns
    // every service's lifecycle already (docs/175) — this overlay does not
    // duplicate it.
    const starting = activeServiceState.status === "starting";
    overlayContent = (
      <div className="text-center space-y-3 max-w-sm px-4">
        {starting
          ? <CircleNotchIcon size={ICON_SIZE.MD} className="mx-auto animate-spin text-(--color-accent)" />
          : <WarningIcon size={ICON_SIZE.LG} className="mx-auto text-(--color-text-tertiary)" />}
        <p className="font-medium">
          {starting
            ? `Waiting for ${activeServiceState.name}…`
            : `${activeServiceState.name} is not running`}
        </p>
        <p className="text-xs text-(--color-text-secondary)">
          {starting
            ? "The preview returns here as soon as the service is up."
            : "The preview stays on this service and returns as soon as it is running again. Start it from the Services drawer below, or pick another service above."}
        </p>
        {activeServiceState.error && (
          <p className="text-xs text-(--color-error) break-words">{activeServiceState.error}</p>
        )}
      </div>
    );
  } else if (showStarting && !showIframe) {
    overlayContent = (
      <div className="text-center space-y-3">
        <CircleNotchIcon size={ICON_SIZE.MD} className="mx-auto animate-spin text-(--color-accent)" />
        <p>Starting dev server...</p>
      </div>
    );
  } else if (cannotSubdomainPreview) {
    overlayContent = (
      <div className="text-center space-y-3 max-w-md px-4">
        <WarningIcon size={ICON_SIZE.LG} className="mx-auto text-(--color-warning)" />
        <p className="font-medium">Preview not available over this host</p>
        <p className="text-xs text-(--color-text-secondary)">
          You&apos;re reaching ShipIt at{" "}
          <code className="px-1.5 py-0.5 rounded bg-(--color-bg-secondary) text-(--color-text-primary) text-xs">{apiHost}</code>,
          which can&apos;t host preview subdomains. Previews are served at{" "}
          <code className="px-1.5 py-0.5 rounded bg-(--color-bg-secondary) text-(--color-text-primary) text-xs">{`{session}--${activePort}.<host>`}</code>,
          so they need a hostname with wildcard DNS. Open ShipIt via{" "}
          <code className="px-1.5 py-0.5 rounded bg-(--color-bg-secondary) text-(--color-text-primary) text-xs">localhost</code>,
          a domain with a <code className="px-1.5 py-0.5 rounded bg-(--color-bg-secondary) text-(--color-text-primary) text-xs">*</code> DNS record,
          or Tailscale with MagicDNS wildcard resolution.
        </p>
        {suggestedWildcardHost && (
          <p className="text-xs text-(--color-text-secondary)">
            For this host, opening ShipIt at{" "}
            <code className="px-1.5 py-0.5 rounded bg-(--color-bg-secondary) text-(--color-text-primary) text-xs">
              http://{suggestedWildcardHost}
            </code>{" "}
            works without any DNS setup.
          </p>
        )}
      </div>
    );
  } else if (authBlocked && activeSlotUrl) {
    overlayContent = (
      <div className="text-center space-y-3 max-w-sm px-4">
        <WarningIcon size={ICON_SIZE.LG} className="mx-auto text-(--color-warning)" />
        <p className="font-medium">Preview authentication required</p>
        <p className="text-xs text-(--color-text-secondary)">
          Your reverse proxy requires separate authentication for preview subdomains.
          Open the preview in a new tab to authenticate — this is needed once per session.
        </p>
        <div className="flex items-center justify-center gap-2">
          <Button
            variant="primary"
            size="md"
            // `noopener,noreferrer` like the toolbar's button: the preview is
            // arbitrary user code, and an opener handle lets it navigate the
            // ShipIt tab it was launched from.
            onClick={() => window.open(activeSlotUrl, "_blank", "noopener,noreferrer")}
          >
            <ArrowSquareOutIcon size={ICON_SIZE.SM} />
            Open in new tab
          </Button>
          <Button
            variant="secondary"
            size="md"
            onClick={() => {
              if (activeSlotKey) markAuthBlocked(activeSlotKey, false);
              authRetryRef.current = 0;
              setRefreshKey((k) => k + 1);
            }}
          >
            <ArrowClockwiseIcon size={ICON_SIZE.SM} />
            Retry
          </Button>
        </div>
      </div>
    );
  } else if (showServices) {
    // No preview is running but compose services exist. The Services drawer
    // (docs/175) docked below already lists every service with Start/Stop and
    // logs, so this overlay only nudges the user toward it instead of
    // duplicating the list. `manualOnly` just tunes the copy (the dogfooding
    // case is a single manual `dev` service the user must start by hand).
    const manualOnly = services.length > 0 && services.every(s => s.preview === "manual");
    // No button here. The drawer opens itself while nothing is previewing, and
    // the one case where it doesn't — the user collapsed it by hand — is a
    // deliberate act, with the drawer's own caret right there to undo it.
    overlayContent = (
      <div className="text-center space-y-3 max-w-sm px-4">
        <WarningIcon size={ICON_SIZE.LG} className="mx-auto text-(--color-text-tertiary)" />
        <p className="text-sm text-(--color-text-secondary)">
          {manualOnly ? "No preview running. Start a service to launch it." : "No preview running"}
        </p>
      </div>
    );
  }

  return (
    <div className={`flex flex-col h-full ${autoFixEnabled ? "ring-2 ring-(--color-autofix) ring-inset" : ""}`}>
      {/* Top bar — always rendered for layout stability */}
      <PreviewToolbar
        isRunning={isRunning}
        showSelector={showSelector}
        portSelectorOpen={portSelectorOpen}
        setPortSelectorOpen={setPortSelectorOpen}
        activeStatus={activeStatus}
        portLabel={portLabel}
        allPorts={allPorts}
        activePort={activePort}
        onSelectPort={onSelectPort}
        deviceFrameActive={deviceFrameActive}
        deviceWidth={deviceWidth}
        deviceHeight={deviceHeight}
        deviceScale={deviceScale}
        deviceScalePercent={deviceScalePercent}
        freeformPanelSize={freeformPanelSize}
        hasErrors={hasErrors}
        errorCount={errors.length}
        errorPanelOpen={errorPanelOpen}
        setErrorPanelOpen={setErrorPanelOpen}
        onRefresh={() => setRefreshKey((k) => k + 1)}
        canGoBack={activeCanGoBack}
        onBack={() => {
          // The iframe is cross-origin, so we can't call `history.back()` on it
          // directly — ask the injected preview script (preview-proxy.ts) to.
          // It navigates the frame's own entry list, never the joint session
          // history, so a preview with nothing behind it can't walk ShipIt back.
          if (!activeSlotKey) return;
          iframeRefs.current
            .get(activeSlotKey)
            ?.contentWindow?.postMessage({ source: "shipit-toolbar", type: "back" }, "*");
        }}
        onHome={() => {
          // The iframe is cross-origin, so the parent can't read or write its
          // `location` — ask the injected preview script (preview-proxy.ts) to
          // navigate it to the slot's root, the same channel the agent-pointer
          // effect uses. The script drops the navigation when the page is
          // already at root, so this never reloads the front page for its own
          // sake. Slots without that script — a non-proxied local preview, a
          // 502, an auth-gated response — never reported "loaded", and fall
          // back to a `src` assignment, which is a document load but arrives.
          if (!activeSlotKey || !activeSlotUrl) return;
          const el = iframeRefs.current.get(activeSlotKey);
          const rootUrl = new URL("/", activeSlotUrl).href;
          // Targeted at the slot's own origin, never `"*"` — same reasoning as
          // the pointer effect above. A `WindowProxy` keeps its identity across
          // origin changes, so a frame that navigated itself somewhere else
          // still passes the capability gate, and this message carries a URL
          // (the preview subdomain names the session) rather than the bare
          // `back`/`reload` verbs. A mismatch drops it in the browser.
          const expectedOrigin = previewOrigin(activeSlotUrl);
          if (el?.contentWindow && expectedOrigin && reloadableWindowsRef.current.get(activeSlotKey) === el.contentWindow) {
            el.contentWindow.postMessage({ source: "shipit-toolbar", type: "navigate", url: rootUrl }, expectedOrigin);
          } else if (el) {
            el.src = rootUrl;
          }
        }}
        activeSlotUrl={activeSlotUrl}
        previewPath={activePath}
        previewFullUrl={activeFullUrl}
      />

      {/* Missing-required-secrets banner (087 Phase 2). One row at the top of
          the panel that links to the Secrets settings tab. Only shown when at
          least one declared secret is `required: true` and has no value. */}
      <SecretsMissingBanner />

      {/* Main content area — iframe pool, one per (session, port) */}
      <div
        ref={deviceContainerRef}
        className={`flex-1 relative ${deviceFrameActive ? "bg-(--color-bg-tertiary) overflow-hidden" : ""}`}
      >
        {/* Persistent iframes — each (session, port) gets its own iframe, hidden via CSS when not active.
            Render in stable INSERTION order (the `slots` Map preserves it), NOT the LRU `slotOrder`.
            `slotOrder` reorders on every session switch (promoteSlot moves the active slot to the
            front), and reordering keyed <iframe> elements moves them in the DOM — which forces the
            browser to RELOAD the iframe, wiping its in-page state and defeating the whole pool.
            Insertion order never moves an existing iframe, so a cached preview survives switching
            away and back. The active slot is chosen by the `hidden` class below, so render order is
            purely structural and doesn't affect which preview is shown. */}
        {[...slots.keys()].map((key) => {
          const slot = slots.get(key);
          if (!slot) return null;
          const isActive = key === activeSlotKey;
          // `hidden` is Tailwind's `display: none`, and that is the whole of
          // nikzlabs/shipit#2418.
          //
          // This was `invisible` (`visibility: hidden`), which hides only the
          // pixels: the document keeps rendering at full frame rate for the rest
          // of the session. Measured cross-origin over a 4-second hide, a
          // background page drew **240 frames** that way and **1** under
          // `display: none`. On the reporter's phone that surplus was a second
          // WebGL renderer competing for the GPU with the preview they were
          // looking at, costing the visible one 9.5–13.5% of its frames in a
          // matched A/B at both 60 Hz and 120 Hz.
          //
          // **The one thing this costs is focus inside the frame**, knowingly:
          // measured, a genuine browser tab switch DOES restore the focused
          // element, so this deviates from the "it feels like keeping tabs open"
          // promise this pool is built on (docs/089). Everything else a person
          // would notice survives — no reload, typed text, inner and document
          // scroll, and the caret offset — so a preview you were typing in comes
          // back whole except that you must tap the field to resume. The design
          // owner was shown the measurement and took that trade.
          //
          // The alternative that keeps focus is `invisible` plus a parking
          // transform (`translateY(-200vh)`), which throttles equally well. It
          // was dropped once focus was off the table: two properties doing two
          // jobs, and a silent dependency on that constant always clearing the
          // viewport — a future layout placing this pane under a transformed or
          // scrolled ancestor would stop it throttling with nothing to notice.
          // `display: none` cannot fail that way, and it drops the frame from
          // the tab order and the accessibility tree without a second property.
          //
          // This does not replace the docs/146 visibility contract: nothing here
          // stops **audio**, which is exactly why that cooperative protocol
          // exists. Rendering and audio are separate axes.
          const hidden = !isActive || hideIframe;
          // When a device preset is active, give the active iframe explicit dimensions
          // and center it in the panel with a scale transform.
          const useDeviceFrameStyle = isActive && deviceFrameActive;
          const deviceFrameStyle: React.CSSProperties | undefined = useDeviceFrameStyle
            ? {
              width: `${deviceWidth}px`,
              height: `${deviceHeight}px`,
              left: "50%",
              top: "50%",
              transform: `translate(-50%, -50%) scale(${deviceScale})`,
              transformOrigin: "center center",
            }
            : undefined;
          return (
            <iframe
              // Generation-suffixed so a slot rebuilt after an ownership
              // takeover mounts a fresh element, and therefore actually loads
              // the new owner's app (planning#394).
              key={slot.generation ? `${key}#${slot.generation}` : key}
              ref={(el) => {
                iframeRefs.current.set(key, el);
                if (el) drainPendingReady();
              }}
              src={slot.url}
              title={isActive ? "Live Preview" : "Background Preview"}
              style={deviceFrameStyle}
              className={
                useDeviceFrameStyle
                  // `box-content`: the 1px frame border must not come out of the
                  // viewport itself — under the global border-box preflight a
                  // "393×852" frame gave the page 391×850 CSS px, so a breakpoint
                  // set at an exact width (the whole point of the control) never
                  // fired (docs/278 req 5: the indicator tells the truth).
                  ? `absolute box-content bg-white rounded-md shadow-2xl border border-(--color-border-secondary) ${hidden ? "hidden" : ""}`
                  : `absolute inset-0 w-full h-full ${hidden ? "hidden" : ""} ${isActive && hasErrors && errorPanelOpen ? "max-h-[60%]" : ""}`
              }
              {...(!slot.containerMode && { sandbox: "allow-scripts allow-same-origin allow-forms allow-popups allow-modals" })}
            />
          );
        })}
        {/* Drag handles on the constrained surface (docs/278). Rendered after
            the iframes so they stack above them; the state overlay (z-10)
            still covers them when it is up. Hidden with the iframe — a drag
            against a hidden surface would resize nothing visible. */}
        {deviceFrameActive && !hideIframe && (
          <ViewportResizeHandles
            deviceWidth={deviceWidth}
            deviceHeight={deviceHeight}
            deviceScale={deviceScale}
            availableWidth={availableWidth}
            availableHeight={availableHeight}
          />
        )}
        {/* Transition overlay while polling for new session/port (background iframe may be visible underneath) */}
        {isTransitioning && !overlayContent && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/10 pointer-events-none">
            <CircleNotchIcon size={ICON_SIZE.MD} className="animate-spin text-(--color-accent)" />
          </div>
        )}
        {/* Stale iframe with spinner during session switch (showStarting + old iframe still visible) */}
        {showStarting && showIframe && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/10 pointer-events-none">
            <CircleNotchIcon size={ICON_SIZE.MD} className="animate-spin text-(--color-accent)" />
          </div>
        )}
        {/* State overlay — covers the iframe area */}
        {overlayContent && (
          <div className="absolute inset-0 flex items-center justify-center bg-(--color-bg-primary) text-(--color-text-secondary) text-sm z-10">
            {overlayContent}
          </div>
        )}
        {/* No "connecting" overlay here on purpose (docs/286). The slot is
            created without a reachability check, and a preview that isn't
            serving yet gets the proxy's own connecting page inside the iframe —
            so the wait is the document's state, not a cover over it. */}
      </div>

      {/* Error panel */}
      {hasErrors && errorPanelOpen && (
        <PreviewErrors errors={errors} onSendErrors={onSendErrors} onClearErrors={onClearErrors} />
      )}
    </div>
  );
}
