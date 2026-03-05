import { useState, useEffect } from "react";
import { WarningIcon, GearSixIcon, PlayIcon, CircleNotchIcon, ArrowClockwiseIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import { Button } from "./ui/button.js";
import type { PreviewError } from "../hooks/usePreviewErrors.js";

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
  /** Whether auto-fix is enabled. */
  autoFixEnabled: boolean;
  /** Called to toggle auto-fix. */
  onToggleAutoFix: () => void;
  /** Current auto-fix retry count (for display). */
  autoFixRetries: number;
  /** Show loading spinner even without a sessionId (e.g. during session claim). */
  loading?: boolean;
  /** Whether no preview config was found for the session. */
  configMissing?: boolean;
  /** Install command status (running, complete, or error). */
  installStatus?: { status: "running" | "complete" | "error"; message?: string } | null;
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
  loading,
  detectedPorts,
  selectedPort,
  onSelectPort,
  errors,
  onSendErrors,
  onClearErrors,
  autoFixEnabled,
  onToggleAutoFix,
  autoFixRetries,
  configMissing,
  installStatus,
  onInitPreviewConfig,
  crashInfo,
  onRestartPreview,
  onSendCrashToAgent,
}: PreviewFrameProps) {
  const [refreshKey, setRefreshKey] = useState(0);
  const [errorPanelOpen, setErrorPanelOpen] = useState(false);

  // Compute active port early so hooks can reference it (0 when not running)
  const activePort = preview?.running ? (selectedPort ?? preview.port) : 0;

  // API host for container-mode subdomain URLs (e.g. "localhost:3001")
  const apiHost = import.meta.env.VITE_API_HOST || window.location.host;

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
        const [rawHostname, apiPort] = apiHost.includes(":") ? apiHost.split(":") : [apiHost, ""];
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
    let cancelled = false;
    const key = targetKey;
    const poll = async () => {
      for (let i = 0; i < 30 && !cancelled; i++) {
        try {
          if (isContainerMode) {
            const resp = await fetch(pollUrl);
            const data = await resp.json();
            if (data.ready) {
              if (!cancelled) setReadyForKey(key);
              return;
            }
          } else {
            await fetch(pollUrl, { mode: "no-cors" });
            if (!cancelled) setReadyForKey(key);
            return;
          }
        } catch {
          // Network error — retry
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      // Give up after ~15s — show iframe anyway
      if (!cancelled) setReadyForKey(key);
    };
    poll();
    return () => { cancelled = true; };
  }, [activePort, pollUrl, iframeReady, isContainerMode, targetKey]);

  // Show install progress
  if (installStatus && installStatus.status === "running") {
    return (
      <div className="flex items-center justify-center h-full text-(--color-text-secondary) text-sm">
        <div className="text-center space-y-3">
          <CircleNotchIcon size={ICON_SIZE.MD} className="mx-auto animate-spin text-(--color-accent)" />
          <p>Installing dependencies...</p>
          <p className="text-xs text-(--color-text-tertiary)">
            This may take a moment.
          </p>
        </div>
      </div>
    );
  }

  // Show install error
  if (installStatus && installStatus.status === "error") {
    return (
      <div className="flex items-center justify-center h-full text-(--color-text-secondary) text-sm">
        <div className="text-center space-y-2">
          <WarningIcon size={ICON_SIZE.LG} className="mx-auto text-(--color-error)" />
          <p className="text-(--color-error)">Install failed</p>
          {installStatus.message && (
            <p className="text-xs text-(--color-text-tertiary) max-w-sm">
              {installStatus.message}
            </p>
          )}
          <p className="text-xs text-(--color-text-tertiary)">
            Check the terminal logs for details.
          </p>
        </div>
      </div>
    );
  }

  // Show crash state when preview server exited with error
  if (crashInfo && (!preview || !preview.running)) {
    return (
      <div className="flex items-center justify-center h-full text-(--color-text-secondary) text-sm">
        <div className="text-center space-y-3 max-w-lg px-4">
          <WarningIcon size={ICON_SIZE.LG} className="mx-auto text-(--color-error)" />
          <p className="text-(--color-error) font-medium">
            Preview server crashed{crashInfo.exitCode != null ? ` (exit code ${crashInfo.exitCode})` : ""}
          </p>
          {crashInfo.output && (
            <pre className="text-left text-xs text-(--color-text-secondary) bg-(--color-bg-secondary) rounded p-3 max-h-48 overflow-auto whitespace-pre-wrap border border-(--color-border-secondary)">
              {crashInfo.output}
            </pre>
          )}
          <div className="flex items-center justify-center gap-2">
            {onRestartPreview && (
              <Button
                variant="secondary"
                size="sm"
                onClick={onRestartPreview}
              >
                Retry
              </Button>
            )}
            {onSendCrashToAgent && (
              <Button
                variant="primary"
                size="sm"
                onClick={onSendCrashToAgent}
              >
                Fix with Claude
              </Button>
            )}
          </div>
        </div>
      </div>
    );
  }

  if (!preview || !preview.running) {
    // No status received yet but a session is active — the preview server is
    // starting up.  Show a spinner instead of the static placeholder so the
    // user doesn't think nothing is happening.
    if (!preview && (sessionId || loading)) {
      return (
        <div className="flex items-center justify-center h-full text-(--color-text-secondary) text-sm">
          <div className="text-center space-y-3">
            <CircleNotchIcon size={ICON_SIZE.MD} className="mx-auto animate-spin text-(--color-accent)" />
            <p>Starting dev server...</p>
          </div>
        </div>
      );
    }

    // Show config missing state with option to set up
    if (configMissing) {
      return (
        <div className="flex items-center justify-center h-full text-(--color-text-secondary) text-sm">
          <div className="text-center space-y-3">
            <GearSixIcon size={ICON_SIZE.LG} className="mx-auto text-(--color-text-tertiary)" />
            <p>No preview configuration found.</p>
            <p className="text-xs text-(--color-text-tertiary) max-w-sm">
              Create a shipit.yaml file to configure how the preview server runs, or let Claude set it up for you.
            </p>
            {onInitPreviewConfig && (
              <Button
                variant="primary"
                size="sm"
                onClick={onInitPreviewConfig}
              >
                Set up with Claude
              </Button>
            )}
          </div>
        </div>
      );
    }

    return (
      <div className="flex items-center justify-center h-full text-(--color-text-secondary) text-sm">
        <div className="text-center space-y-2">
          <PlayIcon size={ICON_SIZE.LG} className="mx-auto text-(--color-text-tertiary)" />
          <p>Preview will appear here when a dev server is running.</p>
          <p className="text-xs text-(--color-text-tertiary)">
            Ask the agent to create a project to get started. Vite, Express, Next.js, and other servers are auto-detected.
          </p>
        </div>
      </div>
    );
  }

  // Build the preview URL. Subdomain URL is ideal (absolute paths resolve
  // naturally). When unavailable (IP-based access), fall back to the path-based
  // proxy URL. Local mode (no container) uses localhost directly.
  const activeUrl = previewSubdomainUrl
    ?? (preview?.url?.startsWith("/preview/") ? `${preview.url}` : `http://localhost:${activePort}`);
  const isManaged = (preview.source === "vite" || preview.source === "managed") && activePort === preview.port;
  const showSelector = detectedPorts.length > 1 || ((preview.source === "vite" || preview.source === "managed") && detectedPorts.length > 0);

  // Build the list of all available ports for the selector
  const allPorts: { port: number; label: string }[] = [];
  if (preview.source === "vite" || preview.source === "managed") {
    const label = preview.source === "vite" ? `${preview.port} (Vite)` : `${preview.port} (Preview)`;
    allPorts.push({ port: preview.port, label });
  }
  for (const p of detectedPorts) {
    if (p !== preview.port || (preview.source !== "vite" && preview.source !== "managed")) {
      allPorts.push({ port: p, label: `${p}` });
    }
  }

  const hasErrors = errors.length > 0;

  return (
    <div className={`flex flex-col h-full ${autoFixEnabled ? "ring-2 ring-(--color-autofix) ring-inset" : ""}`}>
      <div className="flex items-center justify-between px-3 py-1.5 bg-(--color-bg-secondary) border-b border-(--color-border-secondary) text-xs text-(--color-text-secondary)">
        <span className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-(--color-success)" />
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
          ) : (
            <>
              {preview?.url?.startsWith("/preview/") ? `port ${activePort}` : `localhost:${activePort}`}
              {!isManaged && preview.source === "detected" && (
                <span className="text-(--color-warning)">(auto-detected)</span>
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
        </div>
      </div>

      {/* Preview content: spinner until URL is reachable, then iframe */}
      {iframeReady ? (
        <iframe
          key={`${sessionId}-${activePort}-${refreshKey}`}
          src={activeUrl}
          title="Live Preview"
          className={`flex-1 w-full bg-white ${hasErrors && errorPanelOpen ? "min-h-0" : ""}`}
          // In container mode the iframe loads from a subdomain of our own proxy,
          // so sandbox is unnecessary and actually breaks cross-origin framing.
          // In local mode (dev server on host), sandbox restricts the iframe.
          {...(!isContainerMode && { sandbox: "allow-scripts allow-same-origin allow-forms allow-popups allow-modals" })}
        />
      ) : (
        <div className="flex-1 flex items-center justify-center bg-white text-(--color-text-secondary) text-sm">
          <div className="text-center space-y-3">
            <CircleNotchIcon size={ICON_SIZE.MD} className="mx-auto animate-spin text-(--color-accent)" />
            <p>Starting dev server...</p>
          </div>
        </div>
      )}

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
