// eslint-disable-next-line no-restricted-imports -- useEffect: auth-blocked detection + iframe refresh (external system sync)
import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { Spinner } from "../Spinner.js";
import { useEventListener } from "../../hooks/useEventListener.js";
import { WarningIcon, ArrowClockwiseIcon, ArrowSquareOutIcon } from "@phosphor-icons/react";
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

  source?: "vite" | "managed" | "detected";

  detectedPorts?: number[];

  exitCode?: number | null;

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

  sessionId?: string;

  detectedPorts: number[];

  selectedPort: number | null;

  onSelectPort: (port: number) => void;

  errors: PreviewError[];

  onSendErrors: (errors: PreviewError[]) => void;

  onClearErrors: () => void;

  onSendCrashToAgent?: () => void;

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

  const slotPaths = usePreviewStore((s) => s.previewPaths);

  const [slotCanGoBack, setSlotCanGoBack] = useState<Map<string, boolean>>(new Map());
  const [errorPanelOpen, setErrorPanelOpen] = useState(false);
  const [portSelectorOpen, setPortSelectorOpen] = useState(false);

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

  const freeformPanelSize = availableWidth > 0 && availableHeight > 0
    ? {
      width: Math.min(Math.max(Math.round(availableWidth), CUSTOM_SIZE_MIN), CUSTOM_SIZE_MAX),
      height: Math.min(Math.max(Math.round(availableHeight), CUSTOM_SIZE_MIN), CUSTOM_SIZE_MAX),
    }
    : null;

  const activePort = preview?.running ? (selectedPort ?? preview.port) : (selectedPort ?? 0);

  // Host + protocol for container-mode subdomain URLs (e.g. "localhost:3001").

  const tailnetPreviewHost = useUiStore((s) => s.tailnetPreviewHost);
  const { host: apiHost, protocol: apiProtocol } = resolvePreviewHost(window.location.host, tailnetPreviewHost);

  const { slots, slotOrder, iframeRefs, createdSlotsRef, promoteSlot, setSlot, dropSlot, dropSessionSlots, getSlot } = useIframePool();

  // active session is never touched — see the hook.

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

  const isContainerMode = !!(preview?.url?.startsWith("/preview/"));

  const services = usePreviewStore((s) => s.services);

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

  const activeSlotUrl = activeSlot?.url ?? null;
  const activePath = activeSlotKey ? slotPaths[activeSlotKey] ?? null : null;
  const activeCanGoBack = activeSlotKey ? slotCanGoBack.get(activeSlotKey) : undefined;

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

  // never reported "loaded" (non-HTML root, failed injection, a 502 served

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

  const reloadableWindowsRef = useRef<Map<string, MessageEventSource>>(new Map());
  const pendingReadyRef = useRef<{ source: MessageEventSource; origin: string; receivedAt: number }[]>([]);
  const authRetryRef = useRef(0);
  const lastAuthUrlRef = useRef<string | null>(null);

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

      // source window, never by trusting the message.
      const key = slotKeyForWindow(event.source);
      if (!key) return;
      usePreviewStore.getState().setPreviewPath(key, (data as { path?: unknown }).path);
      // Equally untrusted, and absent when the page never ran our injected

      const rawCanGoBack = (data as { canGoBack?: unknown }).canGoBack;
      if (typeof rawCanGoBack === "boolean") {
        setSlotCanGoBack((prev) => (
          prev.get(key) === rawCanGoBack ? prev : new Map(prev).set(key, rawCanGoBack)
        ));
      }
      return;
    }
    if (data.type !== "loaded") return;

    for (const [key, el] of iframeRefs.current.entries()) {
      if (el?.contentWindow && el.contentWindow === event.source) {
        loadedSlotsRef.current.add(authKey(key));
        reloadableWindowsRef.current.set(key, el.contentWindow);

        // all, so the slot must not stay settled or the overlay would come back

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

    if (loadedSlotsRef.current.has(authKey(activeSlotKey))) {
      markAuthBlocked(activeSlotKey, false);
      return;
    }

    if (authSettledRef.current.get(authKey(activeSlotKey)) === activeSlotUrl) return;

    if (lastAuthUrlRef.current !== activeSlotUrl) {
      lastAuthUrlRef.current = activeSlotUrl;
      authRetryRef.current = 0;
    }
    markAuthBlocked(activeSlotKey, false);
    const timer = setTimeout(() => {
      if (loadedSlotsRef.current.has(authKey(activeSlotKey))) return;
      if (authRetryRef.current < MAX_AUTH_RETRIES) {

        authRetryRef.current += 1;
        setRefreshKey((k) => k + 1);
        return;
      }
      authSettledRef.current.set(authKey(activeSlotKey), activeSlotUrl);
      markAuthBlocked(activeSlotKey, true);
    }, MAX_AUTH_TIMEOUT_MS);
    return () => clearTimeout(timer);

  }, [activeSlotKey, activeSlotUrl, previewSubdomainUrl, isLocalPreview, refreshKey, activeSlot?.generation]);

  // auth-gated response — never reported "loaded", and fall back to the `src`

  const previewLinkIntent = usePreviewStore((s) => s.previewLinkIntent);
  // eslint-disable-next-line no-restricted-syntax -- navigates a live iframe to an agent-authored destination
  useEffect(() => {
    if (!previewLinkIntent || !activeSlotKey || !activeSlotUrl) return;
    if (previewLinkIntent.slotKey !== activeSlotKey) return;
    if (previewLinkIntent.sessionId !== sessionId) return;

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

      // page must not be handed. A mismatch drops the message in the browser;

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

  const lastRefreshKey = useRef(refreshKey);
  // eslint-disable-next-line no-restricted-syntax -- existing usage
  useEffect(() => {
    if (refreshKey !== lastRefreshKey.current) {
      lastRefreshKey.current = refreshKey;
      if (activeSlotKey) {
        markAuthBlocked(activeSlotKey, false);
        // A manual refresh (or the auth-retry escalation) intentionally

        loadedSlotsRef.current.delete(activeSlotKey);
        authSettledRef.current.delete(activeSlotKey);
        const el = iframeRefs.current.get(activeSlotKey);

        // 502, an auth-gated response — never reported "loaded", and fall

        // escalation needs (a genuinely blocked slot must re-fetch).
        if (el?.contentWindow && reloadableWindowsRef.current.get(activeSlotKey) === el.contentWindow) {
          el.contentWindow.postMessage({ source: "shipit-toolbar", type: "reload" }, "*");
        } else if (el && activeSlotUrl) {
          el.src = activeSlotUrl;
        }
      }
    }
  }, [refreshKey, activeSlotKey, activeSlotUrl, iframeRefs]);

  // The ref holds the SLOT KEY that was waiting, never a bare boolean. A key
  // carries the session, and a boolean cannot: switching from a waiting session

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

  const lastPortLabel = useRef<string | null>(null);

  // DOM tree so the iframe element is never destroyed/recreated.
  const isRunning = !!preview?.running;
  const startupSteps = usePreviewStore((s) => s.startupSteps);

  const serviceForPort = (port: number) => services.find(s => s.port === port);

  const currentPortLabel = activePort
    ? (activeServiceState?.name ?? serviceForPort(activePort)?.name ?? (preview?.url?.startsWith("/preview/") ? `port ${activePort}` : `localhost:${activePort}`))
    : null;
  if (currentPortLabel) {
    lastPortLabel.current = currentPortLabel;
  }

  const portLabel = currentPortLabel ?? (showIframe ? lastPortLabel.current : null);

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

  if (isRunning && activeServiceState && !allPorts.some(p => p.port === activePort)) {
    allPorts.push({ port: activePort, label: activeServiceState.name, status: activeServiceState.status });
  }
  const showSelector = isRunning && (
    allPorts.length > 1
    || detectedPorts.length > 1
    || ((preview.source === "vite" || preview.source === "managed") && detectedPorts.length > 0)
  );

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

  const cannotSubdomainPreview = isContainerMode && isRunning && !!activePort && !!sessionId && previewSubdomainUrl === null;

  const suggestedWildcardHost = cannotSubdomainPreview ? suggestWildcardHost(apiHost) : null;

  // because they have the same two consequences: the slot is given

  const hideIframe = (!isRunning && !showStarting) || !paneVisible || waitingForService;

  // `iframeRefs` is a ref (stable) and `drainPendingReady` is only invoked, never
  // captured — the effect must fire on slot/visibility changes, not on either

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

  let overlayContent: React.ReactNode = null;
  if (showStartupSteps) {
    overlayContent = <StartupSteps steps={startupSteps} />;
  } else if (showComposeError) {
    overlayContent = <ComposeErrorBanner composeError={composeError} onSendToAgent={onSendCrashToAgent} />;
  } else if (showComposeHint) {
    overlayContent = <PreviewSetupInvite onSendToAgent={onSendComposeHintToAgent} />;
  } else if (waitingForService && activeServiceState) {

    const starting = activeServiceState.status === "starting";
    overlayContent = (
      <div className="text-center space-y-3 max-w-sm px-4">
        {starting
          ? <Spinner size={ICON_SIZE.MD} className="mx-auto text-(--color-accent)" />
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
        <Spinner size={ICON_SIZE.MD} className="mx-auto text-(--color-accent)" />
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

    // case is a single manual `dev` service the user must start by hand).
    const manualOnly = services.length > 0 && services.every(s => s.preview === "manual");

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

          // It navigates the frame's own entry list, never the joint session

          if (!activeSlotKey) return;
          iframeRefs.current
            .get(activeSlotKey)
            ?.contentWindow?.postMessage({ source: "shipit-toolbar", type: "back" }, "*");
        }}
        onHome={() => {

          // already at root, so this never reloads the front page for its own

          // 502, an auth-gated response — never reported "loaded", and fall

          if (!activeSlotKey || !activeSlotUrl) return;
          const el = iframeRefs.current.get(activeSlotKey);
          const rootUrl = new URL("/", activeSlotUrl).href;
          // Targeted at the slot's own origin, never `"*"` — same reasoning as

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

          // back whole except that you must tap the field to resume. The design

          // `display: none` cannot fail that way, and it drops the frame from

          // stops **audio**, which is exactly why that cooperative protocol

          const hidden = !isActive || hideIframe;

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

                  // set at an exact width (the whole point of the control) never

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
            <Spinner size={ICON_SIZE.MD} className="text-(--color-accent)" />
          </div>
        )}
        {/* Stale iframe with spinner during session switch (showStarting + old iframe still visible) */}
        {showStarting && showIframe && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/10 pointer-events-none">
            <Spinner size={ICON_SIZE.MD} className="text-(--color-accent)" />
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
