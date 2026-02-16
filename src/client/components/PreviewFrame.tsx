import { useState } from "react";
import type { PreviewError } from "../hooks/usePreviewErrors.js";

export interface PreviewStatus {
  running: boolean;
  port: number;
  url: string;
  /** "vite" for the managed Vite server, "detected" for auto-detected ports. */
  source?: "vite" | "detected";
  /** All ports found by port scanning (non-Vite dev servers). */
  detectedPorts?: number[];
}

interface PreviewFrameProps {
  preview: PreviewStatus | null;
  /** All detected ports available for selection. */
  detectedPorts: number[];
  /** The currently selected port override, or null to use the default. */
  selectedPort: number | null;
  /** Called when the user selects a different port. */
  onSelectPort: (port: number) => void;
  /** Captured preview errors from the iframe. */
  errors: PreviewError[];
  /** Called when user clicks "Send to Claude" to fix errors. */
  onSendErrors: (errors: PreviewError[]) => void;
  /** Called to clear all errors. */
  onClearErrors: () => void;
  /** Whether auto-fix is enabled. */
  autoFixEnabled: boolean;
  /** Called to toggle auto-fix. */
  onToggleAutoFix: () => void;
  /** Current auto-fix retry count (for display). */
  autoFixRetries: number;
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
  detectedPorts,
  selectedPort,
  onSelectPort,
  errors,
  onSendErrors,
  onClearErrors,
  autoFixEnabled,
  onToggleAutoFix,
  autoFixRetries,
}: PreviewFrameProps) {
  const [refreshKey, setRefreshKey] = useState(0);
  const [errorPanelOpen, setErrorPanelOpen] = useState(false);

  if (!preview || !preview.running) {
    return (
      <div className="flex items-center justify-center h-full text-gray-500 text-sm">
        <div className="text-center space-y-2">
          <div className="text-2xl">&#9654;</div>
          <p>Preview will appear here when a dev server is running in /workspace.</p>
          <p className="text-xs text-gray-400 dark:text-gray-600">
            Ask Claude to create a project to get started. Vite, Express, Next.js, and other servers are auto-detected.
          </p>
        </div>
      </div>
    );
  }

  // The active port: user selection takes priority, then the server default
  const activePort = selectedPort ?? preview.port;
  const activeUrl = `http://localhost:${activePort}`;
  const isVite = preview.source === "vite" && activePort === preview.port;
  const showSelector = detectedPorts.length > 1 || (preview.source === "vite" && detectedPorts.length > 0);

  // Build the list of all available ports for the selector
  const allPorts: { port: number; label: string }[] = [];
  if (preview.source === "vite") {
    allPorts.push({ port: preview.port, label: `${preview.port} (Vite)` });
  }
  for (const p of detectedPorts) {
    if (p !== preview.port || preview.source !== "vite") {
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
              {!isVite && preview.source === "detected" && (
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
          <label className="flex items-center gap-1 cursor-pointer select-none" title="Auto-fix: automatically send errors to Claude for fixing">
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

      {/* Preview iframe */}
      <iframe
        key={`${activePort}-${refreshKey}`}
        src={activeUrl}
        title="Live Preview"
        className={`flex-1 w-full bg-white ${hasErrors && errorPanelOpen ? "min-h-0" : ""}`}
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
      />

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
                title="Send all errors to Claude for fixing"
              >
                Send to Claude
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
                    title="Send this error to Claude"
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
