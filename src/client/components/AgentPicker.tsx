import { useState, useRef, useEffect, useCallback } from "react";
import type { AgentId } from "../../server/shared/types.js";

export interface AgentOption {
  id: string;
  name: string;
  installed: boolean;
  authConfigured: boolean;
  models: string[];
}

interface AgentPickerProps {
  agents: AgentOption[];
  activeAgentId: AgentId;
  onAgentChange: (agentId: AgentId) => void;
  disabled?: boolean;
}

/** Small dot indicator for agent status. */
function StatusDot({ installed, authConfigured }: { installed: boolean; authConfigured: boolean }) {
  if (installed && authConfigured) {
    return <span className="w-1.5 h-1.5 rounded-full bg-green-500 shrink-0" data-testid="status-dot-ready" />;
  }
  if (installed) {
    return <span className="w-1.5 h-1.5 rounded-full bg-yellow-500 shrink-0" data-testid="status-dot-auth" />;
  }
  return <span className="w-1.5 h-1.5 rounded-full bg-gray-500 shrink-0" data-testid="status-dot-unavailable" />;
}

export function AgentPicker({ agents, activeAgentId, onAgentChange, disabled }: AgentPickerProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const activeAgent = agents.find((a) => a.id === activeAgentId);
  const displayName = activeAgent?.name ?? activeAgentId;

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open]);

  const handleSelect = useCallback(
    (agent: AgentOption) => {
      if (!agent.installed || !agent.authConfigured) return;
      onAgentChange(agent.id as AgentId);
      setOpen(false);
    },
    [onAgentChange],
  );

  // Don't show picker if there's only one available agent (or none)
  const availableCount = agents.filter((a) => a.installed).length;
  if (agents.length === 0 || availableCount <= 1) return null;

  return (
    <div ref={containerRef} className="relative" data-testid="agent-picker">
      <button
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        className="flex items-center gap-1.5 px-2 py-0.5 text-xs rounded-full transition-colors font-medium bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed border border-gray-300 dark:border-gray-600"
        aria-label="Select agent"
        aria-expanded={open}
        data-testid="agent-picker-trigger"
      >
        {activeAgent && <StatusDot installed={activeAgent.installed} authConfigured={activeAgent.authConfigured} />}
        <span>{displayName}</span>
        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div
          className="absolute bottom-full left-0 mb-1 w-52 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-xl z-50 overflow-hidden"
          data-testid="agent-picker-dropdown"
        >
          <div className="py-1">
            {agents.map((agent) => {
              const isActive = agent.id === activeAgentId;
              const isAvailable = agent.installed && agent.authConfigured;
              return (
                <button
                  key={agent.id}
                  onClick={() => handleSelect(agent)}
                  disabled={!isAvailable}
                  className={`w-full text-left px-3 py-2 text-sm flex items-center gap-2 transition-colors ${
                    isActive
                      ? "bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300"
                      : isAvailable
                        ? "text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700"
                        : "text-gray-400 dark:text-gray-500 cursor-not-allowed"
                  }`}
                  data-testid={`agent-option-${agent.id}`}
                >
                  <StatusDot installed={agent.installed} authConfigured={agent.authConfigured} />
                  <span className="flex-1">{agent.name}</span>
                  {isActive && (
                    <svg className="w-4 h-4 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                  )}
                  {!agent.installed && (
                    <span className="text-[10px] text-gray-400 dark:text-gray-500">not installed</span>
                  )}
                  {agent.installed && !agent.authConfigured && (
                    <span className="text-[10px] text-yellow-500">needs auth</span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
