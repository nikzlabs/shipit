// eslint-disable-next-line no-restricted-imports -- useEffect: scroll event listener + DOM scrollIntoView (browser API subscription + DOM sync)
import { useEffect, useRef, useMemo } from "react";
import { Button } from "./ui/button.js";
import { useTerminalStore } from "../stores/terminal-store.js";

export type LogSource = "stderr" | "stdout" | "server" | "preview" | "install";

export interface LogEntry {
  id: number;
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
  stderr: "text-(--color-error)",
  stdout: "text-(--color-text-primary)",
  server: "text-(--color-text-link)",
  preview: "text-(--color-autofix)",
  install: "text-(--color-success)",
};

const SOURCE_LABELS: Record<LogEntry["source"], string> = {
  stderr: "err",
  stdout: "out",
  server: "srv",
  preview: "pre",
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

const ALL_SOURCES: LogSource[] = ["stderr", "stdout", "server", "preview", "install"];

const FILTER_COLORS: Record<LogSource, { active: string; inactive: string }> = {
  stderr: { active: "bg-(--color-error-subtle) text-(--color-error)", inactive: "text-(--color-text-secondary) hover:text-(--color-error)" },
  stdout: { active: "bg-(--color-bg-tertiary) text-(--color-text-primary)", inactive: "text-(--color-text-secondary) hover:text-(--color-text-primary)" },
  server: { active: "bg-(--color-accent-subtle) text-(--color-text-link)", inactive: "text-(--color-text-secondary) hover:text-(--color-text-link)" },
  preview: { active: "bg-(--color-autofix)/15 text-(--color-autofix)", inactive: "text-(--color-text-secondary) hover:text-(--color-autofix)" },
  install: { active: "bg-(--color-success-subtle) text-(--color-success)", inactive: "text-(--color-text-secondary) hover:text-(--color-success)" },
};

export function TerminalPanel({ entries, onClear, terminalMode, onTerminalModeChange, shellContent }: TerminalPanelProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(true);
  const hiddenSources = useTerminalStore((s) => s.hiddenSources);
  const toggleSource = useTerminalStore((s) => s.toggleSource);

  const filteredEntries = useMemo(
    () => hiddenSources.size === 0 ? entries : entries.filter((e) => !hiddenSources.has(e.source)),
    [entries, hiddenSources],
  );

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
      bottomRef.current?.scrollIntoView({ behavior: "instant" });
    }
  }, [filteredEntries.length]);

  return (
    <div className="flex flex-col h-full">
      {/* Header with sub-tab switcher */}
      <div className="flex items-center justify-between px-3 py-1.5 bg-(--color-bg-secondary) border-b border-(--color-border-secondary) text-xs text-(--color-text-secondary)">
        <div className="flex items-center gap-2">
          {/* Sub-tab switcher */}
          <div className="flex items-center gap-0.5 rounded bg-(--color-bg-tertiary) p-0.5" role="tablist" aria-label="Terminal mode">
            <button
              role="tab"
              aria-selected={terminalMode === "logs"}
              onClick={() => onTerminalModeChange("logs")}
              className={`px-2 py-0.5 rounded font-medium transition-colors ${
                terminalMode === "logs"
                  ? "bg-(--color-bg-elevated) text-(--color-text-primary) shadow-sm"
                  : "text-(--color-text-secondary) hover:text-(--color-text-primary)"
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
                  ? "bg-(--color-bg-elevated) text-(--color-text-primary) shadow-sm"
                  : "text-(--color-text-secondary) hover:text-(--color-text-primary)"
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
          <Button
            variant="ghost"
            size="sm"
            onClick={onClear}
            title="Clear terminal output"
          >
            Clear
          </Button>
        )}
      </div>

      {/* Tab content — both tabs stay mounted to preserve xterm.js state */}
      <div
        ref={containerRef}
        className={`flex-1 overflow-auto bg-(--color-bg-primary) font-mono text-xs leading-5 p-2 ${terminalMode !== "logs" ? "hidden" : ""}`}
      >
        {filteredEntries.length === 0 ? (
          <div className="flex items-center justify-center h-full text-(--color-text-tertiary) text-sm font-sans">
            {entries.length === 0
              ? "No output yet. Agent logs will appear here."
              : "No logs match the current filter."}
          </div>
        ) : (
          filteredEntries.map((entry) => (
            <div key={entry.id} className="flex gap-2 hover:bg-(--color-bg-hover)">
              <span className="text-(--color-text-tertiary) shrink-0 select-none">
                {formatTime(entry.timestamp)}
              </span>
              <span className={`shrink-0 select-none ${SOURCE_COLORS[entry.source]}`}>
                [{SOURCE_LABELS[entry.source]}]
              </span>
              <span className="text-(--color-text-primary) whitespace-pre-wrap break-all">
                {entry.text}
              </span>
            </div>
          ))
        )}
        <div ref={bottomRef} />
      </div>
      <div className={`flex-1 min-h-0 ${terminalMode !== "shell" ? "hidden" : ""}`}>
        {shellContent}
      </div>
    </div>
  );
}
