import { useState, useRef, useCallback } from "react";
import { CaretDownIcon, CheckIcon, LockIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import { formatModelName, resolveModelAlias } from "../utils/format-model.js";
import { getSavedModelId, getSavedModelSelection } from "../utils/local-storage.js";
import { useSessionStore } from "../stores/session-store.js";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
} from "./ui/dropdown-menu.js";
import type { AgentId } from "../../server/shared/types.js";
import type { AgentOption, EligibleModelOption } from "../agent-types.js";
import type { ModelInfo } from "../utils/model-info.js";

/**
 * docs/252 phase 3 — the composer's picker, split in two.
 *
 * Until now one dropdown grouped models under *harness* headers, which worked
 * only because harness and provider were the same thing. Once they are
 * separated that grouping is wrong twice over: the group header is needed for
 * the **service** — which is what the credential, the price and the billing kind
 * all hang off — and the harness stops being a group at all. It becomes an axis
 * that selects *which list you are looking at*.
 *
 * This does not touch req 3, which is about models: model selection stays one
 * list in one place, with no vendor's models given a separate surface or a
 * privileged position. The harness is a different choice with a different
 * consequence, and the decisive one is that **it is not reversible** —
 * per-agent credential isolation pins it for life at the first turn (docs/138),
 * while models stay switchable (req 4). The old picker rendered that asymmetry
 * as greyed rows and a lock badge on a group header *inside* the model menu, so
 * the single most consequential fact about the session was visible only to
 * someone who opened a dropdown and read it. Two controls make it structural.
 *
 * What deliberately did NOT survive the split, because it would be chrome
 * rather than information (see plan.md, "The picker states what you choose on"):
 * labels on the triggers, a "N more models on Codex" footer, the API style
 * anywhere at all, and the `$` metered-model icon — whose one member turned out
 * to bill against the plan like any other subscription model, so the icon was
 * asserting something untrue.
 */

/** A model row, as the picker groups and renders it. */
interface ModelRow extends EligibleModelOption {
  /** The group this row belongs to: one `(service, billing mode)`. */
  groupKey: string;
}

/** One `(service, billing mode)` block in the model menu. */
interface ModelGroup {
  key: string;
  serviceName: string;
  billingMode: "sub" | "key";
  rows: ModelRow[];
}

/**
 * The eligible models of an agent as picker rows.
 *
 * Falls back to the bare `models` list when `eligibleModels` is absent — an
 * older wire payload or a test fixture. The fallback renders one unnamed group,
 * which is what the picker showed before the service axis existed; degrading to
 * it beats rendering nothing.
 */
export function modelRowsFor(agent: AgentOption | undefined): ModelRow[] {
  if (!agent) return [];
  if (agent.eligibleModels && agent.eligibleModels.length > 0) {
    return agent.eligibleModels.map((m) => ({ ...m, groupKey: `${m.serviceId}:${m.billingMode}` }));
  }
  return agent.models.map((modelId) => ({
    modelId,
    label: formatModelName(modelId),
    serviceId: "",
    serviceName: "",
    billingMode: "key" as const,
    groupKey: "",
  }));
}

/** Group rows by `(service, billing mode)`, preserving catalogue order. */
function groupRows(rows: ModelRow[]): ModelGroup[] {
  const groups: ModelGroup[] = [];
  for (const row of rows) {
    let group = groups.find((g) => g.key === row.groupKey);
    if (!group) {
      group = {
        key: row.groupKey,
        serviceName: row.serviceName,
        billingMode: row.billingMode,
        rows: [],
      };
      groups.push(group);
    }
    group.rows.push(row);
  }
  return groups;
}

/**
 * True when this model id is offered by more than one eligible group — the sole
 * case where the id alone cannot say who is billing you.
 *
 * That is exactly why the service pill is disclosure-on-demand rather than
 * permanent: it appears when the ambiguity is real and costs nothing otherwise.
 */
