import { useState, useRef, useCallback } from "react";
import { CaretDownIcon, CheckIcon, CurrencyDollarIcon, LockIcon } from "@phosphor-icons/react";
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

/**
 * Models flagged with a `$` icon in the picker, on the grounds that they bill
 * per token instead of counting against the Claude subscription plan limit.
 *
 * **STALE as of 2026-08-09 — the one model in it no longer works that way.**
 * Fable 5 counts against the plan like any other subscription model, so this set
 * has no fact behind it and the icon tells the user something untrue. It is left
 * in place only because removing it is a user-visible change and docs/252 phase 1
 * ships none; **phase 3 deletes it** along with the rest of the hand-kept
 * per-model state the service catalogue replaces (docs/252 plan.md).
 *
 * Do not add to it, and do not restore the claim above into a catalogue row:
 * billing is a property of a `(service, billing mode)`, which is what
 * `BillingMode` now expresses.
 */
const METERED_MODELS = new Set(["claude-fable-5"]);

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
  const [pendingModel, setPendingModel] = useState<string | undefined>(undefined);

  // The active session's persisted model (set when the user picked a model for
  // this session, survives reconnects). This is the authoritative answer for
  // "what model is this session using" — read from the session store rather
  // than localStorage, which only remembers the last UI selection across
  // sessions. Without this, switching from a newly-created session (model X)
  // to an existing session (model Y) would show X — see the bug fix in this
  // file's history.
  const sessionId = useSessionStore((s) => s.sessionId);
  const pendingSessionRef = useRef<string | undefined>(sessionId);
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
  const sessionAgent = agents.find((a) => a.id === currentSession?.agentId);
  const displayAgent = sessionAgent ?? activeAgent;

  // The persisted selection for this session. Always one of the agent's
  // hardcoded row keys (e.g. "sonnet", "claude-opus-4-8"):
  //   - the session's own persisted model wins over localStorage so switching
  //     sessions doesn't bleed the last-selected model into other sessions
  //   - localStorage's last selection seeds ONLY the new-session view
  //     (`!hasActiveSession`); for an active session it is never a fallback, so
  //     a session that never had a model explicitly picked highlights the agent
  //     default it actually runs, not the model last chosen elsewhere. Mirrors
  //     ReasoningSelector's per-session rule (docs/217).
  //   - the first model the active agent supports is the final fallback
  const savedModel = getSavedModelId();
  const seededModel = hasActiveSession ? undefined : savedModel;

  const pendingModelForCurrentSession = pendingSessionRef.current === sessionId ? pendingModel : undefined;

  // The raw model id the CLI reported running this turn (e.g. "claude-opus-5"
  // or a versioned "claude-sonnet-5-20260101"); undefined before the first turn.
  // `modelInfo` is global UI state, so it is trusted only when the reported
  // model belongs to the active session's agent; otherwise a session switch
  // could show the previous session's model.
  const liveModel = modelInfo?.model ?? undefined;
  const liveModelAlias = liveModel ? resolveModelAlias(liveModel) : undefined;
  const liveModelRow =
    liveModel && displayAgent
      ? (displayAgent.models.includes(liveModel)
          ? liveModel
          : liveModelAlias && displayAgent.models.includes(liveModelAlias)
            ? liveModelAlias
            : undefined)
      : undefined;
  const scopedLiveModel = liveModelRow ? liveModel : undefined;

  // ONE precedence, shared by the trigger label and the dropdown checkmark, so
  // the two can never contradict each other:
  //
  //   1. the optimistic pending pick — instant feedback before the next turn
  //   2. the session's persisted model — the authoritative answer to "what will
  //      this session run next", set by the user's pick (`set_model`) and
  //      surviving reloads and session switches
  //   3. the model the CLI last reported — only meaningful for a session that
  //      never had a model explicitly picked
  //   4. localStorage's last pick, for the new-session view only, then the
  //      agent's first model
  //
  // The persisted selection deliberately outranks the live model. It used to be
  // the other way round, which made the picker contradict itself whenever the
  // two disagreed: the trigger showed the CLI's last-reported model while the
  // checkmark sat on the newly-picked one ("says Fable, dropdown says Opus").
  // The live model is still surfaced verbatim in the usage modal, which is the
  // right home for "what actually ran".
  const displayedModel =
    pendingModelForCurrentSession ?? sessionModel ?? scopedLiveModel ?? seededModel ?? activeAgent?.models[0];
  // Same rungs, but resolved to a hardcoded row key at the live-model rung so a
  // versioned id still highlights its row. A model the CLI switched to that we
  // don't offer matches no row and so highlights nothing; the label still shows
  // it.
  const selectedModel =
    pendingModelForCurrentSession ?? sessionModel ?? liveModelRow ?? seededModel ?? activeAgent?.models[0];
  const displayName = formatModelName(displayedModel ?? "");
  // Show the $ on the (collapsed) trigger too, so the usage-based cue stays
  // visible once the metered model is the active one — not only while the
  // dropdown is open.
  const displayedModelMetered = !!displayedModel && METERED_MODELS.has(displayedModel);

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
      pendingSessionRef.current = sessionId;
      setPendingModel(model);
      onModelChange?.(model);
    },
    [onAgentChange, onModelChange, pinnedAgentId, sessionId],
  );

  // Drop the optimistic pending pick once the session record catches up with it
  // — from then on `sessionModel` drives both the label and the checkmark, and
  // they agree by construction. Keep the older CLI-confirmation clear as the
  // escape hatch for a pick the server never persisted (e.g. it was rejected),
  // so a stale pending pick can't outlive a turn.
  const prevLiveRef = useRef(liveModel);
  if (pendingModel && sessionModel === pendingModel) {
    setPendingModel(undefined);
  } else if (liveModel && liveModel !== prevLiveRef.current) {
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
            {displayedModelMetered && (
              <CurrencyDollarIcon
                size={ICON_SIZE.XS}
                className="text-(--color-text-tertiary)"
                data-testid="model-trigger-metered"
              />
            )}
            {canOpen && <CaretDownIcon size={ICON_SIZE.XS} />}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="end" className="w-56" data-testid="model-agent-dropdown">
            {/*
              docs/252 phase 9 (req 14) — a harness this deployment did not install
              "offers no models and appears nowhere in the picker". It used to render
              as a group header tagged "not installed" over a list of disabled rows,
              which is right for a harness that is *present but unauthenticated* and
              wrong for one that does not exist here: there is nothing the user can do
              about it, and the deploy-time choice is not a state to nudge them out of.
              "Needs auth" is the case that stays visible, because it is actionable.
            */}
            {agents.filter((agent) => agent.installed).map((agent) => {
              const isActiveAgent = agent.id === activeAgentId;
              const isAvailable = agent.authConfigured;
              // docs/138: when the session has pinned an agent, models from
              // other agents are locked (the agent can't be swapped). Pre-pin
              // there is no restriction.
              const isAgentLocked = !!pinnedAgentId && agent.id !== pinnedAgentId;

              return (
                <div key={agent.id}>
                  {/* Provider header */}
                  <DropdownMenuLabel className="flex items-center gap-2">
                    <span>{agent.name}</span>
                    {!agent.authConfigured && (
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
                    // Usage-based models bill per token rather than counting
                    // against the subscription plan — flag them with a $ icon.
                    const isMetered = METERED_MODELS.has(model);

                    return (
                      <DropdownMenuItem
                        key={`${agent.id}-${model}`}
                        onSelect={() => handleModelSelect(agent.id as AgentId, model)}
                        disabled={rowDisabled}
                        title={isMetered ? "Usage-based pricing — billed per token" : undefined}
                        className={`pl-5 pr-3 py-1.5 text-sm ${
                          isCurrentModel
                            ? "bg-(--color-accent-subtle) text-(--color-text-link)"
                            : ""
                        }`}
                        data-testid={`model-option-${model}`}
                      >
                        <span className="flex-1">{formatModelName(model)}</span>
                        {isMetered && (
                          <CurrencyDollarIcon
                            size={ICON_SIZE.SM}
                            className="text-(--color-text-tertiary)"
                            data-testid={`model-metered-${model}`}
                          />
                        )}
                        {/* Reserved trailing slot keeps the $ at a stable
                            position whether or not the row is the selected one. */}
                        <span className="flex w-4 shrink-0 justify-end">
                          {isCurrentModel && (
                            <CheckIcon size={ICON_SIZE.SM} className="text-(--color-accent)" />
                          )}
                        </span>
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
