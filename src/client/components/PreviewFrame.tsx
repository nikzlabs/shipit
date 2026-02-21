import { useState, useEffect } from "react";
import type { PreviewError } from "../hooks/usePreviewErrors.js";

export interface PreviewStatus {
  running: boolean;
  port: number;
  url: string;
  /** "vite" for bundled Vite server, "managed" for command mode, "detected" for auto-detected ports. */
  source?: "vite" | "managed" | "detected";
  /** All ports found by port scanning (non-Vite dev servers). */
  detectedPorts?: number[];
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
  /** Whether no preview config was found for the session. */
  configMissing?: boolean;
  /** Install command status (running, complete, or error). */
  installStatus?: { status: "running" | "complete" | "error"; message?: string } | null;
  /** Called when user clicks "Set up with Claude" to generate shipit.yaml. */
  onInitPreviewConfig?: () => void;
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
  autoFixEnabled,
  onToggleAutoFix,
  autoFixRetries,
  configMissing,
  installStatus,
  onInitPreviewConfig,
}: PreviewFrameProps) {
  const [refreshKey, setRefreshKey] = useState(0);
  const [errorPanelOpen, setErrorPanelOpen] = useState(false);
  const [iframeReady, setIframeReady] = useState(false);

  // Compute active port early so hooks can reference it (0 when not running)
  const activePort = preview?.running ? (selectedPort ?? preview.port) : 0;

  // Reset readiness when the iframe target changes (session switch, port change, reload)
  useEffect(() => {
    setIframeReady(false);
  }, [sessionId, activePort, refreshKey]);

  // Poll the preview URL until it responds, then allow iframe to render.
  // Prevents showing a broken-page icon while the dev server is still starting
  // or Docker port mapping is not yet established.
  useEffect(() => {
    if (!activePort || iframeReady) return;
    let cancelled = false;
    const poll = async () => {
      for (let i = 0; i < 20 && !cancelled; i++) {
        try {
          await fetch(`http://localhost:${activePort}`, { mode: "no-cors" });
          if (!cancelled) setIframeReady(true);
          return;
        } catch {
          await new Promise((r) => setTimeout(r, 500));
        }
      }
      // Give up after ~10s — show iframe anyway
      if (!cancelled) setIframeReady(true);
    };
    poll();
    return () => { cancelled = true; };
  }, [activePort, iframeReady]);

  // Show install progress
  if (installStatus && installStatus.status === "running") {
    return (
      <div className="flex items-center justify-center h-full text-gray-500 text-sm">
        <div className="text-center space-y-3">
          <div className="inline-block w-6 h-6 border-2 border-gray-400 border-t-blue-500 rounded-full animate-spin" />
          <p>Installing dependencies...</p>
          <p className="text-xs text-gray-400 dark:text-gray-600">
            This may take a moment.
          </p>
        </div>
      </div>
    );
  }

  // Show install error
  if (installStatus && installStatus.status === "error") {
    return (
      <div className="flex items-center justify-center h-full text-gray-500 text-sm">
        <div className="text-center space-y-2">
          <div className="text-2xl text-red-500">!</div>
          <p className="text-red-400">Install failed</p>
          {installStatus.message && (
            <p className="text-xs text-gray-400 dark:text-gray-600 max-w-sm">
              {installStatus.message}
            </p>
          )}
          <p className="text-xs text-gray-400 dark:text-gray-600">
            Check the terminal logs for details.
          </p>
        </div>
      </div>
    );
  }

  if (!preview || !preview.running) {
    // Show config missing state with option to set up
    if (configMissing) {
      return (
        <div className="flex items-center justify-center h-full text-gray-500 text-sm">
          <div className="text-center space-y-3">
            <div className="text-2xl">&#9881;</div>
            <p>No preview configuration found.</p>
            <p className="text-xs text-gray-400 dark:text-gray-600 max-w-sm">
              Create a shipit.yaml file to configure how the preview server runs, or let Claude set it up for you.
            </p>
            {onInitPreviewConfig && (
              <button
                onClick={onInitPreviewConfig}
                className="px-3 py-1.5 rounded bg-blue-600 text-white text-xs hover:bg-blue-500 transition-colors"
              >
                Set up with Claude
              </button>
            )}
          </div>
        </div>
      );
    }

    return (
      <div className="flex items-center justify-center h-full text-gray-500 text-sm">
        <div className="text-center space-y-2">
          <div className="text-2xl">&#9654;</div>
          <p>Preview will appear here when a dev server is running.</p>
          <p className="text-xs text-gray-400 dark:text-gray-600">
            Ask the agent to create a project to get started. Vite, Express, Next.js, and other servers are auto-detected.
          </p>
        </div>
      </div>
    );
  }

  // activePort already computed above (before hooks)
  const activeUrl = `http://localhost:${activePort}`;
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
    <div className={`flex flex-col h-full ${autoFixEnabled ? "ring-2 ring-orange-500 ring-inset" : ""}`}>
      <div className="flex items-center justify-between px-3 py-1.5 bg-gray-50 dark:bg-gray-900 border-b border-gray-300 dark:border-gray-700 text-xs text-gray-500 dark:text-gray-400">
        <span className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-green-500" />
          {showSelector ? (
            <select
              value={activePort}
              onChange={(e) => onSelectPort(Number(e.target.value))}
              className="bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 text-xs rounded px-1.5 py-0.5 border border-gray-300 dark:border-gray-600 focus:outline-none focus:border-blue-500"
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
              localhost:{activePort}
              {!isManaged && preview.source === "detected" && (
                <span className="text-yellow-400">(auto-detected)</span>
              )}
            </>
          )}
        </span>
        <div className="flex items-center gap-2">
          {hasErrors && (
            <button
              onClick={() => setErrorPanelOpen((prev) => !prev)}
              className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-red-100 dark:bg-red-900/50 text-red-600 dark:text-red-400 hover:bg-red-200 dark:hover:bg-red-800/50 transition-colors"
              aria-label="Toggle error panel"
            >
              <span className="inline-flex items-center justify-center min-w-[1.1rem] h-[1.1rem] px-1 text-[10px] font-semibold rounded-full bg-red-600 text-white">
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
            <span className={`relative w-7 h-4 rounded-full transition-colors ${autoFixEnabled ? "bg-orange-500" : "bg-gray-300 dark:bg-gray-600"}`}>
              <span className={`absolute top-0.5 left-0.5 w-3 h-3 rounded-full bg-white transition-transform ${autoFixEnabled ? "translate-x-3" : ""}`} />
            </span>
            <span className={autoFixEnabled ? "text-orange-400" : ""}>
              Auto-fix{autoFixEnabled && autoFixRetries > 0 ? ` (${autoFixRetries}/3)` : ""}
            </span>
          </label>
          <button
            onClick={() => setRefreshKey((k) => k + 1)}
            className="px-2 py-0.5 rounded hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
            title="Refresh preview"
          >
            Reload
          </button>
        </div>
      </div>

      {/* Preview content: spinner until URL is reachable, then iframe */}
      {iframeReady ? (
        <iframe
          key={`${sessionId}-${activePort}-${refreshKey}`}
          src={activeUrl}
          title="Live Preview"
          className={`flex-1 w-full bg-white ${hasErrors && errorPanelOpen ? "min-h-0" : ""}`}
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
        />
      ) : (
        <div className="flex-1 flex items-center justify-center bg-white text-gray-500 text-sm">
          <div className="text-center space-y-3">
            <div className="inline-block w-6 h-6 border-2 border-gray-400 border-t-blue-500 rounded-full animate-spin" />
            <p>Starting dev server...</p>
          </div>
        </div>
      )}

      {/* Error panel */}
      {hasErrors && errorPanelOpen && (
        <div className="border-t border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-950 max-h-[40%] flex flex-col" role="region" aria-label="Preview errors">
          <div className="flex items-center justify-between px-3 py-1.5 border-b border-red-200 dark:border-red-800/50 text-xs">
            <span className="font-medium text-red-700 dark:text-red-300">
              {errors.length} error{errors.length !== 1 ? "s" : ""}
            </span>
            <div className="flex items-center gap-2">
              <button
                onClick={() => onSendErrors(errors)}
                className="px-2 py-0.5 rounded bg-blue-600 text-white hover:bg-blue-500 transition-colors"
                title="Send all errors to the agent for fixing"
              >
                Send to Agent
              </button>
              <button
                onClick={onClearErrors}
                className="px-2 py-0.5 rounded hover:bg-red-100 dark:hover:bg-red-900 text-red-600 dark:text-red-400 transition-colors"
                title="Clear all errors"
              >
                Clear
              </button>
            </div>
          </div>
          <div className="flex-1 overflow-auto p-2 space-y-2 text-xs font-mono">
            {errors.map((err) => (
              <div key={err.id} className="p-2 rounded bg-red-100 dark:bg-red-900/30 border border-red-200 dark:border-red-800/50">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="text-red-800 dark:text-red-200 font-semibold break-all">
                      {err.type === "console" && err.level && (
                        <span className={`mr-1 ${err.level === "warn" ? "text-yellow-600 dark:text-yellow-400" : ""}`}>
                          [{err.level}]
                        </span>
                      )}
                      {err.message}
                    </div>
                    {err.source && err.line && (
                      <div className="text-red-600 dark:text-red-400 mt-0.5">
                        at {err.source}:{err.line}{err.col ? `:${err.col}` : ""}
                      </div>
                    )}
                    {err.stack && (
                      <details className="mt-1">
                        <summary className="text-red-500 dark:text-red-500 cursor-pointer hover:text-red-700 dark:hover:text-red-300">
                          Stack trace
                        </summary>
                        <pre className="mt-1 text-[10px] text-red-600 dark:text-red-400 whitespace-pre-wrap break-all overflow-auto max-h-24">
                          {err.stack}
                        </pre>
                      </details>
                    )}
                  </div>
                  <button
                    onClick={() => onSendErrors([err])}
                    className="shrink-0 px-1.5 py-0.5 rounded text-blue-600 dark:text-blue-400 hover:bg-blue-100 dark:hover:bg-blue-900/30 transition-colors"
                    title="Send this error to the agent"
                  >
                    Fix
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
