import { useState, useRef, useCallback } from "react";
import { CaretDownIcon, CheckIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import { formatModelName, resolveModelAlias } from "../utils/format-model.js";
import { getSavedModelId } from "../utils/local-storage.js";
import { useSessionStore } from "../stores/session-store.js";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
} from "./ui/dropdown-menu.js";
import type { AgentId } from "../../server/shared/types.js";
import type { AgentOption } from "../agent-types.js";
import type { ModelInfo } from "../utils/model-info.js";

interface ModelAgentSelectorProps {
  agents: AgentOption[];
  activeAgentId: AgentId;
  onAgentChange: (agentId: AgentId) => void;
  onModelChange?: (model: string) => void;
  modelInfo: ModelInfo | null;
  hasActiveSession?: boolean;
  disabled?: boolean;
}

export function ModelAgentSelector({
  agents,
  activeAgentId,
  onAgentChange,
  onModelChange,
  modelInfo,
  hasActiveSession = false,
  disabled,
}: ModelAgentSelectorProps) {
  const [pendingModel, setPendingModel] = useState<string | undefined>(getSavedModelId);

  // The active session's persisted model (set when the user picked a model for
  // this session, survives reconnects). This is the authoritative answer for
  // "what model is this session using" — read from the session store rather
  // than localStorage, which only remembers the last UI selection across
  // sessions. Without this, switching from a newly-created session (model X)
  // to an existing session (model Y) would show X — see the bug fix in this
  // file's history.
  const sessionId = useSessionStore((s) => s.sessionId);
  const sessions = useSessionStore((s) => s.sessions);
  const currentSession = sessionId ? sessions.find((s) => s.id === sessionId) : undefined;
  const sessionModel = currentSession?.model;

  const activeAgent = agents.find((a) => a.id === activeAgentId);
  // Resolve the CLI's raw model ID (e.g. "claude-sonnet-4-6") to an alias ("sonnet")
  const resolvedModel = modelInfo?.model ? resolveModelAlias(modelInfo.model) : undefined;
  // The effective model fallback chain:
  //   1. Live CLI report from this turn (resolvedModel)
  //   2. Pending UI selection (only meaningful before the session has started)
  //   3. The session's own persisted model — wins over localStorage so switching
  //      sessions doesn't bleed the last-selected model into other sessions
  //   4. localStorage's last selection (used for the new-session view)
  //   5. First model the active agent supports
  const savedModel = getSavedModelId();
  const effectiveModel =
    resolvedModel ?? pendingModel ?? sessionModel ?? savedModel ?? activeAgent?.models[0];
  const displayName = formatModelName(effectiveModel ?? "");
  // Only allow opening before first message AND not in a loading transition
  const canOpen = !hasActiveSession && !disabled;

  const handleModelSelect = useCallback(
    (agentId: AgentId, model: string) => {
      // Always persist the picked model's agent — never gate this on the
      // in-memory `activeAgentId`, which gets mirrored from whatever session
      // was last viewed and can disagree with the persisted agent. Gating here
      // was the bug that let a stale `vibe-agent-id` survive a model pick and
      // override the selection on the next new session. The dropdown is only
      // interactive before a session is pinned (canOpen requires
      // !hasActiveSession), so re-sending set_agent is safe. See docs/142 (C).
      onAgentChange(agentId);
      setPendingModel(model);
      onModelChange?.(model);
    },
    [onAgentChange, onModelChange],
  );

  // Clear pending model once the CLI confirms it (inline during render)
  const prevResolvedRef = useRef(resolvedModel);
  if (resolvedModel && resolvedModel !== prevResolvedRef.current) {
    setPendingModel(undefined);
  }
  prevResolvedRef.current = resolvedModel;

  return (
    <div data-testid="model-agent-selector">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            disabled={disabled || !canOpen}
            className={`flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-lg transition-colors font-medium text-(--color-text-secondary) disabled:opacity-50 disabled:cursor-not-allowed ${
              canOpen ? "hover:bg-(--color-bg-hover) cursor-pointer" : "cursor-default"
            }`}
            aria-label="Model and agent selector"
            data-testid="model-agent-trigger"
          >
            <span>{displayName || "Loading..."}</span>
            {canOpen && <CaretDownIcon size={ICON_SIZE.XS} />}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="end" className="w-56" data-testid="model-agent-dropdown">
            {agents.map((agent) => {
              const isActiveAgent = agent.id === activeAgentId;
              const isAvailable = agent.installed && agent.authConfigured;

              return (
                <div key={agent.id}>
                  {/* Provider header */}
                  <DropdownMenuLabel className="flex items-center gap-2">
                    <span>{agent.name}</span>
                    {!agent.installed && (
                      <span className="text-(--color-text-tertiary) normal-case tracking-normal font-normal">not installed</span>
                    )}
                    {agent.installed && !agent.authConfigured && (
                      <span className="text-(--color-warning) normal-case tracking-normal font-normal">needs auth</span>
                    )}
                  </DropdownMenuLabel>

                  {/* Model rows */}
                  {agent.models.map((model) => {
                    const isCurrentModel = isActiveAgent && effectiveModel === model;

                    return (
                      <DropdownMenuItem
                        key={`${agent.id}-${model}`}
                        onSelect={() => handleModelSelect(agent.id as AgentId, model)}
                        disabled={!isAvailable}
                        className={`pl-5 pr-3 py-1.5 text-sm ${
                          isCurrentModel
                            ? "bg-(--color-accent-subtle) text-(--color-text-link)"
                            : ""
                        }`}
                        data-testid={`model-option-${model}`}
                      >
                        <span className="flex-1">{formatModelName(model)}</span>
                        {isCurrentModel && (
                          <CheckIcon size={ICON_SIZE.SM} className="text-(--color-accent)" />
                        )}
                      </DropdownMenuItem>
                    );
                  })}
                </div>
              );
            })}
          </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
