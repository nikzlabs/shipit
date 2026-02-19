import { useEffect, useRef, useState, useMemo } from "react";

export type LogSource = "stderr" | "stdout" | "server" | "preview" | "deploy" | "install";

export interface LogEntry {
  source: LogSource;
  text: string;
  timestamp: string;
}

export type TerminalMode = "logs" | "shell";

export interface TerminalPanelProps {
  entries: LogEntry[];
  onClear: () => void;
  /** Current sub-tab. */
  terminalMode: TerminalMode;
  /** Called when the user switches sub-tabs. */
  onTerminalModeChange: (mode: TerminalMode) => void;
  /** Render prop for the shell sub-tab content (InteractiveTerminal). */
  shellContent: React.ReactNode;
}

const SOURCE_COLORS: Record<LogEntry["source"], string> = {
  stderr: "text-red-400",
  stdout: "text-gray-700 dark:text-gray-300",
  server: "text-blue-400",
  preview: "text-orange-400",
  deploy: "text-cyan-400",
  install: "text-green-400",
};

const SOURCE_LABELS: Record<LogEntry["source"], string> = {
  stderr: "err",
  stdout: "out",
  server: "srv",
  preview: "pre",
  deploy: "dpl",
  install: "ins",
};

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch {
    return "";
  }
}

const ALL_SOURCES: LogSource[] = ["stderr", "stdout", "server", "preview", "deploy", "install"];

const FILTER_COLORS: Record<LogSource, { active: string; inactive: string }> = {
  stderr: { active: "bg-red-100 dark:bg-red-900 text-red-700 dark:text-red-300", inactive: "text-gray-500 hover:text-red-500 dark:hover:text-red-400" },
  stdout: { active: "bg-gray-200 dark:bg-gray-700 text-gray-800 dark:text-gray-200", inactive: "text-gray-500 hover:text-gray-700 dark:hover:text-gray-300" },
  server: { active: "bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300", inactive: "text-gray-500 hover:text-blue-500 dark:hover:text-blue-400" },
  preview: { active: "bg-orange-100 dark:bg-orange-900 text-orange-700 dark:text-orange-300", inactive: "text-gray-500 hover:text-orange-500 dark:hover:text-orange-400" },
  deploy: { active: "bg-cyan-100 dark:bg-cyan-900 text-cyan-700 dark:text-cyan-300", inactive: "text-gray-500 hover:text-cyan-500 dark:hover:text-cyan-400" },
  install: { active: "bg-green-100 dark:bg-green-900 text-green-700 dark:text-green-300", inactive: "text-gray-500 hover:text-green-500 dark:hover:text-green-400" },
};

export function TerminalPanel({ entries, onClear, terminalMode, onTerminalModeChange, shellContent }: TerminalPanelProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(true);
  const [hiddenSources, setHiddenSources] = useState<Set<LogSource>>(new Set());

  const filteredEntries = useMemo(
    () => hiddenSources.size === 0 ? entries : entries.filter((e) => !hiddenSources.has(e.source)),
    [entries, hiddenSources],
  );

  const toggleSource = (source: LogSource) => {
    setHiddenSources((prev) => {
      const next = new Set(prev);
      if (next.has(source)) {
        next.delete(source);
      } else {
        // Don't allow hiding all sources
        if (next.size >= ALL_SOURCES.length - 1) return prev;
        next.add(source);
      }
      return next;
    });
  };

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
  }, [filteredEntries.length]);

  return (
    <div className="flex flex-col h-full">
      {/* Header with sub-tab switcher */}
      <div className="flex items-center justify-between px-3 py-1.5 bg-gray-50 dark:bg-gray-900 border-b border-gray-300 dark:border-gray-700 text-xs text-gray-500 dark:text-gray-400">
        <div className="flex items-center gap-2">
          {/* Sub-tab switcher */}
          <div className="flex items-center gap-0.5 rounded bg-gray-200 dark:bg-gray-800 p-0.5" role="tablist" aria-label="Terminal mode">
            <button
              role="tab"
              aria-selected={terminalMode === "logs"}
              onClick={() => onTerminalModeChange("logs")}
              className={`px-2 py-0.5 rounded font-medium transition-colors ${
                terminalMode === "logs"
                  ? "bg-white dark:bg-gray-700 text-gray-800 dark:text-gray-200 shadow-sm"
                  : "text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300"
              }`}
            >
              Logs
            </button>
            <button
              role="tab"
              aria-selected={terminalMode === "shell"}
              onClick={() => onTerminalModeChange("shell")}
              className={`px-2 py-0.5 rounded font-medium transition-colors ${
                terminalMode === "shell"
                  ? "bg-white dark:bg-gray-700 text-gray-800 dark:text-gray-200 shadow-sm"
                  : "text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300"
              }`}
            >
              Shell
            </button>
          </div>

          {/* Log source filters — only shown in logs mode */}
          {terminalMode === "logs" && (
            <div className="flex items-center gap-1" role="group" aria-label="Filter log sources">
              {ALL_SOURCES.map((source) => {
                const active = !hiddenSources.has(source);
                const colors = FILTER_COLORS[source];
                return (
                  <button
                    key={source}
                    onClick={() => toggleSource(source)}
                    className={`px-1.5 py-0.5 rounded transition-colors ${active ? colors.active : colors.inactive}`}
                    title={`${active ? "Hide" : "Show"} ${SOURCE_LABELS[source]} logs`}
                    aria-pressed={active}
                  >
                    {SOURCE_LABELS[source]}
                  </button>
                );
              })}
            </div>
          )}
        </div>
        {terminalMode === "logs" && (
          <button
            onClick={onClear}
            className="px-2 py-0.5 rounded hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
            title="Clear terminal output"
          >
            Clear
          </button>
        )}
      </div>

      {/* Tab content */}
      {terminalMode === "logs" ? (
        <div
          ref={containerRef}
          className="flex-1 overflow-auto bg-white dark:bg-gray-950 font-mono text-xs leading-5 p-2"
        >
          {filteredEntries.length === 0 ? (
            <div className="flex items-center justify-center h-full text-gray-400 dark:text-gray-600 text-sm font-sans">
              {entries.length === 0
                ? "No output yet. Agent logs will appear here."
                : "No logs match the current filter."}
            </div>
          ) : (
            filteredEntries.map((entry, i) => (
              <div key={i} className="flex gap-2 hover:bg-gray-100/50 dark:hover:bg-gray-900/50">
                <span className="text-gray-400 dark:text-gray-600 shrink-0 select-none">
                  {formatTime(entry.timestamp)}
                </span>
                <span className={`shrink-0 select-none ${SOURCE_COLORS[entry.source]}`}>
                  [{SOURCE_LABELS[entry.source]}]
                </span>
                <span className="text-gray-700 dark:text-gray-300 whitespace-pre-wrap break-all">
                  {entry.text}
                </span>
              </div>
            ))
          )}
          <div ref={bottomRef} />
        </div>
      ) : (
        <div className="flex-1 min-h-0">
          {shellContent}
        </div>
      )}
    </div>
  );
}