function isAmbiguous(rows: ModelRow[], modelId: string | undefined): boolean {
  if (!modelId) return false;
  return rows.filter((r) => r.modelId === modelId).length > 1;
}

/**
 * The label that disambiguates a duplicated model id: the **billing mode** when
 * the duplicate rows are within one service, the **service** when they cross
 * services — because that is the axis that actually differs.
 */
function disambiguator(rows: ModelRow[], row: ModelRow): string {
  const duplicates = rows.filter((r) => r.modelId === row.modelId);
  const crossesServices = duplicates.some((r) => r.serviceId !== row.serviceId);
  if (crossesServices) return row.serviceName;
  return row.billingMode === "sub" ? "Subscription" : "API key";
}

// ---- Harness selector ------------------------------------------------------

interface HarnessSelectorProps {
  agents: AgentOption[];
  activeAgentId: AgentId;
  onAgentChange: (agentId: AgentId) => void;
  /** See {@link ModelSelectorProps.hasActiveSession}. */
  hasActiveSession?: boolean;
  disabled?: boolean;
}

/**
 * Which CLI runs this session. Disabled with the reason on it once the session
 * has pinned one — the irreversibility is the whole point of splitting it out,
 * so it is stated on the control rather than inside a menu.
 */
export function HarnessSelector({
  agents,
  activeAgentId,
  onAgentChange,
  hasActiveSession = false,
  disabled,
}: HarnessSelectorProps) {
  const sessionId = useSessionStore((s) => s.sessionId);
  const sessions = useSessionStore((s) => s.sessions);
  const currentSession = sessionId ? sessions.find((s) => s.id === sessionId) : undefined;
  const pinnedAgentId =
    hasActiveSession && currentSession?.agentPinned ? currentSession.agentId : undefined;

  // docs/252 phase 9 (req 14) — a harness this deployment did not install offers
  // no models and appears nowhere. An installed-but-unauthenticated one stays
  // visible, because that is actionable.
  const installed = agents.filter((a) => a.installed);
  const displayAgent = agents.find((a) => a.id === (currentSession?.agentId ?? activeAgentId));
  const locked = !!pinnedAgentId;

  return (
    <div data-testid="harness-selector">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            disabled={disabled || locked}
            title={
              locked
                ? "The harness is fixed for this session after the first message. Models stay switchable."
                : undefined
            }
            className={`flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-lg transition-colors font-medium text-(--color-text-secondary) disabled:opacity-50 disabled:cursor-not-allowed ${
              disabled || locked ? "cursor-default" : "hover:bg-(--color-bg-hover) cursor-pointer"
            }`}
            aria-label="Harness selector"
            data-testid="harness-trigger"
          >
            <span>{displayAgent?.name ?? "Loading..."}</span>
            {locked ? (
              <LockIcon size={ICON_SIZE.XS} className="text-(--color-text-tertiary)" />
            ) : (
              <CaretDownIcon size={ICON_SIZE.XS} />
            )}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="end" className="w-56" data-testid="harness-dropdown">
          {installed.map((agent) => {
            const rows = modelRowsFor(agent);
            const isCurrent = agent.id === (currentSession?.agentId ?? activeAgentId);
            return (
              <DropdownMenuItem
                key={agent.id}
                onSelect={() => onAgentChange(agent.id as AgentId)}
                disabled={!agent.authConfigured}
                className={`px-3 py-1.5 text-sm ${
                  isCurrent ? "bg-(--color-accent-subtle) text-(--color-text-link)" : ""
                }`}
                data-testid={`harness-option-${agent.id}`}
              >
                <span className="flex-1">{agent.name}</span>
                {/*
                  The model count lands on the control that would act on it,
                  which is why there is no "N more models on Codex" footer in the
                  MODEL menu: that footer grows with every installed harness and
                  is useless the moment the harness is pinned, which is most of a
                  session's life.
                */}
                <span className="text-xs text-(--color-text-tertiary)">
                  {agent.authConfigured
                    ? `${rows.length} model${rows.length === 1 ? "" : "s"}`
                    : "needs a credential"}
                </span>
                <span className="flex w-4 shrink-0 justify-end">
                  {isCurrent && <CheckIcon size={ICON_SIZE.SM} className="text-(--color-accent)" />}
                </span>
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

// ---- Model selector --------------------------------------------------------

interface ModelSelectorProps {
  agents: AgentOption[];
  activeAgentId: AgentId;
  /** Called with the whole selection — a bare id cannot say who is billing you. */
  onModelChange?: (selection: EligibleModelOption) => void;
  modelInfo: ModelInfo | null;
  /**
   * Whether the picker is bound to an active session (the in-session composer)
   * rather than composing a brand-new session (the quick-capture overlay). In a
   * new-session context the picker reads the same global session store, so
   * without this gate it would inherit a background session's state.
   */
  hasActiveSession?: boolean;
  disabled?: boolean;
}

/**
 * Which model this session runs, grouped by `(service, billing mode)` — the
 * identity a model is actually selected by (req 5), and the grouping the
 * credential, the price and the billing kind all hang off.
 */
export function ModelSelector({
  agents,
  activeAgentId,
  onModelChange,
  modelInfo,
  hasActiveSession = false,
  disabled,
}: ModelSelectorProps) {
  // docs/252 phase 4 — the optimistic pick is the whole TRIPLE, not a model id.
  // A mid-session switch across services routinely keeps the id (the same model
  // is reachable direct and through a gateway), so an id-keyed pending pick
  // showed no change at all: the trigger label and the checkmark both stayed on
  // the service the user had just moved away from, until an unrelated
  // session-list refresh happened to arrive. The server's
  // `model_selection_changed` confirmation is what clears it.
  const [pendingSelection, setPendingSelection] = useState<EligibleModelOption | undefined>(
    undefined,
  );

  const sessionId = useSessionStore((s) => s.sessionId);
  const pendingSessionRef = useRef<string | undefined>(sessionId);
  const pendingEchoRef = useRef<number>(0);
  const selectionEcho = useSessionStore((s) => (sessionId ? (s.modelSelectionEcho[sessionId] ?? 0) : 0));
  const sessions = useSessionStore((s) => s.sessions);
  const currentSession = sessionId ? sessions.find((s) => s.id === sessionId) : undefined;
  const sessionModel = currentSession?.model;

  const activeAgent = agents.find((a) => a.id === activeAgentId);
  const sessionAgent = agents.find((a) => a.id === currentSession?.agentId);
  const displayAgent = sessionAgent ?? activeAgent;

  const rows = modelRowsFor(displayAgent);
  const groups = groupRows(rows);

  // The saved slot holds a TRIPLE, and reading only its id would let the trigger
  // and checkmark land on a different `(service, mode)` from the one Quick
  // Capture goes on to send — with the same id under a subscription and a key,
  // the picker would show the subscription row while the session billed the key.
  const savedSelection = getSavedModelSelection();
  const savedModel = savedSelection?.modelId ?? getSavedModelId();
  // docs/252 phase 4 — the seed is honoured only when the harness on display
  // actually offers it. The slot is global and the harness is not, so switching
  // harness on the new-session composer left the trigger naming the PREVIOUS
  // harness's model: a model that harness cannot run, and — once the server
  // reports what it moved the selection to — a trigger that contradicts its own
  // notice. Dropping it falls through to the first eligible row, which is what
  // the server chose.
  const seededRow =
    !hasActiveSession && savedSelection
      ? rows.find(
          (r) =>
            r.serviceId === savedSelection.serviceId
            && r.billingMode === savedSelection.billingMode
            && r.modelId === savedSelection.modelId,
        )
      : undefined;
  const seededModel =
    hasActiveSession || !savedModel
      ? undefined
      : savedSelection
        ? seededRow?.modelId
        : (rows.some((r) => r.modelId === savedModel) ? savedModel : undefined);
  const pendingForCurrentSession =
    pendingSessionRef.current === sessionId ? pendingSelection : undefined;
  const pendingModelForCurrentSession = pendingForCurrentSession?.modelId;

  // The raw model id the CLI reported running this turn. `modelInfo` is global
  // UI state, so it is trusted only when the reported model belongs to the
  // active session's agent; otherwise a session switch could show the previous
  // session's model.
  const liveModel = modelInfo?.model ?? undefined;
  const liveModelAlias = liveModel ? resolveModelAlias(liveModel) : undefined;
  const knownIds = rows.map((r) => r.modelId);
  const liveModelRow =
    liveModel
      ? (knownIds.includes(liveModel)
          ? liveModel
          : liveModelAlias && knownIds.includes(liveModelAlias)
            ? liveModelAlias
            : undefined)
      : undefined;
  const scopedLiveModel = liveModelRow ? liveModel : undefined;

  // ONE precedence, shared by the trigger label and the checkmark, so the two
  // can never contradict each other:
  //
  //   1. the optimistic pending pick — instant feedback before the next turn
  //   2. the session's persisted model — the authoritative answer to "what will
  //      this session run next", surviving reloads and session switches
  //   3. the model the CLI last reported — only meaningful for a session that
  //      never had a model explicitly picked
  //   4. localStorage's last pick, for the new-session view only, then the
  //      first eligible model
  //
  // The persisted selection deliberately outranks the live model. It used to be
  // the other way round, which made the picker contradict itself whenever the
  // two disagreed. The live model is still surfaced verbatim in the usage modal,
  // which is the right home for "what actually ran".
  const displayedModel =
    pendingModelForCurrentSession ?? sessionModel ?? scopedLiveModel ?? seededModel ?? rows[0]?.modelId;
  const selectedModel =
    pendingModelForCurrentSession ?? sessionModel ?? liveModelRow ?? seededModel ?? rows[0]?.modelId;

  // The service/mode the session actually persisted, so a duplicated model id
  // highlights the row it was chosen from rather than every row sharing the id.
  // The optimistic pick outranks it for the same reason it outranks the model:
  // a same-id cross-service switch changes ONLY this, so reading the session row
  // first would leave the checkmark on the group the user just left.
  const chosenGroupKey =
    pendingForCurrentSession?.serviceId
      ? `${pendingForCurrentSession.serviceId}:${pendingForCurrentSession.billingMode}`
      : hasActiveSession && currentSession?.serviceId && currentSession.billingMode
        ? `${currentSession.serviceId}:${currentSession.billingMode}`
        : seededRow
          ? seededRow.groupKey
          : undefined;

  // Nothing has pinned a group yet — a brand-new session with no saved pick, so
  // the model itself fell back to `rows[0]`. Resolve the group the same way, to
  // the FIRST row offering that id, because the alternative is what the live UI
  // showed: the trigger's pill naming one service while a checkmark sat on
  // every row sharing the id. One answer, read by both.
  const selectedGroupKey =
    chosenGroupKey ?? rows.find((r) => r.modelId === selectedModel)?.groupKey;

  const displayName = formatModelName(displayedModel ?? "");
  const displayedRow = rows.find(
    (r) => r.modelId === displayedModel && (!selectedGroupKey || r.groupKey === selectedGroupKey),
  ) ?? rows.find((r) => r.modelId === displayedModel);
  const triggerPill =
    displayedRow && isAmbiguous(rows, displayedModel) ? disambiguator(rows, displayedRow) : undefined;

  const handleModelSelect = useCallback(
    (row: ModelRow) => {
      pendingSessionRef.current = sessionId;
      pendingEchoRef.current = selectionEcho;
      const selection: EligibleModelOption = {
        serviceId: row.serviceId,
        serviceName: row.serviceName,
        billingMode: row.billingMode,
        modelId: row.modelId,
        label: row.label,
      };
      setPendingSelection(selection);
      onModelChange?.(selection);
    },
    [onModelChange, sessionId, selectionEcho],
  );

  // Drop the optimistic pending pick once the server has ANSWERED — which is a
  // different question from "the row now matches", and the difference is the
  // whole point: a REFUSED pick leaves the row exactly as it was, so a
  // match-only rule would leave the trigger and the checkmark claiming a service
  // the session is not on, indefinitely and invisibly (a same-id cross-service
  // pick changes nothing else on screen). The echo counter says the server
  // answered, whichever way it answered.
  //
  // The row-match clear stays as the fast path for a confirmation that arrives
  // as a session-list refresh rather than as our own echo, and it compares the
  // whole triple: a same-id cross-service pick would otherwise clear on the
  // model alone and snap the checkmark back to the old group. The
  // CLI-confirmation clear stays as the escape hatch for a pick the server never
  // answered at all, so a stale pending pick can't outlive a turn.
  const prevLiveRef = useRef(liveModel);
  const sessionMatchesPending =
    !!pendingSelection
    && sessionModel === pendingSelection.modelId
    && (!pendingSelection.serviceId
      || (currentSession?.serviceId === pendingSelection.serviceId
        && currentSession.billingMode === pendingSelection.billingMode));
  if (pendingSelection && selectionEcho > pendingEchoRef.current) {
    setPendingSelection(undefined);
  } else if (sessionMatchesPending) {
    setPendingSelection(undefined);
  } else if (pendingSelection && liveModel && liveModel !== prevLiveRef.current) {
    setPendingSelection(undefined);
  }
  prevLiveRef.current = liveModel;

  return (
    <div data-testid="model-selector">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            disabled={disabled}
            className={`flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-lg transition-colors font-medium text-(--color-text-secondary) disabled:opacity-50 disabled:cursor-not-allowed ${
              disabled ? "cursor-default" : "hover:bg-(--color-bg-hover) cursor-pointer"
            }`}
            aria-label="Model selector"
            data-testid="model-trigger"
          >
            <span>{displayName || "Loading..."}</span>
            {triggerPill && (
              <span className="text-(--color-text-tertiary)" data-testid="model-trigger-service">
                {triggerPill}
              </span>
            )}
            {!disabled && <CaretDownIcon size={ICON_SIZE.XS} />}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="end" className="w-60" data-testid="model-dropdown">
          {groups.map((group) => (
            <div key={group.key || "__ungrouped__"}>
              {group.serviceName && (
                <DropdownMenuLabel className="flex items-center gap-2">
                  <span>{group.serviceName}</span>
                  <span className="text-(--color-text-tertiary) normal-case tracking-normal font-normal">
                    {group.billingMode === "sub" ? "Subscription" : "API key"}
                  </span>
                </DropdownMenuLabel>
              )}
              {group.rows.map((row) => {
                const isCurrentModel =
                  selectedModel === row.modelId
                  && (!selectedGroupKey || !row.groupKey || row.groupKey === selectedGroupKey);
                return (
                  <DropdownMenuItem
                    key={`${row.groupKey}-${row.modelId}`}
                    onSelect={() => handleModelSelect(row)}
                    className={`pl-5 pr-3 py-1.5 text-sm ${
                      isCurrentModel ? "bg-(--color-accent-subtle) text-(--color-text-link)" : ""
                    }`}
                    data-testid={`model-option-${row.modelId}`}
                  >
                    <span className="flex-1">{row.label || formatModelName(row.modelId)}</span>
                    <span className="flex w-4 shrink-0 justify-end">
                      {isCurrentModel && (
                        <CheckIcon size={ICON_SIZE.SM} className="text-(--color-accent)" />
                      )}
                    </span>
                  </DropdownMenuItem>
                );
              })}
            </div>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
