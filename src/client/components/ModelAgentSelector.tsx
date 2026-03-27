// eslint-disable-next-line no-restricted-imports -- useEffect: document mousedown + keydown listeners for click-outside/Escape with cleanup (browser API subscription)
import { useState, useRef, useEffect, useCallback } from "react";
import { CaretDownIcon, CheckIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import { formatModelName, resolveModelAlias } from "../utils/format-model.js";
import { getSavedModelId } from "../utils/local-storage.js";
import type { AgentId } from "../../server/shared/types.js";
import type { AgentOption } from "./AgentPicker.js";
import type { ModelInfo } from "./StatusBar.js";

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
  const [open, setOpen] = useState(false);
  const [pendingModel, setPendingModel] = useState<string | undefined>(getSavedModelId);
  const containerRef = useRef<HTMLDivElement>(null);

  const activeAgent = agents.find((a) => a.id === activeAgentId);
  // Resolve the CLI's raw model ID (e.g. "claude-sonnet-4-6") to an alias ("sonnet")
  const resolvedModel = modelInfo?.model ? resolveModelAlias(modelInfo.model) : undefined;
  // The effective model: what the CLI reported, user's pending selection, localStorage, or first in list
  const savedModel = getSavedModelId();
  const effectiveModel = resolvedModel ?? pendingModel ?? savedModel ?? activeAgent?.models[0];
  const displayName = formatModelName(effectiveModel ?? "");
  // Only allow opening before first message AND not in a loading transition
  const canOpen = !hasActiveSession && !disabled;

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
      if (e.key === "Escape") { e.preventDefault(); setOpen(false); }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open]);

  const handleModelSelect = useCallback(
    (agentId: AgentId, model: string) => {
      if (agentId !== activeAgentId) {
        onAgentChange(agentId);
      }
      setPendingModel(model);
      onModelChange?.(model);
      setOpen(false);
    },
    [activeAgentId, onAgentChange, onModelChange],
  );

  // Clear pending model once the CLI confirms it, or on session change (modelInfo resets)
  useEffect(() => {
    if (resolvedModel) {
      setPendingModel(undefined);
    }
  }, [resolvedModel]);

  return (
    <div ref={containerRef} className="relative" data-testid="model-agent-selector">
      <button
        onClick={() => canOpen ? setOpen((v) => !v) : undefined}
        disabled={disabled}
        className={`flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-lg transition-colors font-medium text-(--color-text-secondary) disabled:opacity-50 disabled:cursor-not-allowed ${
          canOpen ? "hover:bg-(--color-bg-hover) cursor-pointer" : "cursor-default"
        }`}
        aria-label="Model and agent selector"
        aria-expanded={open}
        data-testid="model-agent-trigger"
      >
        <span>{displayName || "Loading..."}</span>
        {canOpen && <CaretDownIcon size={ICON_SIZE.XS} />}
      </button>

      {open && (
        <div
          className="absolute bottom-full right-0 mb-1 w-56 bg-(--color-bg-elevated) border border-(--color-border-secondary) rounded-lg shadow-xl z-50 overflow-hidden"
          data-testid="model-agent-dropdown"
        >
          <div className="py-1">
            {agents.map((agent) => {
              const isActiveAgent = agent.id === activeAgentId;
              const isAvailable = agent.installed && agent.authConfigured;

              return (
                <div key={agent.id}>
                  {/* Provider header */}
                  <div className="flex items-center gap-2 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-(--color-text-tertiary)">
                    <span>{agent.name}</span>
                    {!agent.installed && (
                      <span className="text-(--color-text-tertiary) normal-case tracking-normal font-normal">not installed</span>
                    )}
                    {agent.installed && !agent.authConfigured && (
                      <span className="text-(--color-warning) normal-case tracking-normal font-normal">needs auth</span>
                    )}
                  </div>

                  {/* Model rows */}
                  {agent.models.map((model) => {
                    const isCurrentModel = isActiveAgent && effectiveModel === model;
                    const isSelectable = isAvailable;

                    return (
                      <button
                        key={`${agent.id}-${model}`}
                        onClick={() => isSelectable ? handleModelSelect(agent.id as AgentId, model) : undefined}
                        disabled={!isSelectable}
                        className={`w-full text-left pl-5 pr-3 py-1.5 text-sm flex items-center gap-2 transition-colors ${
                          isCurrentModel
                            ? "bg-(--color-accent-subtle) text-(--color-text-link)"
                            : isSelectable
                              ? "text-(--color-text-primary) hover:bg-(--color-bg-hover)"
                              : "text-(--color-text-tertiary) cursor-not-allowed"
                        }`}
                        data-testid={`model-option-${model}`}
                      >
                        <span className="flex-1">{formatModelName(model)}</span>
                        {isCurrentModel && (
                          <CheckIcon size={ICON_SIZE.SM} className="text-(--color-accent)" />
                        )}
                      </button>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
