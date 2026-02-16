import { useState } from "react";

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
}

export function PreviewFrame({ preview, detectedPorts, selectedPort, onSelectPort }: PreviewFrameProps) {
  const [refreshKey, setRefreshKey] = useState(0);

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

  return (
    <div className="flex flex-col h-full">
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
        <button
          onClick={() => setRefreshKey((k) => k + 1)}
          className="px-2 py-0.5 rounded hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
          title="Refresh preview"
        >
          Reload
        </button>
      </div>
      <iframe
        key={`${activePort}-${refreshKey}`}
        src={activeUrl}
        title="Live Preview"
        className="flex-1 w-full bg-white"
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
      />
    </div>
  );
}
