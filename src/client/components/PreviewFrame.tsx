// eslint-disable-next-line no-restricted-imports -- useEffect: poll external preview server URL until ready with cancellation (external system sync)
import { useState, useEffect, useRef } from "react";
import { WarningIcon, GearSixIcon, CircleNotchIcon, ArrowClockwiseIcon, ArrowSquareOutIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import { Button } from "./ui/button.js";
import type { PreviewError } from "../hooks/usePreviewErrors.js";
import { usePreviewStore } from "../stores/preview-store.js";
import { StartupSteps } from "./StartupSteps.js";

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
  /** Whether no preview config was found for the session. */
  configMissing?: boolean;
  /** Called when user clicks "Set up with Claude" to generate shipit.yaml. */
  onInitPreviewConfig?: () => void;
  /** Crash information when preview server exited with error. */
  crashInfo?: { exitCode: number | null; output: string } | null;
  /** Called when user clicks "Retry" to restart the preview server. */
  onRestartPreview?: () => void;
  /** Called when user clicks "Fix with Claude" to send crash info to the agent. */
  onSendCrashToAgent?: () => void;
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

export function PreviewFrame({
  preview,
  sessionId,
  detectedPorts,
  selectedPort,
  onSelectPort,
  errors,
  onSendErrors,
  onClearErrors,
  configMissing,
  onInitPreviewConfig,
  crashInfo,
  onRestartPreview,
  onSendCrashToAgent,
}: PreviewFrameProps) {
  const autoFixEnabled = usePreviewStore((s) => s.autoFixEnabled);
  const autoFixRetries = usePreviewStore((s) => s.autoFixRetries);
  const onToggleAutoFix = usePreviewStore((s) => s.toggleAutoFix);
  const [refreshKey, setRefreshKey] = useState(0);
  const [errorPanelOpen, setErrorPanelOpen] = useState(false);

  // Compute active port early so hooks can reference it (0 when not running)
  const activePort = preview?.running ? (selectedPort ?? preview.port) : 0;

  // API host for container-mode subdomain URLs (e.g. "localhost:3001")
  const apiHost = (import.meta.env.VITE_API_HOST as string | undefined) || window.location.host;

  // Derive iframe readiness from a key: when session/port/refresh changes,
  // the key changes and iframeReady becomes false *in the same render* —
  // no effect-based reset needed, which avoids a one-frame gap where the
  // iframe would briefly load the new URL before the reset fires.
  const targetKey = `${sessionId}:${activePort}:${refreshKey}`;
  const [readyForKey, setReadyForKey] = useState("");
  const iframeReady = readyForKey === targetKey;

  // For container mode, build a subdomain URL so absolute paths (/src/main.tsx)
  // resolve naturally against the preview origin without HTML rewriting.
  // Pattern: {sessionId}--{port}.{apiHostname}:{apiPort}
  // When accessed via IP (e.g. 127.0.0.1), substitute "localhost" — browsers
  // resolve *.localhost to 127.0.0.1 per spec, so subdomains work without DNS.
  const previewSubdomainUrl = preview?.url?.startsWith("/preview/") && sessionId
    ? (() => {
        const [rawHostname, apiPort] = apiHost.includes(":") ? apiHost.split(":") as [string, string] : [apiHost, ""];
        // Substitute loopback IPs with "localhost" so subdomains resolve
        const apiHostname = /^(127\.\d+\.\d+\.\d+|::1)$/.test(rawHostname) ? "localhost" : rawHostname;
        // Other IP addresses (e.g. LAN) can't use subdomains without wildcard DNS
        if (/^\d+\.\d+\.\d+\.\d+$/.test(apiHostname) || apiHostname.includes(":")) return null;
        const portSuffix = apiPort ? `:${apiPort}` : "";
        return `${window.location.protocol}//${sessionId}--${activePort}.${apiHostname}${portSuffix}/`;
      })()
    : null;

  // Container mode: poll via health-check endpoint (always 200, no console
  // errors). Local mode: poll localhost with no-cors.
  const isContainerMode = !!(preview?.url?.startsWith("/preview/"));
  const pollUrl = isContainerMode
    ? `/api/preview-health/${sessionId}/${activePort}`
    : (activePort ? `http://localhost:${activePort}` : null);

  // Poll the preview URL until it responds, then allow iframe to render.
  // Prevents showing a broken-page icon while the dev server is still starting
  // or Docker port mapping is not yet established.
  useEffect(() => {
    if (!activePort || !pollUrl || iframeReady) return;
    const state = { cancelled: false };
    const key = targetKey;
    const poll = async () => {
      for (let i = 0; i < 30 && !state.cancelled; i++) {
        try {
          if (isContainerMode) {
            const resp = await fetch(pollUrl);
            const data = await resp.json() as { ready?: boolean };
            if (data.ready) {
              if (!state.cancelled) setReadyForKey(key);
              return;
            }
          } else {
            await fetch(pollUrl, { mode: "no-cors" });
            if (!state.cancelled) setReadyForKey(key);
            return;
          }
        } catch {
          // Network error — retry
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      // Give up after ~15s — show iframe anyway
      if (!state.cancelled) setReadyForKey(key);
    };
    void poll();
    return () => { state.cancelled = true; };
  }, [activePort, pollUrl, iframeReady, isContainerMode, targetKey]);

  // ---- Persistent iframe: never unmounted, src only changes when ready ----
  // The iframe ref lets us imperatively navigate via src assignment so the
  // DOM element is preserved across session switches (no remount = no flash).
  const iframeRef = useRef<HTMLIFrameElement>(null);

  // The URL the iframe is currently displaying (or should display).
  // Updated only when polling confirms the new session's preview is reachable.
  const [displayedUrl, setDisplayedUrl] = useState<string | null>(null);

  // Compute what the new URL *would* be once ready
  const candidateUrl = preview?.running
    ? (previewSubdomainUrl ?? (preview.url?.startsWith("/preview/") ? preview.url : `http://localhost:${activePort}`))
    : null;

  // When polling confirms the new preview is reachable, commit its URL.
  // Also handle refresh: same session but refreshKey changed.
  useEffect(() => {
    if (iframeReady && candidateUrl) {
      setDisplayedUrl(candidateUrl);
    }
  }, [iframeReady, candidateUrl]);

  // --- Auth-blocked detection ---
  // When behind a reverse proxy with auth (e.g. Cloudflare Zero Trust), the
  // preview subdomain may require separate authentication. The auth redirect
  // can't render inside an iframe (frame-ancestors 'none'). Detect this by
  // waiting for a "loaded" postMessage from the preview proxy's injected
  // script. If it doesn't arrive, the iframe is likely auth-blocked.
  const [authBlocked, setAuthBlocked] = useState(false);
  const previewLoadedRef = useRef(false);

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const data = event.data as { source?: string; type?: string } | undefined;
      if (data?.source === "shipit-preview" && data?.type === "loaded") {
        previewLoadedRef.current = true;
        setAuthBlocked(false);
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, []);

  // Skip auth detection for localhost — no reverse proxy auth locally.
  // previewSubdomainUrl looks like "http://uuid--port.localhost:3001/",
  // so check the apiHost directly rather than parsing the subdomain URL.
  const isLocalPreview = /^(localhost|127\.\d+\.\d+\.\d+|::1)(:|$)/i.test(apiHost);
  useEffect(() => {
    if (!displayedUrl || !previewSubdomainUrl || isLocalPreview) return;
    previewLoadedRef.current = false;
    setAuthBlocked(false);
    const timer = setTimeout(() => {
      if (!previewLoadedRef.current) {
        setAuthBlocked(true);
      }
    }, 5000);
    return () => clearTimeout(timer);
    // refreshKey: re-run detection after user clicks Retry
  }, [displayedUrl, previewSubdomainUrl, isLocalPreview, refreshKey]);

  // Force-reload the iframe on refresh click by re-assigning the same src.
  // This avoids changing displayedUrl (which wouldn't trigger a navigation
  // for the same value) and instead uses the DOM API directly.
  const lastRefreshKey = useRef(refreshKey);
  useEffect(() => {
    if (refreshKey !== lastRefreshKey.current) {
      lastRefreshKey.current = refreshKey;
      previewLoadedRef.current = false;
      setAuthBlocked(false);
      if (iframeRef.current && displayedUrl) {
        iframeRef.current.src = displayedUrl;
      }
    }
  }, [refreshKey, displayedUrl]);

  // Whether the persistent iframe should be visible
  const showIframe = !!displayedUrl;
  // Whether we're transitioning (iframe shows old content, new session loading)
  const isTransitioning = showIframe && !iframeReady;

  // Remember the last port label so the top bar doesn't flash "Preview" during session switch
  const lastPortLabel = useRef<string | null>(null);

  // ---- Determine overlay content (replaces early returns) ----
  // By computing overlay content instead of returning early, we keep a single
  // DOM tree so the iframe element is never destroyed/recreated.
  const isRunning = !!preview?.running;
  const isManaged = isRunning && (preview.source === "vite" || preview.source === "managed") && activePort === preview.port;
  const showSelector = isRunning && (detectedPorts.length > 1 || ((preview.source === "vite" || preview.source === "managed") && detectedPorts.length > 0));

  // Compute current port label and remember it for transitions
  const currentPortLabel = isRunning
    ? (preview?.url?.startsWith("/preview/") ? `port ${activePort}` : `localhost:${activePort}`)
    : null;
  if (currentPortLabel) {
    lastPortLabel.current = currentPortLabel;
  }
  // Show last known port label during transitions (old iframe still visible)
  const portLabel = currentPortLabel ?? (showIframe ? lastPortLabel.current : null);

  // Build the list of all available ports for the selector
  const allPorts: { port: number; label: string }[] = [];
  if (isRunning && (preview.source === "vite" || preview.source === "managed")) {
    const label = preview.source === "vite" ? `${preview.port} (Vite)` : `${preview.port} (Preview)`;
    allPorts.push({ port: preview.port, label });
  }
  if (isRunning) {
    for (const p of detectedPorts) {
      if (p !== preview.port || (preview.source !== "vite" && preview.source !== "managed")) {
        allPorts.push({ port: p, label: `${p}` });
      }
    }
  }

  const hasErrors = errors.length > 0;
  const startupSteps = usePreviewStore((s) => s.startupSteps);
  const showCrash = !!(crashInfo && !preview?.running);
  const showStartupSteps = startupSteps.length > 0 && !isRunning && !showCrash;
  const showStarting = !showStartupSteps && !preview && !!sessionId;
  const showConfigMissing = !isRunning && !showCrash && !showStartupSteps && !showStarting && !!configMissing;

  // When not running, hide the iframe behind the overlay (but keep DOM element alive)
  const hideIframe = !isRunning && !showStarting;

  // Determine overlay content for the main area
  let overlayContent: React.ReactNode = null;
  if (showStartupSteps) {
    overlayContent = <StartupSteps steps={startupSteps} />;
  } else if (showCrash) {
    overlayContent = (
      <div className="text-center space-y-3 max-w-lg px-4">
        <WarningIcon size={ICON_SIZE.LG} className="mx-auto text-(--color-error)" />
        <p className="text-(--color-error) font-medium">
          Preview server crashed{crashInfo?.exitCode !== null && crashInfo?.exitCode !== undefined ? ` (exit code ${crashInfo.exitCode})` : ""}
        </p>
        {crashInfo?.output && (
          <pre className="text-left text-xs text-(--color-text-secondary) bg-(--color-bg-secondary) rounded p-3 max-h-48 overflow-auto whitespace-pre-wrap border border-(--color-border-secondary)">
            {crashInfo.output}
          </pre>
        )}
        <div className="flex items-center justify-center gap-2">
          {onRestartPreview && <Button variant="secondary" size="sm" onClick={onRestartPreview}>Retry</Button>}
          {onSendCrashToAgent && <Button variant="primary" size="sm" onClick={onSendCrashToAgent}>Fix with Claude</Button>}
        </div>
      </div>
    );
  } else if (showStarting && !showIframe) {
    overlayContent = (
      <div className="text-center space-y-3">
        <CircleNotchIcon size={ICON_SIZE.MD} className="mx-auto animate-spin text-(--color-accent)" />
        <p>Starting dev server...</p>
      </div>
    );
  } else if (authBlocked && displayedUrl) {
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
            onClick={() => window.open(displayedUrl, "_blank")}
          >
            <ArrowSquareOutIcon size={ICON_SIZE.SM} />
            Open in new tab
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setAuthBlocked(false);
              setRefreshKey((k) => k + 1);
            }}
          >
            <ArrowClockwiseIcon size={ICON_SIZE.SM} />
            Retry
          </Button>
        </div>
      </div>
    );
  } else if (showConfigMissing) {
    overlayContent = (
      <div className="text-center space-y-3">
        <GearSixIcon size={ICON_SIZE.LG} className="mx-auto text-(--color-text-tertiary)" />
        <p>No preview configuration found.</p>
        <p className="text-xs text-(--color-text-tertiary) max-w-sm">
          Create a shipit.yaml file to configure how the preview server runs, or let Claude set it up for you.
        </p>
        {onInitPreviewConfig && <Button variant="primary" size="sm" onClick={onInitPreviewConfig}>Set up with Claude</Button>}
      </div>
    );
  }

  return (
    <div className={`flex flex-col h-full ${autoFixEnabled ? "ring-2 ring-(--color-autofix) ring-inset" : ""}`}>
      {/* Top bar — always rendered for layout stability */}
      <div className="flex items-center justify-between px-3 py-1.5 bg-(--color-bg-secondary) border-b border-(--color-border-secondary) text-xs text-(--color-text-secondary)">
        <span className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${isRunning || portLabel ? "bg-(--color-success)" : "bg-(--color-text-tertiary)"}`} />
          {showSelector ? (
            <select
              value={activePort}
              onChange={(e) => onSelectPort(Number(e.target.value))}
              className="bg-(--color-bg-tertiary) text-(--color-text-primary) text-xs rounded px-1.5 py-0.5 border border-(--color-border-secondary) focus:outline-none focus:border-(--color-border-focus)"
              aria-label="Select preview port"
            >
              {allPorts.map((item) => (
                <option key={item.port} value={item.port}>
                  :{item.label}
                </option>
              ))}
            </select>
          ) : portLabel ? (
            <>
              {portLabel}
              {isRunning && !isManaged && preview.source === "detected" && (
                <span className="text-(--color-warning)">(auto-detected)</span>
              )}
            </>
          ) : (
            <span className="text-(--color-text-tertiary)">Preview</span>
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
              const url = displayedUrl ?? candidateUrl;
              if (url) window.open(url, "_blank", "noopener,noreferrer");
            }}
            title="Open preview in new tab"
            disabled={!displayedUrl && !candidateUrl}
          >
            <ArrowSquareOutIcon size={ICON_SIZE.SM} />
          </Button>
        </div>
      </div>

      {/* Main content area — iframe is always in the same DOM position */}
      <div className="flex-1 relative">
        {/* Persistent iframe — never unmounted, src only changes when new preview is ready */}
        {showIframe && (
          <iframe
            ref={iframeRef}
            src={displayedUrl}
            title="Live Preview"
            className={`absolute inset-0 w-full h-full ${hideIframe ? "invisible" : ""} ${hasErrors && errorPanelOpen ? "max-h-[60%]" : ""}`}
            {...(!isContainerMode && { sandbox: "allow-scripts allow-same-origin allow-forms allow-popups allow-modals" })}
          />
        )}
        {/* Transition overlay while polling for new session (iframe visible underneath) */}
        {isTransitioning && showIframe && !overlayContent && (
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
        {/* Spinner when no iframe has ever been shown and preview is running but polling */}
        {isRunning && !showIframe && !iframeReady && !overlayContent && (
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
