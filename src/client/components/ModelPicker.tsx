import { useState, useRef, useCallback } from "react";
import { formatModelName, resolveModelAlias } from "../utils/format-model.js";
import { getSavedModelId, getSavedModelSelection } from "../utils/local-storage.js";
import { newSessionAgentId } from "../utils/new-session-agent.js";
import { modelRowsFor, type ModelRow } from "../utils/model-rows.js";
import { useSessionStore } from "../stores/session-store.js";
import { DropdownMenuLabel } from "./ui/dropdown-menu.js";
import { Picker, PickerOption } from "./pickers/Picker.js";
import { BillingModePill } from "./BillingModePill.js";
import { ServiceLogo } from "./ServiceLogo.js";
import type { BillingMode, ModelSelection } from "../../server/shared/catalogue/index.js";
import type { AgentId, SessionInfo } from "../../server/shared/types.js";
import type { AgentOption, ModelChoice } from "../agent-types.js";
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

interface ModelGroup {
  key: string;

  serviceId: string;
  serviceName: string;
  billingMode: "sub" | "key";
  rows: ModelRow[];
}

/**
 * A group header: the service's mark and name at the left edge, its billing mode
 * as a coloured pill at the right.
 *
 * The pill is the same component Settings → Services puts on a card header, and
 * the right edge is where it goes because the header is a two-column statement —
 * *which service*, and *who is paying* — not a sentence. Rendered as plain
 * tertiary text run on after the name (what shipped first), the mode read as a
 * qualifier of the service rather than as the other half of the pair a model is
 * selected by (req 5).
 *
 * Shared with the composer's settings menu, which renders the same groups: two
 * copies of this markup is exactly how the two menus would drift apart.
 */
export function ModelGroupHeader({
  serviceId,
  serviceName,
  billingMode,
}: {
  /**
   * Drawn as the vendor's mark. A bare id rather than a `ServiceDef` because a
   * model row on the wire carries exactly this and a name — which is what
   * `ServiceLogo`'s `ServiceIdentity` asks for, and all it asks for.
   */
  serviceId: string;
  serviceName: string;
  billingMode: BillingMode;
}) {
  return (
    <DropdownMenuLabel className="flex items-center gap-2">
      {/* The same 12px box the rows' `leading` slot uses, so a header's mark and
          the option glyphs below it share one left edge. */}
      <span className="flex w-3 shrink-0 justify-center">
        <ServiceLogo service={{ id: serviceId, name: serviceName }} />
      </span>
      <span className="min-w-0 flex-1 truncate">{serviceName}</span>
      <BillingModePill billingMode={billingMode} data-testid={`model-group-mode-${billingMode}`} />
    </DropdownMenuLabel>
  );
}

