import { useState } from "react";
import {
  BrainIcon,
  CaretDownIcon,
  CaretLeftIcon,
  CaretRightIcon,
  CheckIcon,
  FastForwardIcon,
  LockIcon,
  NotepadIcon,
  RobotIcon,
  ShieldCheckIcon,
  SlidersHorizontalIcon,
  SparkleIcon,
} from "@phosphor-icons/react";
import { ICON_SIZE } from "../../design-tokens.js";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "../ui/dropdown-menu.js";
import {
  ModelGroupHeader,
  useHarnessPickerState,
  useModelPickerState,
} from "../ModelPicker.js";
import { modelRowsFor } from "../../utils/model-rows.js";
import { useReasoningPickerState } from "../ReasoningSelector.js";
import { formatModelName } from "../../utils/format-model.js";
import type { AgentId, PermissionMode } from "../../../server/shared/types.js";
import type { AgentOption, ModelChoice } from "../../agent-types.js";
import type { ModelInfo } from "../../utils/model-info.js";

/**
 * docs/260 — the composer's single settings control, used when the composer is
 * narrower than 700px (req 3). Permission mode, harness, model and reasoning all
 * live behind it, and the anchor carries the current model's name (req 4, req 6).
 *
 * **Drill-down, not Radix submenus.** One menu body swaps between a root list and
 * one panel at a time, with a back header. Radix's `Sub` primitives anchor a
 * second floating menu to the side on hover, which is the wrong interaction on
 * touch — where this layout lives most of the time. Two levels rather than one
 * flat list because the menu has to survive catalogue growth (req 11): the root
 * stays four rows however many models or reasoning levels a harness offers.
 *
 * **The anchor never reacts to the permission mode.** The mode's own icon appears
 * on the menu's Mode row instead (req 12). The consequence — guarded and plan are
 * invisible until the menu opens — was accepted deliberately; see the receipts in
 * `docs/260-composer-toolbar-layout/requirements.md`.
 */

const MODE_META: Record<PermissionMode, { label: string; icon: typeof NotepadIcon; description: string }> = {
  plan: {
    label: "Plan",
    icon: NotepadIcon,
    description: "Read-only — research and plan, no edits.",
  },
  guarded: {
    label: "Guarded",
    icon: ShieldCheckIcon,
    description: "Autonomous — commands are safety-checked before running.",
  },
  auto: {
    label: "Auto",
    icon: FastForwardIcon,
    description: "Autonomous — no command safety check.",
  },
};

/** Display order: most → least oversight, matching `PermissionModeSelector`. */
const LADDER: PermissionMode[] = ["plan", "guarded", "auto"];

type Panel = "root" | "mode" | "harness" | "model" | "reasoning";

/** One root row: an icon, a label, the current value, and a chevron when it drills down. */
function RootRow({
  icon,
  label,
  value,
  valueAccent,
  onSelect,
  trailing,
  testId,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  /** Tint the value when it is not the default — currently only a non-auto mode. */
  valueAccent?: boolean;
  onSelect?: () => void;
  trailing?: React.ReactNode;
  testId: string;
}) {
  return (
    <DropdownMenuItem
      // ALWAYS prevent default, including on a row with nothing to open. Radix
      // closes the menu on select, so an inert row (a pinned harness) would
      // otherwise dismiss the whole thing on a tap that changed nothing — which
      // reads as a misfire. Rows here navigate or do nothing; none of them commit.
      onSelect={(e) => {
        e.preventDefault();
        onSelect?.();
      }}
      // A row with nothing to open is inert, and must SAY so: without this it
      // keeps enabled menu-item semantics and a screen reader announces a
      // pinned harness (or a picker locked mid-turn) as actionable, where
      // activating it silently does nothing. `aria-disabled` rather than
      // `disabled` so the row stays focusable and its value is still readable.
      aria-disabled={onSelect ? undefined : true}
      className={`px-3 py-2 text-sm ${onSelect ? "" : "cursor-default opacity-60"}`}
      data-testid={testId}
    >
      {icon}
      <span className="flex-1 min-w-0 truncate">{label}</span>
      <span
        className={`text-xs truncate max-w-[9rem] ${
          valueAccent ? "text-(--color-accent)" : "text-(--color-text-tertiary)"
        }`}
      >
        {value}
      </span>
      {trailing ?? (onSelect ? <CaretRightIcon size={ICON_SIZE.XS} className="shrink-0" /> : null)}
    </DropdownMenuItem>
  );
}

