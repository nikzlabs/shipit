import { useCallback } from "react";
import { CaretDownIcon, CheckIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "./ui/dropdown-menu.js";
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
    return <span className="w-1.5 h-1.5 rounded-full bg-(--color-success) shrink-0" data-testid="status-dot-ready" />;
  }
  if (installed) {
    return <span className="w-1.5 h-1.5 rounded-full bg-(--color-warning) shrink-0" data-testid="status-dot-auth" />;
  }
  return <span className="w-1.5 h-1.5 rounded-full bg-(--color-text-tertiary) shrink-0" data-testid="status-dot-unavailable" />;
}

export function AgentPicker({ agents, activeAgentId, onAgentChange, disabled }: AgentPickerProps) {
  const activeAgent = agents.find((a) => a.id === activeAgentId);
  const displayName = activeAgent?.name ?? activeAgentId;

  const handleSelect = useCallback(
    (agent: AgentOption) => {
      if (!agent.installed || !agent.authConfigured) return;
      onAgentChange(agent.id as AgentId);
    },
    [onAgentChange],
  );

  // Don't show picker if there's only one available agent (or none)
  const availableCount = agents.filter((a) => a.installed).length;
  if (agents.length === 0 || availableCount <= 1) return null;

  return (
    <div data-testid="agent-picker">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            disabled={disabled}
            className="flex items-center gap-1.5 px-2 py-0.5 text-xs rounded-full transition-colors font-medium bg-(--color-bg-secondary) text-(--color-text-secondary) hover:bg-(--color-bg-hover) disabled:opacity-50 disabled:cursor-not-allowed border border-(--color-border-secondary)"
            aria-label="Select agent"
            data-testid="agent-picker-trigger"
          >
            {activeAgent && <StatusDot installed={activeAgent.installed} authConfigured={activeAgent.authConfigured} />}
            <span>{displayName}</span>
            <CaretDownIcon size={ICON_SIZE.XS} />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="start" className="w-52" data-testid="agent-picker-dropdown">
          {agents.map((agent) => {
            const isActive = agent.id === activeAgentId;
            const isAvailable = agent.installed && agent.authConfigured;
            return (
              <DropdownMenuItem
                key={agent.id}
                onClick={() => handleSelect(agent)}
                disabled={!isAvailable}
                className={`text-sm ${
                  isActive
                    ? "bg-(--color-accent-subtle) text-(--color-text-link)"
                    : ""
                }`}
                data-testid={`agent-option-${agent.id}`}
              >
                <StatusDot installed={agent.installed} authConfigured={agent.authConfigured} />
                <span className="flex-1">{agent.name}</span>
                {isActive && (
                  <CheckIcon size={ICON_SIZE.SM} className="text-(--color-accent)" />
                )}
                {!agent.installed && (
                  <span className="text-[10px] text-(--color-text-tertiary)">not installed</span>
                )}
                {agent.installed && !agent.authConfigured && (
                  <span className="text-[10px] text-(--color-warning)">needs auth</span>
                )}
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