function groupRows(rows: ModelRow[]): ModelGroup[] {
  const groups: ModelGroup[] = [];
  for (const row of rows) {
    let group = groups.find((g) => g.key === row.groupKey);
    if (!group) {
      group = {
        key: row.groupKey,
        serviceId: row.serviceId,
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
 * The session this composer is bound to, or `undefined` when it is bound to
 * none.
 *
 * The session store is global and these selectors are not: they are rendered by
 * the in-session composer, by the new-session composer, and by Quick Capture,
 * and only the first two have a session of their own. Reading
 * `sessions.find(id === store.sessionId)` unconditionally is what made Quick
 * Capture describe whichever session happened to be active *behind* it — a
 * session it will never send to.
 *
 * `seedFromHistory` is the caller's answer to "is a session bound", and it is
 * NOT the same question as `hasActiveSession`: the new-session route claims a
 * warm session up front and talks to it (`set_agent` goes over its socket), so
 * it has `hasActiveSession: false` and a bound session at the same time.
 */
/**
 * The `(service, mode, model)` the reasoning picker must narrow its levels by
 * (docs/274 req 14) — the selection this composer is describing, whether that is
 * a bound session's or the seed a new one would start from.
 *
 * It lives here, beside `useModelPickerState`, and is derived rather than passed
 * because the two must not disagree: the composer renders the model and the
 * reasoning controls as SIBLINGS, so threading a selection between them would
 * put the same rule in two places, and the wrong one shows a level the CLI
 * discards. Both now read the same session and the same seed.
 *
 * `undefined` when nothing names a whole selection, which falls back to the
 * harness's full vocabulary — the pre-catalogue behaviour, and the only honest
 * answer when there is no row to ask about.
 */
export function useBoundModelSelection(seedFromHistory: boolean): ModelSelection | undefined {
  const sessionId = useSessionStore((s) => s.sessionId);
  const sessions = useSessionStore((s) => s.sessions);
  const session = boundSession(sessions, sessionId, seedFromHistory);
  if (session?.serviceId && session.billingMode && session.model) {
    return { serviceId: session.serviceId, billingMode: session.billingMode, modelId: session.model };
  }

  // must be honest about.
  return getSavedModelSelection() ?? undefined;
}

function boundSession(
  sessions: SessionInfo[],
  storeSessionId: string | undefined,
  seedFromHistory: boolean,
): SessionInfo | undefined {
  if (seedFromHistory || !storeSessionId) return undefined;
  return sessions.find((s) => s.id === storeSessionId);
}

function displayedHarness(
  agents: AgentOption[],
  activeAgentId: AgentId,
  session: SessionInfo | undefined,
  seedFromHistory: boolean,
): string {
  if (seedFromHistory) return newSessionAgentId(agents);
  return session?.agentId ?? activeAgentId;
}

interface HarnessSelectorProps {
  agents: AgentOption[];
  activeAgentId: AgentId;
  onAgentChange: (agentId: AgentId) => void;

  hasActiveSession?: boolean;

  seedFromHistory?: boolean;
  disabled?: boolean;
}

/**
 * The harness state this control and docs/260's composer settings menu both
 * render. Extracted so the menu's Harness panel cannot drift from the standalone
 * selector — in particular the pinned-session rule, which is the one fact about
 * a session that is irreversible.
 */
export function useHarnessPickerState({
  agents,
  activeAgentId,
  hasActiveSession = false,
  seedFromHistory = false,
}: {
  agents: AgentOption[];
  activeAgentId: AgentId;
  hasActiveSession?: boolean;
  seedFromHistory?: boolean;
}) {
  const sessionId = useSessionStore((s) => s.sessionId);
  const sessions = useSessionStore((s) => s.sessions);
  const currentSession = boundSession(sessions, sessionId, seedFromHistory);
  const pinnedAgentId =
    hasActiveSession && currentSession?.agentPinned ? currentSession.agentId : undefined;

  // visible, because that is actionable.
  const installed = agents.filter((a) => a.installed);
  const currentAgentId = displayedHarness(agents, activeAgentId, currentSession, seedFromHistory);
  const displayAgent = agents.find((a) => a.id === currentAgentId);
  return {
    installed,
    displayAgent,
    currentAgentId,
    locked: !!pinnedAgentId,
    /** Never empty — the settings-menu anchor has no other text to fall back on. */
    harnessName: displayAgent?.name ?? "Loading...",
  };
}

/** The `title` explaining why a pinned harness cannot be changed. Shared with the menu. */
export function lockedHarnessReason(harnessName: string): string {
  return `${harnessName}: fixed for this session after the first message. Models stay switchable.`;
}

export function HarnessSelector({
  agents,
  activeAgentId,
  onAgentChange,
  hasActiveSession = false,
  seedFromHistory = false,
  disabled,
}: HarnessSelectorProps) {
  const { installed, currentAgentId, locked, harnessName } = useHarnessPickerState({
    agents,
    activeAgentId,
    hasActiveSession,
    seedFromHistory,
  });

  return (
    <div data-testid="harness-selector">
      <Picker
        label={harnessName}
        locked={locked}
        lockedTitle={lockedHarnessReason(harnessName)}
        ariaLabel={`Harness selector: ${harnessName}`}
        triggerTestId="harness-trigger"
        menuTestId="harness-dropdown"
        menuWidth="w-56"

        whenEmpty="readout"
        side="top"
        align="end"
        disabled={disabled}
      >
        {installed.map((agent) => {
          const rows = modelRowsFor(agent);
          return (

            <PickerOption
              key={agent.id}
              label={agent.name}
              detail={
                agent.hasRunnableModels
                  ? `${rows.length} model${rows.length === 1 ? "" : "s"} available`
                  : "needs a credential"
              }
              selected={agent.id === currentAgentId}
              disabled={!agent.hasRunnableModels}
              onSelect={() => onAgentChange(agent.id as AgentId)}
              testId={`harness-option-${agent.id}`}
            />
          );
        })}
      </Picker>
    </div>
  );
}

interface ModelSelectorProps {
  agents: AgentOption[];
  activeAgentId: AgentId;
  /** Called with the whole selection — a bare id cannot say who is billing you. */
  onModelChange?: (selection: ModelChoice) => void;
  modelInfo: ModelInfo | null;

  hasActiveSession?: boolean;

  seedFromHistory?: boolean;
  disabled?: boolean;
}

/**
 * Everything needed to render the model choice, in one place.
 *
 * docs/260 — extracted from {@link ModelSelector} because the composer's
 * settings menu needs exactly this and a second copy would drift. The precedence
 * below is the subtle part: the trigger label and the checkmark read the SAME
 * resolution, so they can never contradict each other, and the pending pick is
 * the whole `(service, mode, model)` triple rather than an id. Both properties
 * were bugs once; see the comments inline.
 */
export function useModelPickerState({
  agents,
  activeAgentId,
  onModelChange,
  modelInfo,
  hasActiveSession = false,
  seedFromHistory = false,
}: {
  agents: AgentOption[];
  activeAgentId: AgentId;
  onModelChange?: (selection: ModelChoice) => void;
  modelInfo: ModelInfo | null;
  hasActiveSession?: boolean;
  seedFromHistory?: boolean;
}) {

  const [pendingSelection, setPendingSelection] = useState<ModelChoice | undefined>(
    undefined,
  );

  const sessionId = useSessionStore((s) => s.sessionId);
  const pendingSessionRef = useRef<string | undefined>(sessionId);
  const pendingEchoRef = useRef<number>(0);
  const selectionEcho = useSessionStore((s) => (sessionId ? (s.modelSelectionEcho[sessionId] ?? 0) : 0));
  const sessions = useSessionStore((s) => s.sessions);
  const currentSession = boundSession(sessions, sessionId, seedFromHistory);
  const sessionModel = currentSession?.model;

  const displayAgent = agents.find(
    (a) => a.id === displayedHarness(agents, activeAgentId, currentSession, seedFromHistory),
  );

  const rows = modelRowsFor(displayAgent);
  const groups = groupRows(rows);

  const savedSelection = getSavedModelSelection();
  const savedModel = savedSelection?.modelId ?? getSavedModelId();

  // harness's model: a model that harness cannot run, and — once the server

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

  const liveModel = seedFromHistory ? undefined : (modelInfo?.model ?? undefined);
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

  // can never contradict each other:

  //      never had a model explicitly picked

  const displayedModel =
    pendingModelForCurrentSession ?? sessionModel ?? scopedLiveModel ?? seededModel ?? rows[0]?.modelId;
  const selectedModel =
    pendingModelForCurrentSession ?? sessionModel ?? liveModelRow ?? seededModel ?? rows[0]?.modelId;

  const chosenGroupKey =
    pendingForCurrentSession?.serviceId
      ? `${pendingForCurrentSession.serviceId}:${pendingForCurrentSession.billingMode}`
      : hasActiveSession && currentSession?.serviceId && currentSession.billingMode
        ? `${currentSession.serviceId}:${currentSession.billingMode}`
        : seededRow
          ? seededRow.groupKey
          : undefined;

  // the FIRST row offering that id, because the alternative is what the live UI

  const selectedGroupKey =
    chosenGroupKey ?? rows.find((r) => r.modelId === selectedModel)?.groupKey;

  /**
   * The trigger's label — **never empty, and never "Loading…" for a state that
   * is not loading.**
   *
   * There is no model to name in two unrelated situations and they used to read
   * alike, because the trigger printed `displayName || "Loading..."`: before the
   * agent list has arrived (genuinely loading, one frame), and when the install
   * has **no runnable model at all** — no credential yet, or none an installed
   * harness can carry (docs/252 req 8). The second is the whole first-run state,
   * and it is permanent until the user adds a service, so the composer sat there
   * saying "Loading…" for ever next to a disabled input telling them to add a
   * service. Answering it here rather than at the trigger keeps the wide row and
   * `ComposerSettingsMenu` on one answer.
   */
  const displayName =
    formatModelName(displayedModel ?? "") || (agents.length > 0 ? "No model" : "Loading...");

  const handleModelSelect = useCallback(
    (row: ModelRow) => {
      pendingSessionRef.current = sessionId;
      pendingEchoRef.current = selectionEcho;
      const selection: ModelChoice = {
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

  // CLI-confirmation clear stays as the escape hatch for a pick the server never

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

  return {
    groups,
    /** The name on the trigger / anchor. Never empty — see its definition above. */
    displayName,

    selectedModel,
    selectedGroupKey,
    handleModelSelect,
  };
}

export function ModelSelector({
  agents,
  activeAgentId,
  onModelChange,
  modelInfo,
  hasActiveSession = false,
  seedFromHistory = false,
  disabled,
}: ModelSelectorProps) {
  const {
    groups,
    displayName,
    selectedModel,
    selectedGroupKey,
    handleModelSelect,
  } = useModelPickerState({
    agents,
    activeAgentId,
    onModelChange,
    modelInfo,
    hasActiveSession,
    seedFromHistory,
  });

  return (
    <div data-testid="model-selector">
      <Picker
        label={displayName}
        ariaLabel="Model selector"
        triggerTestId="model-trigger"
        menuTestId="model-dropdown"
        menuWidth="w-60"

        whenEmpty="readout"
        side="top"
        align="end"
        disabled={disabled}
      >
        {groups.map((group) => (
          <div key={group.key || "__ungrouped__"}>
            {group.serviceName && (
              <ModelGroupHeader
                serviceId={group.serviceId}
                serviceName={group.serviceName}
                billingMode={group.billingMode}
              />
            )}
            {group.rows.map((row) => (
              <PickerOption
                key={`${row.groupKey}-${row.modelId}`}
                label={row.label || formatModelName(row.modelId)}
                selected={
                  selectedModel === row.modelId
                  && (!selectedGroupKey || !row.groupKey || row.groupKey === selectedGroupKey)
                }
                onSelect={() => handleModelSelect(row)}
                testId={`model-option-${row.modelId}`}
                indent
              />
            ))}
          </div>
        ))}
      </Picker>
    </div>
  );
}
