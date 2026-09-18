import { Button } from "./ui/button.js";
import { SessionHealthStrip } from "./SessionHealthStrip.js";
import { LogView } from "./LogView.js";
import type { WsClientMessage } from "../../server/shared/types.js";

export type TerminalMode = "logs" | "shell";

export interface TerminalPanelProps {

  onClear: () => void;

  terminalMode: TerminalMode;

  onTerminalModeChange: (mode: TerminalMode) => void;

  shellContent: React.ReactNode;

  send: (msg: WsClientMessage) => void;

  sessionId: string | undefined;

  onReconnectWs: () => void;
}

export function TerminalPanel({ onClear, terminalMode, onTerminalModeChange, shellContent, send, sessionId, onReconnectWs }: TerminalPanelProps) {
  return (
    <div className="flex flex-col h-full">
      {/* Session health strip — diagnostics + recovery actions */}
      <SessionHealthStrip sessionId={sessionId} onReconnectWs={onReconnectWs} />

      {/* Header with sub-tab switcher */}
      <div className="flex items-center justify-between px-3 py-1.5 bg-(--color-bg-secondary) border-b border-(--color-border-secondary) text-xs text-(--color-text-secondary)">
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
        {terminalMode === "logs" && (
          <Button variant="ghost" size="md" onClick={onClear} title="Clear logs">
            Clear
          </Button>
        )}
      </div>

      {/* Tab content — both tabs stay mounted to preserve xterm.js state */}
      <div className={`flex-1 min-h-0 ${terminalMode !== "logs" ? "hidden" : ""}`}>
        <LogView channel="agent" showSource send={send} />
      </div>
      <div className={`flex-1 min-h-0 ${terminalMode !== "shell" ? "hidden" : ""}`}>
        {shellContent}
      </div>
    </div>
  );
}