/** A panel's back header. Returns to the root without closing the menu. */
function PanelHeader({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <DropdownMenuItem
      onSelect={(e) => {
        e.preventDefault();
        onBack();
      }}
      className="px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-(--color-text-tertiary)"
      data-testid="composer-settings-back"
    >
      <CaretLeftIcon size={ICON_SIZE.XS} />
      <span>{title}</span>
    </DropdownMenuItem>
  );
}

/** A leaf choice: label, optional description, and a checkmark when it is current. */
function ChoiceRow({
  icon,
  label,
  description,
  isCurrent,
  disabled,
  onSelect,
  testId,
}: {
  icon?: React.ReactNode;
  label: string;
  description?: string;
  isCurrent: boolean;
  disabled?: boolean;
  onSelect: () => void;
  testId: string;
}) {
  return (
    <DropdownMenuItem
      disabled={disabled}
      onSelect={() => {
        if (!disabled) onSelect();
      }}
      className={`items-start px-3 py-2 text-sm ${
        isCurrent ? "bg-(--color-accent-subtle) text-(--color-text-link)" : ""
      }`}
      data-testid={testId}
    >
      {icon}
      <span className="flex-1 min-w-0">
        <span className="block truncate">{label}</span>
        {description && (
          <span className="block text-xs text-(--color-text-tertiary) mt-0.5">{description}</span>
        )}
      </span>
      <span className="flex w-4 shrink-0 justify-end">
        {isCurrent && <CheckIcon size={ICON_SIZE.SM} className="text-(--color-accent)" />}
      </span>
    </DropdownMenuItem>
  );
}

