// eslint-disable-next-line no-restricted-imports -- useEffect: poll external preview server URL until ready with cancellation (external system sync)
import { useState, useEffect, useRef, useCallback, useLayoutEffect } from "react";
import { WarningIcon, CircleNotchIcon, ArrowClockwiseIcon, ArrowSquareOutIcon, CaretDownIcon, CheckIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "./ui/dropdown-menu.js";
import { Button } from "./ui/button.js";
import { StatusDot } from "./ui/status-dot.js";
import type { PreviewError } from "../hooks/usePreviewErrors.js";
import { usePreviewStore } from "../stores/preview-store.js";
import { useUiStore } from "../stores/ui-store.js";
import { StartupSteps } from "./StartupSteps.js";
import { ServiceList } from "./ServiceList.js";
import { DeviceSelector } from "./DeviceSelector.js";

/** Maps known Docker/Compose error patterns to user-facing remediation hints. */
function getComposeErrorHint(error: string): string | null {
  if (error.includes("address pools have been fully subnetted")) {
    return "Your Docker host has run out of network address space. Run \"docker network prune\" to remove unused networks, then retry. To permanently increase the limit, add {\"default-address-pools\": [{\"base\": \"172.16.0.0/12\", \"size\": 24}]} to /etc/docker/daemon.json and restart Docker.";
  }
  if (error.includes("port is already allocated") || error.includes("address already in use")) {
    return "A port required by this service is already in use. Stop the conflicting process or change the port mapping in shipit.yaml, then retry.";
  }
  if (error.includes("no space left on device")) {
    return "Your Docker host is out of disk space. Run \"docker system prune\" to free space, then retry.";
  }
  if (error.includes("pull access denied") || error.includes("repository does not exist")) {
    return "Docker could not pull the required image. Check that the image name in your Dockerfile or shipit.yaml is correct and that you are logged in to the registry.";
  }
  return null;
}

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
  /** Current session ID — used in iframe key to force reload on session switch. */
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
  /** Called when user clicks "Send to agent" to ask the agent to add compose config. */
  onSendComposeHintToAgent?: () => void;
  /**
   * Called when the user clicks Start on a manual service in the inline
   * service list. Wired to the WS `start_service` message in `App.tsx`.
   * Optional so existing render sites don't have to know about it.
   */
  onStartService?: (name: string) => void;
  /** Called when the user clicks Stop on a service in the inline list. */
  onStopService?: (name: string) => void;
}

function formatErrorForMessage(errors: PreviewError[]): string {
  const lines = ["The preview is showing these errors:", ""];
  errors.forEach((err, i) => {
    lines.push(`${i + 1}. ${err.message}`);
    if (err.source && err.line) {
      lines.push(`   at ${err.source}:${err.line}${err.col ? `:${err.col}` : ""}`);
    } else if (err.stack) {
      // Take first line of stack after the message
      const stackLines = err.stack.split("\n").filter((l) => l.trim().startsWith("at "));
      if (stackLines.length > 0) {
        lines.push(`   ${stackLines[0].trim()}`);
      }
    }
    lines.push("");
  });
  lines.push("Please fix these errors.");
  return lines.join("\n");
}

export { formatErrorForMessage };

// ---- Iframe pool types ----

/** Maximum number of retained iframes across all sessions and ports. */
const MAX_IFRAME_SLOTS = 20;

interface IframeSlot {
  url: string;
  containerMode: boolean;
}

/**
 * Build a subdomain URL for container-mode previews.
 * Pattern: {sessionId}--{port}.{apiHostname}:{apiPort}
 */
function buildSubdomainUrl(sessionId: string, port: number, apiHost: string): string | null {
  const [rawHostname, apiPort] = apiHost.includes(":") ? apiHost.split(":") as [string, string] : [apiHost, ""];
  const apiHostname = /^(127\.\d+\.\d+\.\d+|::1)$/.test(rawHostname) ? "localhost" : rawHostname;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(apiHostname) || apiHostname.includes(":")) return null;
  const portSuffix = apiPort ? `:${apiPort}` : "";
  return `${window.location.protocol}//${sessionId}--${port}.${apiHostname}${portSuffix}/`;
}

/**
 * Compute the preview URL for a given session/port/preview status.
 */
