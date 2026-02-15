import { useState } from "react";

export interface PreviewStatus {
  running: boolean;
  port: number;
  url: string;
}

export function PreviewFrame({ preview }: { preview: PreviewStatus | null }) {
  const [refreshKey, setRefreshKey] = useState(0);

  if (!preview || !preview.running) {
    return (
      <div className="flex items-center justify-center h-full text-gray-500 text-sm">
        <div className="text-center space-y-2">
          <div className="text-2xl">&#9654;</div>
          <p>Preview will appear here when a Vite project is running in /workspace.</p>
          <p className="text-xs text-gray-600">
            Ask Claude to create a project to get started.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-3 py-1.5 bg-gray-900 border-b border-gray-700 text-xs text-gray-400">
        <span className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-green-500" />
          localhost:{preview.port}
        </span>
        <button
          onClick={() => setRefreshKey((k) => k + 1)}
          className="px-2 py-0.5 rounded hover:bg-gray-800 transition-colors"
          title="Refresh preview"
        >
          Reload
        </button>
      </div>
      <iframe
        key={refreshKey}
        src={preview.url}
        title="Live Preview"
        className="flex-1 w-full bg-white"
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
      />
    </div>
  );
}