export function ComposerSettingsMenu({
  agents,
  activeAgentId,
  onAgentChange,
  onModelChange,
  onReasoningChange,
  sessionReasoning,
  modelInfo,
  hasActiveSession = false,
  seedFromHistory = false,
  permissionMode,
  onPermissionModeChange,
  guardedModelOk = true,
  disabled = false,
  pickersLocked = false,
}: {
  agents: AgentOption[];
  activeAgentId: AgentId;
  onAgentChange?: (agentId: AgentId) => void;
  onModelChange?: (selection: ModelChoice) => void;
  onReasoningChange?: (effort: string | null) => void;
  sessionReasoning?: string;
  modelInfo: ModelInfo | null;
  hasActiveSession?: boolean;
  /**
   * "This composer is bound to no session" — Quick Capture, and the new-session
   * composer before it claims one. Deliberately NOT the same question as
   * `hasActiveSession`, and the wide row answers them separately for the same
   * reason: the harness and model pickers take `!sessionId` (a session store the
   * composer may not own) while reasoning takes `!hasActiveSession`. Reading the
   * store unconditionally is what made Quick Capture describe whichever session
   * happened to be active behind it.
   */
  seedFromHistory?: boolean;
  permissionMode: PermissionMode;
  onPermissionModeChange?: (mode: PermissionMode) => void;
  /** False when the effective model cannot run guarded (Haiku) — same gate the standalone selector applies. */
  guardedModelOk?: boolean;
  /** The composer is dead as a whole (docs/257 `disabledReason`) — the anchor does not open. */
  disabled?: boolean;
  /**
   * A turn is running, so the harness, model and reasoning cannot change until
   * it ends — exactly what the wide row expresses by disabling those three
   * triggers.
   *
   * It deliberately does NOT disable the anchor. Everything behind it would
   * become unreadable mid-turn, and the permission mode — which the wide row
   * leaves changeable while a turn runs — would silently stop working here.
   * So the anchor still opens, and only the three rows that must not move are
   * inert.
   */
  pickersLocked?: boolean;
}) {
  const [panel, setPanel] = useState<Panel>("root");

  const harness = useHarnessPickerState({ agents, activeAgentId, hasActiveSession, seedFromHistory });
  const model = useModelPickerState({
    agents,
    activeAgentId,
    onModelChange,
    modelInfo,
    hasActiveSession,
    seedFromHistory,
  });
  const reasoning = useReasoningPickerState({
    agent: harness.displayAgent,
    sessionReasoning,
    onChange: onReasoningChange ?? (() => {}),
    // `hasActiveSession`, not `seedFromHistory` — the two selectors answer
    // different questions and the wide row splits them the same way.
    seedFromHistory: !hasActiveSession,
  });

  // Only modes the harness advertises, plus `auto`, which every harness runs.
  const supported = harness.displayAgent?.supportedPermissionModes ?? [];
  const availableModes = LADDER.filter((m) => m === "auto" || supported.includes(m));
  const displayMode: PermissionMode = availableModes.includes(permissionMode)
    ? permissionMode
    : "auto";
  const modeMeta = MODE_META[displayMode];
  const ModeIcon = modeMeta.icon;
  const modeIsDefault = displayMode === "auto";
  const canPickMode = !!onPermissionModeChange && availableModes.length > 1;

  // `displayName` is never empty — it answers "loading" and "nothing to pick"
  // itself, so this layout cannot label the second one as the first.
  const modelName = model.displayName;

  return (
    <DropdownMenu
      onOpenChange={(open) => {
        // Always reopen at the root — a panel left behind from last time reads
        // as the menu having lost its place.
        if (!open) setPanel("root");
      }}
    >
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          // req 9 — the anchor shows one name but stands for four settings, so it
          // says so out loud rather than relying on the icon.
          aria-label={`Settings — model: ${modelName}`}
          title={`Model: ${modelName}. Opens harness, model, reasoning and permission mode.`}
          data-testid="composer-settings-trigger"
          // `flex-[0_1_auto] min-w-0` is what makes the model name the elastic
          // thing in the row: it is the only item allowed to shrink, so it
          // truncates before anything else is clipped (req 8).
          className="flex flex-[0_1_auto] min-w-0 items-center gap-1.5 overflow-hidden rounded-lg p-1.5 text-xs font-medium text-(--color-text-secondary) transition-colors hover:bg-(--color-bg-hover) disabled:cursor-not-allowed disabled:opacity-50"
        >
          <SlidersHorizontalIcon
            size={ICON_SIZE.SM}
            className="shrink-0 text-(--color-text-tertiary)"
          />
          <span className="truncate" data-testid="composer-settings-model-name">
            {modelName}
          </span>
          <CaretDownIcon size={ICON_SIZE.XS} className="shrink-0" />
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent
        side="top"
        align="start"
        className="w-72"
        data-testid="composer-settings-menu"
      >
        {panel === "root" && (
          <>
            <RootRow
              testId="composer-settings-row-mode"
              icon={
                <ModeIcon
                  size={ICON_SIZE.SM}
                  weight={modeIsDefault ? "regular" : "fill"}
                  className={`shrink-0 ${modeIsDefault ? "" : "text-(--color-accent)"}`}
                />
              }
              label="Mode"
              value={modeMeta.label}
              valueAccent={!modeIsDefault}
              onSelect={canPickMode ? () => setPanel("mode") : undefined}
            />
            {onAgentChange && (
              <RootRow
                testId="composer-settings-row-harness"
                icon={<RobotIcon size={ICON_SIZE.SM} className="shrink-0" />}
                label="Harness"
                value={harness.harnessName}
                onSelect={harness.locked || pickersLocked ? undefined : () => setPanel("harness")}
                trailing={
                  harness.locked ? (
                    <LockIcon
                      size={ICON_SIZE.XS}
                      className="shrink-0 text-(--color-text-tertiary)"
                    />
                  ) : undefined
                }
              />
            )}
            {harness.locked && (
              <p className="px-3 pb-2 pl-10 text-xs text-(--color-text-tertiary)">
                Fixed after the first message. Models stay switchable.
              </p>
            )}
            {pickersLocked && (
              <p
                className="px-3 pb-2 pl-10 text-xs text-(--color-text-tertiary)"
                data-testid="composer-settings-turn-notice"
              >
                Harness, model and reasoning are fixed while a turn is running.
              </p>
            )}
            {onAgentChange && (
              <RootRow
                testId="composer-settings-row-model"
                icon={<SparkleIcon size={ICON_SIZE.SM} className="shrink-0" />}
                label="Model"
                value={modelName}
                onSelect={pickersLocked ? undefined : () => setPanel("model")}
              />
            )}
            {reasoning && onReasoningChange && (
              <RootRow
                testId="composer-settings-row-reasoning"
                icon={<BrainIcon size={ICON_SIZE.SM} className="shrink-0" />}
                label={reasoning.label}
                value={reasoning.currentLabel}
                onSelect={pickersLocked ? undefined : () => setPanel("reasoning")}
              />
            )}
          </>
        )}

        {panel === "mode" && (
          <>
            <PanelHeader title="Permission mode" onBack={() => setPanel("root")} />
            <DropdownMenuSeparator />
            {availableModes.map((m) => {
              const meta = MODE_META[m];
              const Icon = meta.icon;
              const blocked = m === "guarded" && !guardedModelOk;
              return (
                <ChoiceRow
                  key={m}
                  testId={`composer-settings-mode-${m}`}
                  icon={
                    <Icon
                      size={ICON_SIZE.SM}
                      className="mt-0.5 shrink-0"
                      weight={m === displayMode ? "fill" : "regular"}
                    />
                  }
                  label={`${meta.label} mode`}
                  description={
                    blocked ? "Guarded mode needs a Sonnet or Opus model." : meta.description
                  }
                  isCurrent={m === displayMode}
                  disabled={blocked}
                  onSelect={() => onPermissionModeChange?.(m)}
                />
              );
            })}
          </>
        )}

        {panel === "harness" && (
          <>
            <PanelHeader title="Harness" onBack={() => setPanel("root")} />
            <DropdownMenuSeparator />
            {harness.installed.map((agent) => {
              const count = modelRowsFor(agent).length;
              return (
                <ChoiceRow
                  key={agent.id}
                  testId={`composer-settings-harness-${agent.id}`}
                  label={agent.name}
                  description={
                    agent.hasRunnableModels
                      ? `${count} model${count === 1 ? "" : "s"} available`
                      : "needs a credential"
                  }
                  isCurrent={agent.id === harness.currentAgentId}
                  disabled={!agent.hasRunnableModels}
                  onSelect={() => onAgentChange?.(agent.id as AgentId)}
                />
              );
            })}
          </>
        )}

        {panel === "model" && (
          <>
            <PanelHeader title="Model" onBack={() => setPanel("root")} />
            <DropdownMenuSeparator />
            {model.groups.map((group) => (
              <div key={group.key || "__ungrouped__"}>
                {group.serviceName && (
                  <ModelGroupHeader
                    serviceName={group.serviceName}
                    billingMode={group.billingMode}
                  />
                )}
                {group.rows.map((row) => (
                  <ChoiceRow
                    key={`${row.groupKey}-${row.modelId}`}
                    testId={`composer-settings-model-${row.modelId}`}
                    label={row.label || formatModelName(row.modelId)}
                    isCurrent={
                      model.selectedModel === row.modelId
                      && (!model.selectedGroupKey
                        || !row.groupKey
                        || row.groupKey === model.selectedGroupKey)
                    }
                    onSelect={() => model.handleModelSelect(row)}
                  />
                ))}
              </div>
            ))}
          </>
        )}

        {panel === "reasoning" && reasoning && (
          <>
            <PanelHeader title={reasoning.label} onBack={() => setPanel("root")} />
            <DropdownMenuSeparator />
            {reasoning.options.map((opt) => (
              <ChoiceRow
                key={opt.value ?? "__default__"}
                testId={`composer-settings-reasoning-${opt.value ?? "default"}`}
                label={opt.label}
                isCurrent={(opt.value ?? undefined) === (reasoning.current ?? undefined)}
                onSelect={() => reasoning.select(opt.value)}
              />
            ))}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
