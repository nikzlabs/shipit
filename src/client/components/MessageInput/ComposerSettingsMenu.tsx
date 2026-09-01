import { useState } from "react";
import {
  BaseballCapIcon,
  BrainIcon,
  CaretDownIcon,
  CaretLeftIcon,
  CaretRightIcon,
  CheckIcon,
  LockIcon,
  RobotIcon,
  SlidersHorizontalIcon,
  SparkleIcon,
} from "@phosphor-icons/react";
import { INSET_FOCUS_RING, ICON_SIZE } from "../../design-tokens.js";
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
import {
  ROLE_LOCKED_REASON,
  ROLE_PILL_CLASS,
  roleUnavailableDetail,
  useRolePickerState,
} from "./RoleSelector.js";
import type { AgentId } from "../../../server/shared/types.js";
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
 * docs/285 — the permission mode is NOT behind this anchor at all any more. It
 * moved to the composer row's own control, alongside network access, on every
 * viewport (reqs 5, 6). docs/260 req 12's "the anchor never reacts to the mode"
 * is therefore moot rather than upheld: there is no mode here to react to.
 */


type Panel = "root" | "harness" | "model" | "reasoning" | "role";

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
  keepOpen,
  testId,
}: {
  icon?: React.ReactNode;
  label: string;
  description?: string;
  isCurrent: boolean;
  disabled?: boolean;
  onSelect: () => void;
  /**
   * docs/272 req 15 — this row NAVIGATES rather than commits, so the menu must
   * survive it. "Adjust parameters…" brings the harness, model and level rows
   * back into this same menu; closing on the tap would put the user one reopen
   * away from the thing they just asked to see. The root rows prevent default
   * for exactly this reason.
   */
  keepOpen?: boolean;
  testId: string;
}) {
  return (
    <DropdownMenuItem
      disabled={disabled}
      onSelect={(e) => {
        if (keepOpen) e.preventDefault();
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
  disabled = false,
  pickersLocked = false,
  onRoleChange,
  sessionRoleName,
  roleParamsRevealed = true,
  onAdjustRoleParameters,
  onRoleSelected,
  onLeaveRole,
  roleLocked = false,
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
  /** The composer is dead as a whole (docs/257 `disabledReason`) — the anchor does not open. */
  disabled?: boolean;
  /**
   * A turn is running, so the harness, model and reasoning cannot change until
   * it ends — exactly what the wide row expresses by disabling those three
   * triggers.
   *
   * It deliberately does NOT disable the anchor. Everything behind it would
   * become unreadable mid-turn. So the anchor still opens, and only the three
   * rows that must not move are inert.
   */
  pickersLocked?: boolean;
  /**
   * docs/272-user-selectable-roles reqs 1, 18 — start this session on the named
   * role, or take the role off it with `undefined`.
   */
  onRoleChange?: (roleName: string | undefined) => void;
  /** docs/272 req 5 — the role IN FORCE, which replaces the three rows below it. */
  sessionRoleName?: string;
  /** docs/272 req 15 — "Adjust parameters…" was chosen, so the three rows are back. */
  roleParamsRevealed?: boolean;
  onAdjustRoleParameters?: () => void;
  /** Told when a role is picked, so the caller can fold the parameters away again. */
  onRoleSelected?: () => void;
  /**
   * docs/272 req 15 — told when one of the three controls a role set was moved
   * from inside this menu, so a composer with no session bound (which has no
   * server answer to follow) stops naming the role.
   */
  onLeaveRole?: () => void;
  /**
   * docs/272 req 4 — the first turn has run, so no role can be CHOSEN any more.
   * Not "no role applies": the Role row still names the role in force, and still
   * opens onto the parameters it set until those have been asked for
   * (`roleRowOpens`).
   */
  roleLocked?: boolean;
}) {
  // Initialised below the row-shape computation, which decides whether a root
  // exists worth showing at all (req 9).
  const [panel, setPanel] = useState<Panel>("root");
  const { roles, hasRoles } = useRolePickerState();
  // docs/272 req 16 — offered only once the user has a role of their own; a role
  // still in force keeps its row even if the list has since emptied, or the row
  // naming the session would vanish while the session still runs as it.
  const showRole = !!onRoleChange && (hasRoles || !!sessionRoleName);
  // req 5 — the three rows the role replaced, folded away until asked for. The
  // lock is deliberately not in this: it takes the choice of role, not the route
  // to what the role set (req 4), and it does not put the rows back unasked.
  const showParams = !sessionRoleName || roleParamsRevealed;
  // …which is why the Role row still opens once locked. What is behind it there
  // is "Adjust parameters…" and no roles; once those have been asked for there is
  // nothing left, and the row goes inert rather than opening onto an empty panel.
  const roleRowOpens =
    !pickersLocked && (!roleLocked || (!!sessionRoleName && !roleParamsRevealed));
  /**
   * docs/285 req 9 — the root must never be a level that exists only to lead
   * somewhere else.
   *
   * Under a role with its parameters folded away, removing the Mode row leaves
   * exactly one row on the root: Role, whose only job is to open the role panel.
   * Deleting the row was necessary and not sufficient — the user still traverses
   * the nesting. So when Role is all that would be there, the menu opens ONTO the
   * role list and the root is skipped entirely.
   *
   * Not "under a role": under the *shape* where nothing else is offered. A role
   * whose parameters have been revealed has four rows and a real root, and a
   * session with no role but a locked picker set is not this case either.
   */
  const rootIsRoleAlone = showRole && !showParams && roleRowOpens;
  /**
   * The panel actually rendered. Derived rather than stored, because the shape
   * above depends on props that can change while the menu is mounted (a role is
   * chosen, "Adjust parameters…" is used) — a `useState` initialiser would be
   * read once, on the first render, and then be wrong.
   */
  const activePanel: Panel = rootIsRoleAlone && panel === "root" ? "role" : panel;

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

  // `displayName` is never empty — it answers "loading" and "nothing to pick"
  // itself, so this layout cannot label the second one as the first.
  const modelName = model.displayName;
  // docs/272-user-selectable-roles req 5, in docs/260's layout — **the anchor carries the ROLE's
  // name while one is in force**, not the model's.
  //
  // docs/260 req 4 gave the anchor the model name because the model was the most
  // consequential of the four things behind it. A role outranks it on exactly
  // that test: it IS the harness, the model and the level, and it is what the
  // user chose. Leaving the model there put a role's name inside the menu and a
  // model beside it on the row — two answers to "what does this session run on",
  // and under a role the model is the less true of the two, since the row it
  // comes from may not even be readable yet (a warm session's is not).
  const anchorName = sessionRoleName ?? modelName;

  return (
    <DropdownMenu
      onOpenChange={(open) => {
        // Always reopen at the menu's OWN starting point — a panel left behind
        // from last time reads as the menu having lost its place. That start is
        // the role list rather than the root when the root would hold nothing
        // but the row leading to it (req 9).
        if (!open) setPanel("root");
      }}
    >
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          // req 9 — the anchor shows one name but stands for four settings, so it
          // says so out loud rather than relying on the icon.
          aria-label={
            sessionRoleName
              ? `Settings — role: ${sessionRoleName}`
              : `Settings — model: ${modelName}`
          }
          title={
            sessionRoleName
              ? `Role: ${sessionRoleName}. Opens the roles, and the settings this one sets.`
              : `Model: ${modelName}. Opens harness, model and reasoning.`
          }
          data-testid="composer-settings-trigger"
          // `flex-[0_1_auto] min-w-0` is what makes the name the elastic thing in
          // the row: it is the only item allowed to shrink, so it truncates
          // before anything else is clipped (req 8). That stays true in both
          // appearances below — it is layout, and layout is this call site's,
          // which is exactly why `ROLE_PILL_CLASS` carries none of it.
          //
          // docs/272 — under a role the anchor wears the SAME pill the wide row's
          // control wears. The two had drifted into two faces for one state, on
          // nothing but the composer's width.
          className={`flex flex-[0_1_auto] min-w-0 overflow-hidden ${
            sessionRoleName
              ? ROLE_PILL_CLASS
              : `items-center gap-1.5 rounded-lg p-1.5 text-xs font-medium text-(--color-text-secondary) transition-colors hover:bg-(--color-bg-hover) disabled:cursor-not-allowed disabled:opacity-50 ${INSET_FOCUS_RING}`
          }`}
        >
          {/* The mark follows the name: under a role the anchor is the role's,
              so it wears the mark that means "role" everywhere else (req 16). */}
          {sessionRoleName ? (
            // No tertiary tint here: inside the pill the mark takes the pill's
            // own colour, exactly as it does in the wide row.
            <BaseballCapIcon size={ICON_SIZE.SM} className="shrink-0" />
          ) : (
            <SlidersHorizontalIcon
              size={ICON_SIZE.SM}
              className="shrink-0 text-(--color-text-tertiary)"
            />
          )}
          <span className="truncate" data-testid="composer-settings-model-name">
            {anchorName}
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
        {activePanel === "root" && (
          <>
            {/* docs/285 req 9 — the Mode row is GONE, on every viewport. The
                composer row carries the permission mode itself now (alongside
                network access, in one control), and a row here as well would be
                a second place to change one setting.

                Removing it is what collapses the nesting this menu had under a
                role: the root used to exist to hold Mode and Role, so a session
                running as a role opened onto a two-row panel whose only purpose
                was to lead somewhere else. */}
            {showRole && (
              <RootRow
                testId="composer-settings-row-role"
                icon={<BaseballCapIcon size={ICON_SIZE.SM} className="shrink-0" />}
                label="Role"
                value={sessionRoleName ?? "None"}
                onSelect={roleRowOpens ? () => setPanel("role") : undefined}
                trailing={
                  roleLocked ? (
                    <LockIcon
                      size={ICON_SIZE.XS}
                      className="shrink-0 text-(--color-text-tertiary)"
                    />
                  ) : undefined
                }
              />
            )}
            {onAgentChange && showParams && (
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
            {onAgentChange && showParams && (
              <RootRow
                testId="composer-settings-row-model"
                icon={<SparkleIcon size={ICON_SIZE.SM} className="shrink-0" />}
                label="Model"
                value={modelName}
                onSelect={pickersLocked ? undefined : () => setPanel("model")}
              />
            )}
            {reasoning && onReasoningChange && showParams && (
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

        {activePanel === "role" && (
          <>
            {/* req 9 — no back header when the role list IS the menu: there is
                no root behind it to go back to. The separator goes with it: it
                divides the header from the list, so on its own it is a rule with
                nothing above it — an empty band at the top of the sheet. */}
            {!rootIsRoleAlone && (
              <>
                <PanelHeader title="Role" onBack={() => setPanel("root")} />
                <DropdownMenuSeparator />
              </>
            )}
            {/* req 4 — a locked panel lists no roles. The server refuses
                `set_role` on a pinned session, so rows here would all be
                unselectable; the one line says why, and "Adjust parameters…"
                below it is what the lock does NOT take away. */}
            {roleLocked && (
              <p
                className="px-3 py-2 text-xs text-(--color-text-tertiary)"
                data-testid="composer-settings-role-locked"
              >
                {ROLE_LOCKED_REASON}
              </p>
            )}
            {/* req 18 — the same first entry the wide row's list carries, and
                what the panel shows as chosen while no role is in force. */}
            {!roleLocked && (
              <ChoiceRow
                testId="composer-settings-role-none"
                label="No role"
                description="Run this session without a role's standing instructions"
                isCurrent={!sessionRoleName}
                onSelect={() => {
                  onRoleSelected?.();
                  onRoleChange?.(undefined);
                }}
              />
            )}
            {!roleLocked && roles.map((role) => {
              const unavailable = roleUnavailableDetail(role);
              return (
                <ChoiceRow
                  key={role.name}
                  testId={`composer-settings-role-${role.name}`}
                  label={role.name}
                  {...(unavailable ?? role.description
                    ? { description: unavailable ?? role.description! }
                    : {})}
                  isCurrent={role.name === sessionRoleName}
                  // req 9 — shown with its reason rather than hidden.
                  disabled={Boolean(unavailable)}
                  onSelect={() => {
                    onRoleSelected?.();
                    onRoleChange?.(role.name);
                  }}
                />
              );
            })}
            {sessionRoleName && !roleParamsRevealed && (
              <>
                <DropdownMenuSeparator />
                <ChoiceRow
                  testId="composer-settings-role-adjust"
                  label="Adjust parameters…"
                  // req 15 — and the harness is named here deliberately. It pins
                  // irreversibly at the first message and switching role can
                  // switch it, so a panel that listed only the model and the
                  // level would hide the one consequence the user cannot undo.
                  description="Show the harness, model and level this role set"
                  isCurrent={false}
                  keepOpen
                  onSelect={() => {
                    onAdjustRoleParameters?.();
                    setPanel("root");
                  }}
                />
              </>
            )}
          </>
        )}

        {activePanel === "harness" && (
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
                  onSelect={() => { onLeaveRole?.(); onAgentChange?.(agent.id as AgentId); }}
                />
              );
            })}
          </>
        )}

        {activePanel === "model" && (
          <>
            <PanelHeader title="Model" onBack={() => setPanel("root")} />
            <DropdownMenuSeparator />
            {model.groups.map((group) => (
              <div key={group.key || "__ungrouped__"}>
                {group.serviceName && (
                  <ModelGroupHeader
                    serviceId={group.serviceId}
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
                    onSelect={() => { onLeaveRole?.(); model.handleModelSelect(row); }}
                  />
                ))}
              </div>
            ))}
          </>
        )}

        {activePanel === "reasoning" && reasoning && (
          <>
            <PanelHeader title={reasoning.label} onBack={() => setPanel("root")} />
            <DropdownMenuSeparator />
            {reasoning.options.map((opt) => (
              <ChoiceRow
                key={opt.value ?? "__default__"}
                testId={`composer-settings-reasoning-${opt.value ?? "default"}`}
                label={opt.label}
                isCurrent={(opt.value ?? undefined) === (reasoning.current ?? undefined)}
                onSelect={() => { onLeaveRole?.(); reasoning.select(opt.value); }}
              />
            ))}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
