// eslint-disable-next-line no-restricted-imports -- useEffect: auth-blocked detection + iframe refresh (external system sync)
import { useState, useEffect, useRef, useMemo } from "react";
import { useEventListener } from "../../hooks/useEventListener.js";
import { WarningIcon, CircleNotchIcon, ArrowClockwiseIcon, ArrowSquareOutIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../../design-tokens.js";
import { Button } from "../ui/button.js";
import type { PreviewError } from "../../hooks/usePreviewErrors.js";
import { usePreviewStore } from "../../stores/preview-store.js";
import { useUiStore } from "../../stores/ui-store.js";
import { resolvePreviewHost } from "../../utils/preview-host.js";
import { StartupSteps } from "../StartupSteps.js";
import { useIframePool } from "../../hooks/useIframePool.js";
import { usePreviewHealthPoller, buildSubdomainUrl } from "../../hooks/usePreviewHealthPoller.js";
import { useDeviceFrame } from "./DeviceFrame.js";
import { PreviewToolbar, type PortInfo } from "./PreviewToolbar.js";
import { PreviewErrors } from "./PreviewErrors.js";
import { ComposeErrorBanner, ComposeHint } from "./ComposeErrorBanner.js";
import { SecretsMissingBanner } from "./SecretsMissingBanner.js";

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

interface PreviewFrameProps {
  preview: PreviewStatus | null;
  /** Current session ID — part of the iframe-pool slot key (`sessionId:port`). */
  sessionId?: string;
  /** Sessions whose PR has merged; background iframes for these sessions are torn down. */
  mergedSessionIds?: string[];
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
  /** Called when user clicks "Send to agent" to ask the agent to add compose config. */
  onSendComposeHintToAgent?: () => void;
}

export function PreviewFrame({
  preview,
  sessionId,
  mergedSessionIds = [],
  detectedPorts,
  selectedPort,
  onSelectPort,
  errors,
  onSendErrors,
  onClearErrors,
  onSendCrashToAgent,
  onSendComposeHintToAgent,
}: PreviewFrameProps) {
  const autoFixEnabled = usePreviewStore((s) => s.autoFixEnabled);
  const [refreshKey, setRefreshKey] = useState(0);
  const [errorPanelOpen, setErrorPanelOpen] = useState(false);
  const [portSelectorOpen, setPortSelectorOpen] = useState(false);

  // ---- Device frame measurement ----
  // When a preset is active, we resize the iframe to the preset width/height
  // and scale it down with `transform: scale()` if it doesn't fit the panel.
  const { deviceContainerRef, deviceFrameActive, deviceWidth, deviceHeight, deviceScale, deviceScalePercent } = useDeviceFrame();

  // Compute active port early so hooks can reference it (0 when not running)
  const activePort = preview?.running ? (selectedPort ?? preview.port) : 0;

  // Host + protocol for container-mode subdomain URLs (e.g. "localhost:3001").
  // On a Tailscale MagicDNS deploy this routes previews through the sslip host
  // over http: while the app/WS stay on the native .ts.net host (docs/216).
  const tailnetPreviewHost = useUiStore((s) => s.tailnetPreviewHost);
  const { host: apiHost, protocol: apiProtocol } = resolvePreviewHost(window.location.host, tailnetPreviewHost);

  // ---- Iframe pool: one iframe per (session, port) ----
  // Slots are keyed by "sessionId:port". Only the active slot is visible.
  // Background slots keep their iframes alive in the DOM. See `useIframePool`
  // for LRU eviction and `usePreviewHealthPoller` for slot creation.
  const { slots, slotOrder, iframeRefs, createdSlotsRef, pollingRef, promoteSlot, setSlot, pruneSlots } = useIframePool();

  const activeSlotKey = activePort ? `${sessionId ?? "_"}:${activePort}` : null;
  const activeSlot = activeSlotKey ? slots.get(activeSlotKey) ?? null : null;
  const mergedSessionKey = mergedSessionIds.join("\0");
  const mergedSessionIdSet = useMemo(() => new Set(mergedSessionIds), [mergedSessionKey]);

  // Container mode detection for the current preview
  const isContainerMode = !!(preview?.url?.startsWith("/preview/"));

  // Compute poll URL for the active slot
  const pollUrl = isContainerMode && sessionId
    ? `/api/preview-health/${sessionId}/${activePort}`
    : (activePort ? `http://localhost:${activePort}` : null);

  // Poll and create/update the active slot when session/port changes.
  usePreviewHealthPoller({
    activeSlotKey,
    activePort,
    sessionId,
    preview,
    pollUrl,
    isContainerMode,
    apiHost,
    apiProtocol,
    createdSlotsRef,
    pollingRef,
    promoteSlot,
    setSlot,
  });

  // Merged sessions are terminal: keep the active iframe mounted while the user
  // is viewing that session, but tear down its background iframe as soon as the
  // user switches away so completed PR previews do not keep running invisibly.
  // eslint-disable-next-line no-restricted-syntax -- existing usage
  useEffect(() => {
    if (mergedSessionIdSet.size === 0) return;
    for (const key of slotOrder) {
      if (key === activeSlotKey) continue;
      const [slotSessionId] = key.split(":");
      if (mergedSessionIdSet.has(slotSessionId)) {
        loadedSlotsRef.current.delete(key);
      }
    }
    pruneSlots((key) => {
      if (key === activeSlotKey) return false;
      const [slotSessionId] = key.split(":");
      return mergedSessionIdSet.has(slotSessionId);
    });
  }, [activeSlotKey, mergedSessionIdSet, pruneSlots, slotOrder]);

  // Derive active slot state for overlay/UI logic
  const activeSlotUrl = activeSlot?.url ?? null;
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
  const [authBlocked, setAuthBlocked] = useState(false);
  const loadedSlotsRef = useRef<Set<string>>(new Set());
  const authRetryRef = useRef(0);
  const lastAuthUrlRef = useRef<string | null>(null);
  // Mirror `activeSlotKey` into a ref so the postMessage listener (registered
  // once on mount) can read the current active slot without re-subscribing.
  const activeSlotKeyRef = useRef<string | null>(activeSlotKey);
  activeSlotKeyRef.current = activeSlotKey;
  const MAX_AUTH_TIMEOUT_MS = 5000;
  const MAX_AUTH_RETRIES = 2;

  useEventListener(window, "message", (event) => {
    const data = event.data as { source?: string; type?: string } | undefined;
    if (data?.source !== "shipit-preview" || data?.type !== "loaded") return;
    // Identify which pool slot the message came from by matching
    // `event.source` against each iframe's contentWindow. We can't trust
    // the message contents for this — the injected script doesn't know
    // the slot key, and we wouldn't trust user-controllable content for
    // it anyway.
    for (const [key, el] of iframeRefs.current.entries()) {
      if (el?.contentWindow && el.contentWindow === event.source) {
        loadedSlotsRef.current.add(key);
        if (key === activeSlotKeyRef.current) {
          authRetryRef.current = 0;
          setAuthBlocked(false);
        }
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
    if (loadedSlotsRef.current.has(activeSlotKey)) {
      setAuthBlocked(false);
      return;
    }
    // Reset the retry budget when the user navigates to a different preview URL.
    // refreshKey changes (manual or auto retry) keep the existing budget.
    if (lastAuthUrlRef.current !== activeSlotUrl) {
      lastAuthUrlRef.current = activeSlotUrl;
      authRetryRef.current = 0;
    }
    setAuthBlocked(false);
    const timer = setTimeout(() => {
      if (loadedSlotsRef.current.has(activeSlotKey)) return;
      if (authRetryRef.current < MAX_AUTH_RETRIES) {
        // Silent auto-reload: the refreshKey effect below will set el.src
        // again, which forces the iframe to re-fetch and re-run the injected
        // script. Most "auth required" false positives clear on a single retry.
        authRetryRef.current += 1;
        setRefreshKey((k) => k + 1);
        return;
      }
      setAuthBlocked(true);
    }, MAX_AUTH_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [activeSlotKey, activeSlotUrl, previewSubdomainUrl, isLocalPreview, refreshKey]);

  // Force-reload the active iframe on refresh click
  const lastRefreshKey = useRef(refreshKey);
  // eslint-disable-next-line no-restricted-syntax -- existing usage
  useEffect(() => {
    if (refreshKey !== lastRefreshKey.current) {
      lastRefreshKey.current = refreshKey;
      setAuthBlocked(false);
      if (activeSlotKey) {
        // A manual refresh (or the auth-retry escalation) intentionally
        // throws away the cached "loaded" state for this slot so the
        // detection timer re-arms and a genuinely auth-blocked response
        // can be re-detected.
        loadedSlotsRef.current.delete(activeSlotKey);
        const el = iframeRefs.current.get(activeSlotKey);
        if (el && activeSlotUrl) {
          el.src = activeSlotUrl;
        }
      }
    }
  }, [refreshKey, activeSlotKey, activeSlotUrl, iframeRefs]);

  // Remember the last port label so the top bar doesn't flash "Preview" during session switch
  const lastPortLabel = useRef<string | null>(null);

  // ---- Determine overlay content (replaces early returns) ----
  // By computing overlay content instead of returning early, we keep a single
  // DOM tree so the iframe element is never destroyed/recreated.
  const isRunning = !!preview?.running;
  const showSelector = isRunning && (detectedPorts.length > 1 || ((preview.source === "vite" || preview.source === "managed") && detectedPorts.length > 0));
  const startupSteps = usePreviewStore((s) => s.startupSteps);
  const services = usePreviewStore((s) => s.services);

  // Compute current port label and remember it for transitions
  // Prefer service name over raw port number for detected services
  const serviceForPort = (port: number) => services.find(s => s.port === port);
  const currentPortLabel = isRunning
    ? (serviceForPort(activePort)?.name ?? (preview?.url?.startsWith("/preview/") ? `port ${activePort}` : `localhost:${activePort}`))
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

  const activeStatus = allPorts.find(p => p.port === activePort)?.status ?? (isRunning ? "running" : "stopped");

  const hasErrors = errors.length > 0;
  const composeError = usePreviewStore((s) => s.composeError);
  const composeNotConfigured = usePreviewStore((s) => s.composeNotConfigured);
  const previewProxyError = usePreviewStore((s) => s.previewProxyError);
  const setPreviewProxyError = usePreviewStore((s) => s.setPreviewProxyError);
  // Surface a proxy error only for the active port and only while it's
  // recent (older than 30s likely belongs to a previous attempt that the
  // user already moved past).
  const activeProxyError = previewProxyError?.port === activePort && Date.now() - previewProxyError.at < 30_000
    ? previewProxyError
    : null;
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

  // When not running, hide the iframe behind the overlay (but keep DOM element alive)
  const hideIframe = !isRunning && !showStarting;

  // Determine overlay content for the main area
  let overlayContent: React.ReactNode = null;
  if (showStartupSteps) {
    overlayContent = <StartupSteps steps={startupSteps} />;
  } else if (showComposeError) {
    overlayContent = <ComposeErrorBanner composeError={composeError} onSendToAgent={onSendCrashToAgent} />;
  } else if (showComposeHint) {
    overlayContent = <ComposeHint onSendToAgent={onSendComposeHintToAgent} />;
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
            onClick={() => window.open(activeSlotUrl, "_blank")}
          >
            <ArrowSquareOutIcon size={ICON_SIZE.SM} />
            Open in new tab
          </Button>
          <Button
            variant="secondary"
            size="md"
            onClick={() => {
              setAuthBlocked(false);
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
    overlayContent = (
      <div className="text-center space-y-3 max-w-sm px-4">
        <WarningIcon size={ICON_SIZE.LG} className="mx-auto text-(--color-text-tertiary)" />
        <p className="text-sm text-(--color-text-secondary)">
          {manualOnly ? "No preview running. Start a service to launch it." : "No preview running"}
        </p>
        <Button variant="secondary" size="md" onClick={() => usePreviewStore.getState().setServicesDrawerExpanded(true)}>
          Show services
        </Button>
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
        hasErrors={hasErrors}
        errorCount={errors.length}
        errorPanelOpen={errorPanelOpen}
        setErrorPanelOpen={setErrorPanelOpen}
        onRefresh={() => setRefreshKey((k) => k + 1)}
        onBack={() => {
          // The iframe is cross-origin, so we can't call `history.back()` on it
          // directly — ask the injected preview script (preview-proxy.ts) to.
          if (!activeSlotKey) return;
          iframeRefs.current
            .get(activeSlotKey)
            ?.contentWindow?.postMessage({ source: "shipit-toolbar", type: "back" }, "*");
        }}
        activeSlotUrl={activeSlotUrl}
      />

      {/* Missing-required-secrets banner (087 Phase 2). One row at the top of
          the panel that links to the Secrets settings tab. Only shown when at
          least one declared secret is `required: true` and has no value. */}
      <SecretsMissingBanner />

      {/* Preview-proxy error banner — emitted by the orchestrator when the
          reverse proxy can't reach the container or HMR upgrade fails. Sits
          between the top bar and the iframe so the user gets an actionable
          message instead of a blank/502 iframe. See
          docs/124-session-rescue-and-diagnostics §1.5. */}
      {activeProxyError && (
        <div
          role="alert"
          className="flex items-center gap-2 px-3 py-1.5 border-b border-(--color-error)/40 bg-(--color-error-subtle) text-xs text-(--color-text-primary)"
        >
          <WarningIcon size={ICON_SIZE.SM} className="text-(--color-error) shrink-0" />
          <span className="flex-1 truncate">
            Preview unreachable on port {activeProxyError.port}
            {activeProxyError.upgrade && " (HMR upgrade failed)"}
            <span className="ml-1 text-(--color-text-secondary)">— {activeProxyError.message}</span>
          </span>
          <Button
            variant="secondary"
            size="md"
            onClick={() => {
              setPreviewProxyError(null);
              setRefreshKey((k) => k + 1);
            }}
            title="Retry the preview"
          >
            Retry
          </Button>
          <Button
            variant="ghost"
            size="md"
            onClick={() => setPreviewProxyError(null)}
            title="Dismiss"
          >
            Dismiss
          </Button>
        </div>
      )}

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
            away and back. The active slot is chosen via CSS visibility below, so render order is
            purely structural and doesn't affect which preview is shown. */}
        {[...slots.keys()].map((key) => {
          const slot = slots.get(key);
          if (!slot) return null;
          const isActive = key === activeSlotKey;
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
              key={key}
              ref={(el) => { iframeRefs.current.set(key, el); }}
              src={slot.url}
              title={isActive ? "Live Preview" : "Background Preview"}
              style={deviceFrameStyle}
              className={
                useDeviceFrameStyle
                  ? `absolute bg-white rounded-md shadow-2xl border border-(--color-border-secondary) ${hidden ? "invisible" : ""}`
                  : `absolute inset-0 w-full h-full ${hidden ? "invisible" : ""} ${isActive && hasErrors && errorPanelOpen ? "max-h-[60%]" : ""}`
              }
              {...(!slot.containerMode && { sandbox: "allow-scripts allow-same-origin allow-forms allow-popups allow-modals" })}
            />
          );
        })}
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
        {/* Spinner when no iframe exists for this session/port and preview is running but polling.
            Wording note: at this point the orchestrator has told us the preview
            is running — we're waiting on the preview-health poll before
            attaching the iframe. Saying "Starting dev server" here is misleading
            (especially in dogfooding, where Vite logs "ready in 437 ms" while
            this overlay is on screen); the dev server *is* up, we're just
            connecting to it. */}
        {isRunning && !activeSlotReady && !overlayContent && (
          <div className="absolute inset-0 flex items-center justify-center bg-(--color-bg-primary) text-(--color-text-secondary) text-sm">
            <div className="text-center space-y-3">
              <CircleNotchIcon size={ICON_SIZE.MD} className="mx-auto animate-spin text-(--color-accent)" />
              <p>Connecting to dev server...</p>
            </div>
          </div>
        )}
      </div>

      {/* Error panel */}
      {hasErrors && errorPanelOpen && (
        <PreviewErrors errors={errors} onSendErrors={onSendErrors} onClearErrors={onClearErrors} />
      )}
    </div>
  );
}