function computePreviewUrl(sessionId: string, port: number, preview: PreviewStatus, apiHost: string): { url: string; containerMode: boolean } | null {
  if (!preview.running || !port) return null;
  const isContainer = preview.url?.startsWith("/preview/") ?? false;
  if (isContainer) {
    const subdomain = buildSubdomainUrl(sessionId, port, apiHost);
    const url = subdomain ?? preview.url;
    return { url, containerMode: true };
  }
  return { url: `http://localhost:${port}`, containerMode: false };
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
  onStartService,
  onStopService,
}: PreviewFrameProps) {
  const autoFixEnabled = usePreviewStore((s) => s.autoFixEnabled);
  const autoFixRetries = usePreviewStore((s) => s.autoFixRetries);
  const onToggleAutoFix = usePreviewStore((s) => s.toggleAutoFix);
  const devicePreset = usePreviewStore((s) => s.devicePreset);
  const isLandscape = usePreviewStore((s) => s.isLandscape);
  const customSize = usePreviewStore((s) => s.customSize);
  const setDevicePreset = usePreviewStore((s) => s.setDevicePreset);
  const toggleLandscape = usePreviewStore((s) => s.toggleLandscape);
  const setCustomSize = usePreviewStore((s) => s.setCustomSize);
  const [refreshKey, setRefreshKey] = useState(0);
  const [errorPanelOpen, setErrorPanelOpen] = useState(false);
  const [portSelectorOpen, setPortSelectorOpen] = useState(false);

  // ---- Device frame measurement ----
  // When a preset is active, we resize the iframe to the preset width/height
  // and scale it down with `transform: scale()` if it doesn't fit the panel.
  const deviceContainerRef = useRef<HTMLDivElement | null>(null);
  const [deviceContainerSize, setDeviceContainerSize] = useState<{ width: number; height: number }>({ width: 0, height: 0 });

  // Compute active port early so hooks can reference it (0 when not running)
  const activePort = preview?.running ? (selectedPort ?? preview.port) : 0;

  // API host for container-mode subdomain URLs (e.g. "localhost:3001")
  const apiHost = (import.meta.env.VITE_API_HOST as string | undefined) || window.location.host;

  // ---- Iframe pool: one iframe per (session, port) ----
  // Slots are keyed by "sessionId:port". Only the active slot is visible.
  // Background slots keep their iframes alive in the DOM.
  const [slots, setSlots] = useState<Map<string, IframeSlot>>(new Map());
  const [slotOrder, setSlotOrder] = useState<string[]>([]); // LRU, most recent first
  const iframeRefs = useRef<Map<string, HTMLIFrameElement | null>>(new Map());

  const activeSlotKey = activePort ? `${sessionId ?? "_"}:${activePort}` : null;
  const activeSlot = activeSlotKey ? slots.get(activeSlotKey) ?? null : null;

  // Container mode detection for the current preview
  const isContainerMode = !!(preview?.url?.startsWith("/preview/"));

  // Track which slot keys have been created (ref to avoid effect deps on slots state)
  const createdSlotsRef = useRef<Set<string>>(new Set());
  // Track which slots are currently being polled (to avoid duplicate polls)
  const pollingRef = useRef<Set<string>>(new Set());

  // Promote a key to the front of the LRU and evict if over capacity.
  const promoteSlot = useCallback((key: string) => {
    setSlotOrder((prev) => {
      const without = prev.filter((k) => k !== key);
      const next = [key, ...without];
      // Evict oldest slots beyond the cap
      if (next.length > MAX_IFRAME_SLOTS) {
        const evicted = next.slice(MAX_IFRAME_SLOTS);
        setSlots((s) => {
          const updated = new Map(s);
          for (const k of evicted) {
            updated.delete(k);
            iframeRefs.current.delete(k);
            createdSlotsRef.current.delete(k);
          }
          return updated;
        });
        return next.slice(0, MAX_IFRAME_SLOTS);
      }
      return next;
    });
  }, []);

  // Compute poll URL for the active slot
  const pollUrl = isContainerMode && sessionId
    ? `/api/preview-health/${sessionId}/${activePort}`
    : (activePort ? `http://localhost:${activePort}` : null);

  // Poll and create/update the active slot when session/port changes.
  // eslint-disable-next-line no-restricted-syntax -- existing usage
  useEffect(() => {
    if (!activeSlotKey || !activePort || !preview?.running || !pollUrl) return;

    // If slot already exists (previously visited), just promote it
    if (createdSlotsRef.current.has(activeSlotKey)) {
      promoteSlot(activeSlotKey);
      return;
    }

    // Prevent duplicate polls for the same key
    if (pollingRef.current.has(activeSlotKey)) return;
    pollingRef.current.add(activeSlotKey);

    const state = { cancelled: false };
    const key = activeSlotKey;

    const poll = async () => {
      for (let i = 0; i < 30 && !state.cancelled; i++) {
        try {
          if (isContainerMode) {
            const resp = await fetch(pollUrl);
            const data = await resp.json() as { ready?: boolean };
            if (data.ready) break;
          } else {
            await fetch(pollUrl, { mode: "no-cors" });
            break;
          }
        } catch {
          // Network error — retry
        }
        await new Promise((r) => setTimeout(r, 500));
      }

      pollingRef.current.delete(key);
      if (state.cancelled) return;

      // Compute the URL and add the slot
      const result = computePreviewUrl(sessionId ?? "_", activePort, preview, apiHost);
      if (result) {
        createdSlotsRef.current.add(key);
        setSlots((prev) => {
          const updated = new Map(prev);
          updated.set(key, { url: result.url, containerMode: result.containerMode });
          return updated;
        });
        promoteSlot(key);
      }
    };
    void poll();
    return () => {
      state.cancelled = true;
      pollingRef.current.delete(key);
    };
  }, [activeSlotKey, activePort, sessionId, preview?.running, preview?.url, pollUrl, isContainerMode, apiHost, promoteSlot]);

  // Derive active slot state for overlay/UI logic
  const activeSlotUrl = activeSlot?.url ?? null;
  const showIframe = slotOrder.length > 0;
  const activeSlotReady = !!activeSlot;
  const isTransitioning = !activeSlotReady && activePort > 0 && preview?.running && showIframe;

  // --- Auth-blocked detection ---
  // The injected script (see preview-proxy.ts HMR_WS_PATCH) posts a "loaded"
  // message when the iframe finishes parsing the response HTML. If no message
  // arrives within MAX_AUTH_TIMEOUT_MS, we suspect the preview is auth-gated
  // (e.g. Cloudflare Zero Trust) — but slow dev-server boots and missed
  // postMessages on revisited iframe slots also produce false positives.
  // To avoid showing the auth overlay for those transient cases, we silently
  // retry a few times by bumping refreshKey (which force-reloads the iframe)
  // before surfacing the overlay.
  const [authBlocked, setAuthBlocked] = useState(false);
  const previewLoadedRef = useRef(false);
  const authRetryRef = useRef(0);
  const lastAuthUrlRef = useRef<string | null>(null);
  const MAX_AUTH_TIMEOUT_MS = 5000;
  const MAX_AUTH_RETRIES = 2;

  // eslint-disable-next-line no-restricted-syntax -- existing usage
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const data = event.data as { source?: string; type?: string } | undefined;
      if (data?.source === "shipit-preview" && data?.type === "loaded") {
        previewLoadedRef.current = true;
        authRetryRef.current = 0;
        setAuthBlocked(false);
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, []);

  const isLocalPreview = /^(localhost|127\.\d+\.\d+\.\d+|::1)(:|$)/i.test(apiHost);
  const previewSubdomainUrl = isContainerMode && sessionId ? buildSubdomainUrl(sessionId, activePort, apiHost) : null;

  // eslint-disable-next-line no-restricted-syntax -- existing usage
  useEffect(() => {
    if (!activeSlotUrl || !previewSubdomainUrl || isLocalPreview) return;
    // Reset the retry budget when the user navigates to a different preview URL.
    // refreshKey changes (manual or auto retry) keep the existing budget.
    if (lastAuthUrlRef.current !== activeSlotUrl) {
      lastAuthUrlRef.current = activeSlotUrl;
      authRetryRef.current = 0;
    }
    previewLoadedRef.current = false;
    setAuthBlocked(false);
    const timer = setTimeout(() => {
      if (previewLoadedRef.current) return;
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
  }, [activeSlotUrl, previewSubdomainUrl, isLocalPreview, refreshKey]);

  // Force-reload the active iframe on refresh click
  const lastRefreshKey = useRef(refreshKey);
  // eslint-disable-next-line no-restricted-syntax -- existing usage
  useEffect(() => {
    if (refreshKey !== lastRefreshKey.current) {
      lastRefreshKey.current = refreshKey;
      previewLoadedRef.current = false;
      setAuthBlocked(false);
      if (activeSlotKey) {
        const el = iframeRefs.current.get(activeSlotKey);
        if (el && activeSlotUrl) {
          el.src = activeSlotUrl;
        }
      }
    }
  }, [refreshKey, activeSlotKey, activeSlotUrl]);

  // Remember the last port label so the top bar doesn't flash "Preview" during session switch
  const lastPortLabel = useRef<string | null>(null);

  // Observe device container size to compute scale-to-fit when a preset is active.
  useLayoutEffect(() => {
    const el = deviceContainerRef.current;
    if (!el) return;
    const update = () => {
      setDeviceContainerSize({ width: el.clientWidth, height: el.clientHeight });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [devicePreset, isLandscape, customSize]);

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
  const allPorts: { port: number; label: string; status: "running" | "starting" | "error" | "stopped" }[] = [];
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

  const statusToDotVariant = (status: string): "success" | "warning" | "error" | "info" => {
    switch (status) {
      case "running": return "success";
      case "starting": return "warning";
      case "error": return "error";
      default: return "info";
    }
  };

  // ---- Device frame metrics ----
  // Only applied when a preset (or custom size) is active. Otherwise the iframe fills the panel.
  const DEVICE_PADDING = 16;
  const activeSize = devicePreset
    ? (devicePreset.category === "custom" && customSize
      ? { width: customSize.width, height: customSize.height }
      : { width: devicePreset.width, height: devicePreset.height })
    : null;
  const deviceWidth = activeSize ? (isLandscape ? activeSize.height : activeSize.width) : 0;
  const deviceHeight = activeSize ? (isLandscape ? activeSize.width : activeSize.height) : 0;
  const deviceScale = (() => {
    if (!activeSize || deviceContainerSize.width === 0 || deviceContainerSize.height === 0) return 1;
    const availableWidth = Math.max(0, deviceContainerSize.width - DEVICE_PADDING * 2);
    const availableHeight = Math.max(0, deviceContainerSize.height - DEVICE_PADDING * 2);
    return Math.min(1, availableWidth / deviceWidth, availableHeight / deviceHeight);
  })();
  const deviceScalePercent = Math.round(deviceScale * 100);
  const deviceFrameActive = !!activeSize;
  const activeStatus = allPorts.find(p => p.port === activePort)?.status ?? (isRunning ? "running" : "stopped");

  const hasErrors = errors.length > 0;
  const composeError = usePreviewStore((s) => s.composeError);
  const composeNotConfigured = usePreviewStore((s) => s.composeNotConfigured);
  const showComposeError = !!composeError && !isRunning;
  const showComposeHint = composeNotConfigured && !isRunning && !showComposeError;
  const showStartupSteps = startupSteps.length > 0 && !isRunning && !showComposeError && !showComposeHint;
  const showStarting = !showStartupSteps && !showComposeError && !showComposeHint && !preview && !!sessionId;
  const showServices = services.length > 0 && !isRunning && !showComposeError && !showStartupSteps && !showComposeHint;

  // When not running, hide the iframe behind the overlay (but keep DOM element alive)
  const hideIframe = !isRunning && !showStarting;

  // Determine overlay content for the main area
  let overlayContent: React.ReactNode = null;
  if (showStartupSteps) {
    overlayContent = <StartupSteps steps={startupSteps} />;
  } else if (showComposeError) {
    const hint = getComposeErrorHint(composeError);
    overlayContent = (
      <div className="text-center space-y-3 max-w-lg px-4">
        <WarningIcon size={ICON_SIZE.LG} className="mx-auto text-(--color-error)" />
        <p className="text-(--color-error) font-medium">Docker Compose error</p>
        <pre className="text-left text-xs text-(--color-text-secondary) bg-(--color-bg-secondary) rounded p-3 max-h-48 overflow-auto whitespace-pre-wrap border border-(--color-border-secondary)">
          {composeError}
        </pre>
        {hint && (
          <p className="text-left text-xs text-(--color-text-secondary) bg-(--color-warning)/10 rounded p-3 border border-(--color-warning)/25">
            {hint}
          </p>
        )}
        {onSendCrashToAgent && <Button variant="primary" size="sm" onClick={onSendCrashToAgent}>Send to agent</Button>}
      </div>
    );
  } else if (showComposeHint) {
    overlayContent = (
      <div className="text-center space-y-3 max-w-lg px-4">
        <p className="text-sm text-(--color-text-secondary)">
          Add <code className="px-1.5 py-0.5 rounded bg-(--color-bg-secondary) text-(--color-text-primary) text-xs">compose</code> to <code className="px-1.5 py-0.5 rounded bg-(--color-bg-secondary) text-(--color-text-primary) text-xs">shipit.yaml</code> to enable previews
        </p>
        {onSendComposeHintToAgent && <Button variant="primary" size="sm" onClick={onSendComposeHintToAgent}>Send to agent</Button>}
      </div>
    );
  } else if (showStarting && !showIframe) {
    overlayContent = (
      <div className="text-center space-y-3">
        <CircleNotchIcon size={ICON_SIZE.MD} className="mx-auto animate-spin text-(--color-accent)" />
        <p>Starting dev server...</p>
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
            size="sm"
            onClick={() => window.open(activeSlotUrl, "_blank")}
          >
            <ArrowSquareOutIcon size={ICON_SIZE.SM} />
            Open in new tab
          </Button>
          <Button
            variant="secondary"
            size="sm"
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
    // When the entire compose stack is manual (no auto services declared),
    // surface the service list inline with Start/Stop buttons so the user
    // doesn't have to bounce to the Services tab to launch a preview. This
    // is the dogfooding case (a single `dev` service marked manual) and any
    // future "infra-only" projects. When auto services exist, we keep the
    // simpler "View service logs" overlay because the preview is expected
    // to come up on its own and the inline list would just be noise.
    const manualOnly = services.length > 0 && services.every(s => s.preview === "manual");
    if (manualOnly && onStartService && onStopService) {
      overlayContent = (
        <div className="space-y-3 px-6 max-w-md w-full">
          <p className="text-sm text-(--color-text-secondary) text-center">
            No preview running. Start a service to launch it.
          </p>
          <ServiceList
            services={services}
            onStart={onStartService}
            onStop={onStopService}
            onSelectPreview={() => { /* preview auto-pivots when the service comes up */ }}
          />
          <div className="text-center">
            <Button variant="ghost" size="sm" onClick={() => useUiStore.getState().setRightTab("services")}>
              View logs
            </Button>
          </div>
        </div>
      );
    } else {
      overlayContent = (
        <div className="text-center space-y-3">
          <WarningIcon size={ICON_SIZE.LG} className="mx-auto text-(--color-text-tertiary)" />
          <p className="text-sm text-(--color-text-secondary)">No preview running</p>
          <Button variant="secondary" size="sm" onClick={() => useUiStore.getState().setRightTab("services")}>
            View service logs
          </Button>
        </div>
      );
    }
  }

  return (
    <div className={`flex flex-col h-full ${autoFixEnabled ? "ring-2 ring-(--color-autofix) ring-inset" : ""}`}>
      {/* Top bar — always rendered for layout stability */}
      <div className="flex items-center justify-between px-3 py-1.5 bg-(--color-bg-secondary) border-b border-(--color-border-secondary) text-xs text-(--color-text-secondary)">
        <span className="flex items-center gap-2">
          {showSelector ? (
            <DropdownMenu open={portSelectorOpen} onOpenChange={setPortSelectorOpen}>
              <DropdownMenuTrigger asChild>
                <button
                  className="flex items-center gap-1.5 text-(--color-text-primary) hover:text-(--color-text-secondary) transition-colors cursor-pointer"
                  aria-label="Select preview port"
                >
                  <StatusDot status={statusToDotVariant(activeStatus)} />
                  <span>{portLabel}</span>
                  <CaretDownIcon size={ICON_SIZE.XS} />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="min-w-35">
                {allPorts.map((item) => {
                  const isActive = item.port === activePort;
                  return (
                    <DropdownMenuItem
                      key={item.port}
                      onSelect={() => onSelectPort(item.port)}
                      className={`text-xs ${
                        isActive
                          ? "text-(--color-text-primary) bg-(--color-bg-hover)"
                          : "text-(--color-text-secondary)"
                      }`}
                    >
                      <StatusDot status={statusToDotVariant(item.status)} />
                      <span className="flex-1">{item.label}</span>
                      {isActive && <CheckIcon size={ICON_SIZE.XS} className="text-(--color-success)" />}
                    </DropdownMenuItem>
                  );
                })}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <>
              <StatusDot status={isRunning || portLabel ? "success" : "info"} />
              {portLabel ? portLabel : <span className="text-(--color-text-tertiary)">Preview</span>}
            </>
          )}
          {isRunning && (
            <>
              <span className="text-(--color-border-secondary)">|</span>
              <DeviceSelector
                activePreset={devicePreset}
                isLandscape={isLandscape}
                customSize={customSize}
                onSelectPreset={(preset) => {
                  setDevicePreset(preset);
                  if (!preset) setCustomSize(null);
                }}
                onToggleLandscape={toggleLandscape}
                onCustomSize={(width, height) => {
                  setCustomSize({ width, height });
                  setDevicePreset({
                    id: "custom",
                    label: `${width}×${height}`,
                    width,
                    height,
                    category: "custom",
                  });
                }}
              />
              {deviceFrameActive && (
                <span className="text-(--color-text-tertiary) tabular-nums">
                  {deviceWidth}×{deviceHeight}
                  {deviceScale < 1 && (
                    <span className="ml-1 text-(--color-text-tertiary)">({deviceScalePercent}%)</span>
                  )}
                </span>
              )}
            </>
          )}
        </span>
        <div className="flex items-center gap-2">
          {hasErrors && (
            <button
              onClick={() => setErrorPanelOpen((prev) => !prev)}
              className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-(--color-error-subtle) text-(--color-error) hover:bg-(--color-bg-hover) transition-colors"
              aria-label="Toggle error panel"
            >
              <span className="inline-flex items-center justify-center min-w-[1.1rem] h-[1.1rem] px-1 text-[10px] font-semibold rounded-full bg-(--color-error) text-(--color-accent-text)">
                {errors.length > 99 ? "99+" : errors.length}
              </span>
              <span>{errorPanelOpen ? "Hide" : "Errors"}</span>
            </button>
          )}
          <label className="flex items-center gap-1 cursor-pointer select-none" title="Auto-fix: automatically send errors to the agent for fixing">
            <input
              type="checkbox"
              checked={autoFixEnabled}
              onChange={onToggleAutoFix}
              className="sr-only peer"
            />
            <span className={`relative w-7 h-4 rounded-full transition-colors ${autoFixEnabled ? "bg-(--color-autofix)" : "bg-(--color-border-secondary)"}`}>
              <span className={`absolute top-0.5 left-0.5 w-3 h-3 rounded-full bg-white transition-transform ${autoFixEnabled ? "translate-x-3" : ""}`} />
            </span>
            <span className={autoFixEnabled ? "text-(--color-autofix)" : ""}>
              Auto-fix{autoFixEnabled && autoFixRetries > 0 ? ` (${autoFixRetries}/3)` : ""}
            </span>
          </label>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setRefreshKey((k) => k + 1)}
            title="Refresh preview"
          >
            <ArrowClockwiseIcon size={ICON_SIZE.SM} />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              if (activeSlotUrl) window.open(activeSlotUrl, "_blank", "noopener,noreferrer");
            }}
            title="Open preview in new tab"
            disabled={!activeSlotUrl}
          >
            <ArrowSquareOutIcon size={ICON_SIZE.SM} />
          </Button>
        </div>
      </div>

      {/* Missing-required-secrets banner (087 Phase 2). One row at the top of
          the panel that links to the Secrets settings tab. Only shown when at
          least one declared secret is `required: true` and has no value. */}
      <SecretsMissingBanner />

      {/* Main content area — iframe pool, one per (session, port) */}
      <div
        ref={deviceContainerRef}
        className={`flex-1 relative ${deviceFrameActive ? "bg-(--color-bg-tertiary) overflow-hidden" : ""}`}
      >
        {/* Persistent iframes — each (session, port) gets its own iframe, hidden via CSS when not active */}
        {slotOrder.map((key) => {
          const slot = slots.get(key);
          if (!slot) return null;
          const isActive = key === activeSlotKey;
          const hidden = !isActive || hideIframe;
          // When a device preset is active, give the active iframe explicit dimensions
          // and center it in the panel with a scale transform.
          const useDeviceFrame = isActive && deviceFrameActive;
          const deviceFrameStyle: React.CSSProperties | undefined = useDeviceFrame
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
                useDeviceFrame
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
        {/* Spinner when no iframe exists for this session/port and preview is running but polling */}
        {isRunning && !activeSlotReady && !overlayContent && (
          <div className="absolute inset-0 flex items-center justify-center bg-(--color-bg-primary) text-(--color-text-secondary) text-sm">
            <div className="text-center space-y-3">
              <CircleNotchIcon size={ICON_SIZE.MD} className="mx-auto animate-spin text-(--color-accent)" />
              <p>Starting dev server...</p>
            </div>
          </div>
        )}
      </div>

      {/* Error panel */}
      {hasErrors && errorPanelOpen && (
        <div className="border-t border-(--color-error) bg-(--color-error-subtle) max-h-[40%] flex flex-col" role="region" aria-label="Preview errors">
          <div className="flex items-center justify-between px-3 py-1.5 border-b border-(--color-error) text-xs">
            <span className="font-medium text-(--color-error)">
              {errors.length} error{errors.length !== 1 ? "s" : ""}
            </span>
            <div className="flex items-center gap-2">
              <Button
                variant="primary"
                size="sm"
                onClick={() => onSendErrors(errors)}
                title="Send all errors to the agent for fixing"
              >
                Send to Agent
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={onClearErrors}
                className="text-(--color-error)"
                title="Clear all errors"
              >
                Clear
              </Button>
            </div>
          </div>
          <div className="flex-1 overflow-auto p-2 space-y-2 text-xs font-mono">
            {errors.map((err) => (
              <div key={err.id} className="p-2 rounded bg-(--color-error-subtle) border border-(--color-error)">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="text-(--color-text-primary) font-semibold break-all">
                      {err.type === "console" && err.level && (
                        <span className={`mr-1 ${err.level === "warn" ? "text-(--color-warning)" : ""}`}>
                          [{err.level}]
                        </span>
                      )}
                      {err.message}
                    </div>
                    {err.source && err.line && (
                      <div className="text-(--color-error) mt-0.5">
                        at {err.source}:{err.line}{err.col ? `:${err.col}` : ""}
                      </div>
                    )}
                    {err.stack && (
                      <details className="mt-1">
                        <summary className="text-(--color-error) cursor-pointer hover:text-(--color-text-primary)">
                          Stack trace
                        </summary>
                        <pre className="mt-1 text-[10px] text-(--color-error) whitespace-pre-wrap break-all overflow-auto max-h-24">
                          {err.stack}
                        </pre>
                      </details>
                    )}
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => onSendErrors([err])}
                    className="shrink-0 text-(--color-text-link)"
                    title="Send this error to the agent"
                  >
                    Fix
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Banner shown above the preview when one or more `required: true` secrets
 * declared in the compose file have no configured value. Clicking the
 * "Configure" button opens the Secrets settings tab so the user can fill
 * them in without leaving the preview pane.
 *
 * The banner reads from the live `secrets_status` snapshot in preview-store —
 * when the user saves, the orchestrator emits a fresh snapshot with empty
 * `missingRequired` and the banner disappears automatically.
 */
function SecretsMissingBanner() {
  const missingRequired = usePreviewStore((s) => s.secrets.missingRequired);
  const setSettingsOpen = useUiStore((s) => s.setSettingsOpen);
  const setSettingsTab = useUiStore((s) => s.setSettingsTab);
  if (missingRequired.length === 0) return null;

  const label = missingRequired.length === 1
    ? `${missingRequired[0]} is required`
    : `${missingRequired.length} required secrets are missing`;

  const openSecrets = () => {
    setSettingsTab("secrets");
    setSettingsOpen(true);
  };

  return (
    <div
      role="alert"
      className="flex items-center gap-2 px-3 py-1.5 border-b border-(--color-warning)/40 bg-(--color-warning)/10 text-xs text-(--color-text-primary)"
      data-testid="secrets-missing-banner"
    >
      <WarningIcon size={ICON_SIZE.SM} className="text-(--color-warning) shrink-0" />
      <span className="flex-1 truncate">
        {label}
        <span className="ml-1 text-(--color-text-secondary)">— this project needs secrets to run.</span>
      </span>
      <Button variant="primary" size="sm" onClick={openSecrets} data-testid="secrets-missing-configure">
        Configure
      </Button>
    </div>
  );
}
