import { useEffect, useRef } from "react";

export interface LogEntry {
  source: "stderr" | "stdout" | "server";
  text: string;
  timestamp: string;
}

export interface TerminalPanelProps {
  entries: LogEntry[];
  onClear: () => void;
}

const SOURCE_COLORS: Record<LogEntry["source"], string> = {
  stderr: "text-red-400",
  stdout: "text-gray-300",
  server: "text-blue-400",
};

const SOURCE_LABELS: Record<LogEntry["source"], string> = {
  stderr: "err",
  stdout: "out",
  server: "srv",
};

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch {
    return "";
  }
}

export function TerminalPanel({ entries, onClear }: TerminalPanelProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(true);

  // Track whether user has scrolled up (disable auto-scroll)
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = container;
      // Consider "at bottom" if within 40px of the end
      autoScrollRef.current = scrollHeight - scrollTop - clientHeight < 40;
    };

    container.addEventListener("scroll", handleScroll);
    return () => container.removeEventListener("scroll", handleScroll);
  }, []);

  // Auto-scroll when new entries arrive
  useEffect(() => {
    if (autoScrollRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [entries.length]);

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-1.5 bg-gray-900 border-b border-gray-700 text-xs text-gray-400">
        <span className="font-medium text-gray-300">Terminal</span>
        <button
          onClick={onClear}
          className="px-2 py-0.5 rounded hover:bg-gray-800 transition-colors"
          title="Clear terminal output"
        >
          Clear
        </button>
      </div>

      {/* Log output */}
      <div
        ref={containerRef}
        className="flex-1 overflow-auto bg-gray-950 font-mono text-xs leading-5 p-2"
      >
        {entries.length === 0 ? (
          <div className="flex items-center justify-center h-full text-gray-600 text-sm font-sans">
            No output yet. Logs from Claude CLI will appear here.
          </div>
        ) : (
          entries.map((entry, i) => (
            <div key={i} className="flex gap-2 hover:bg-gray-900/50">
              <span className="text-gray-600 shrink-0 select-none">
                {formatTime(entry.timestamp)}
              </span>
              <span className={`shrink-0 select-none ${SOURCE_COLORS[entry.source]}`}>
                [{SOURCE_LABELS[entry.source]}]
              </span>
              <span className="text-gray-300 whitespace-pre-wrap break-all">
                {entry.text}
              </span>
            </div>
          ))
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
