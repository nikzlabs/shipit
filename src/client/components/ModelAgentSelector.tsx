import { useState, useRef, useCallback } from "react";
import { CaretDownIcon, CheckIcon, LockIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import { formatModelName } from "../utils/format-model.js";
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
  /**
   * Whether the picker is bound to an active session (the in-session composer)
   * rather than composing a brand-new session (the quick-capture overlay). The
   * cross-agent lock is driven by the *current* session's persisted
   * `agentPinned` flag — but only when this flag is true. In a new-session
   * context the picker reads the same global session store, so without this
   * gate it would inherit a background session's pin and lock the agent for a
   * session that hasn't even started. Within an active session the
   * `agentPinned`-based lock (other agents only) keeps mid-session model
   * changes inside the pinned agent available.
   */
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

  // docs/138: once the session has taken its first turn the agent is locked
  // for life (per-agent credential isolation). The model, however, can still
  // change across turns within the same agent — so we lock by `agentPinned`
  // from the session record (other agents' rows only), not the whole picker.
  // The lock applies ONLY when this picker is bound to the active session
  // (`hasActiveSession`). The quick-capture overlay reuses this picker to start
  // a *new* session but reads the same global session store; without the gate
  // it would inherit whatever background session is pinned and lock the agent
  // for a session that hasn't started yet (docs/166).
  const pinnedAgentId =
    hasActiveSession && currentSession?.agentPinned ? currentSession.agentId : undefined;

  const activeAgent = agents.find((a) => a.id === activeAgentId);

  // The persisted selection for this session. Always one of the agent's
  // hardcoded row keys (e.g. "sonnet", "claude-opus-4-8"):
  //   - the session's own persisted model wins over localStorage so switching
  //     sessions doesn't bleed the last-selected model into other sessions
  //   - localStorage's last selection seeds the new-session view
  //   - the first model the active agent supports is the final fallback
  const savedModel = getSavedModelId();
  const persistedSelection = sessionModel ?? savedModel ?? activeAgent?.models[0];

  // Which hardcoded model is selected — drives the dropdown checkmark. A pending
  // pick wins so a mid-session switch highlights immediately, before the next
  // turn's agent_init confirms it. Because this is always a hardcoded row key, a
  // model the CLI may have switched to that we don't offer matches no row and so
  // highlights nothing; we still surface it in the label below.
  const selectedModel = pendingModel ?? persistedSelection;

  // The raw model id the CLI reported running this turn (e.g. "claude-opus-4-8"
  // or the versioned "claude-sonnet-4-6"); undefined before the first turn.
  const liveModel = modelInfo?.model ?? undefined;

  // The trigger label. An optimistic pick wins for instant feedback; otherwise
  // show whatever the CLI actually reported this turn (so a mid-turn switch is
  // reflected and the right name survives a page reload), falling back to the
  // persisted selection before the first turn. formatModelName maps both
  // versioned ids and our hardcoded keys to pretty names, and shows the raw id
  // for anything it doesn't recognize.
  const displayName = formatModelName(pendingModel ?? liveModel ?? persistedSelection ?? "");

  // The picker is interactive whenever it isn't in a loading transition.
  // Mid-session, the dropdown still opens — only cross-agent rows are locked
  // (see `isAgentLocked` in the row render below).
  const canOpen = !disabled;

  const handleModelSelect = useCallback(
    (agentId: AgentId, model: string) => {
      // Defense-in-depth: the dropdown row is already disabled when this would
      // cross a pinned agent boundary, but bail anyway so a programmatic call
      // can't bypass the lock.
      if (pinnedAgentId && agentId !== pinnedAgentId) return;
      // Always persist the picked model's agent — never gate this on the
      // in-memory `activeAgentId`, which gets mirrored from whatever session
      // was last viewed and can disagree with the persisted agent. Gating here
      // was the bug that let a stale `vibe-agent-id` survive a model pick and
      // override the selection on the next new session. See docs/142 (C).
      // Once the session is pinned, the agent can't move, so we skip the
      // redundant set_agent (the server would also no-op it). Pre-pin, we
      // still send both so the grouped picker can switch agent + model
      // together.
      if (!pinnedAgentId) {
        onAgentChange(agentId);
      }
      setPendingModel(model);
      onModelChange?.(model);
    },
    [onAgentChange, onModelChange, pinnedAgentId],
  );

  // Clear the optimistic pending pick once the CLI confirms a model for the
  // turn, after which liveModel / persistedSelection drive the label and checkmark.
  const prevLiveRef = useRef(liveModel);
  if (liveModel && liveModel !== prevLiveRef.current) {
    setPendingModel(undefined);
  }
  prevLiveRef.current = liveModel;

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
              // docs/138: when the session has pinned an agent, models from
              // other agents are locked (the agent can't be swapped). Pre-pin
              // there is no restriction.
              const isAgentLocked = !!pinnedAgentId && agent.id !== pinnedAgentId;

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
                    {isAgentLocked && (
                      <span className="flex items-center gap-1 text-(--color-text-tertiary) normal-case tracking-normal font-normal" title="The agent is locked for this session after the first message. You can switch models within the active agent only.">
                        <LockIcon size={ICON_SIZE.XS} />
                        <span>locked</span>
                      </span>
                    )}
                  </DropdownMenuLabel>

                  {/* Model rows */}
                  {agent.models.map((model) => {
                    const isCurrentModel = isActiveAgent && selectedModel === model;
                    const rowDisabled = !isAvailable || isAgentLocked;

                    return (
                      <DropdownMenuItem
                        key={`${agent.id}-${model}`}
                        onSelect={() => handleModelSelect(agent.id as AgentId, model)}
                        disabled={rowDisabled}
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
