/**
 * docs/272-user-selectable-roles — **the composer's role control.**
 *
 * A role is a complete unit the user configured once — a harness, a model, a
 * reasoning level and standing instructions (docs/264). Until now only an agent
 * could start one. This is the control that lets the user start one themselves.
 *
 * **It replaces rather than adds** (req 5). When a role is selected the harness,
 * model and reasoning selectors come out of the row and the role's name stands
 * where they were: those three are what the role is *made of*, and restating
 * them tells the user nothing they did not just decide. So a row showing a role
 * is SHORTER than today's, which is what keeps this compatible with docs/260's
 * clipping group rather than adding to the width pressure it manages.
 *
 * **The mark appears only once the user has a role** (req 16), and with no label
 * beside it. That is only legible because the same mark identifies roles in
 * Settings, where they are created and where it is met with its name — neither
 * half works without the other. `BaseballCapIcon` is the mark; it was chosen by
 * rendering it against every neighbour in the row (the permission mode's
 * `FastForward`, `Robot`, `Sparkle`, `Brain`) rather than in isolation, which is
 * what killed the six earlier candidates.
 *
 * **Clicking the name opens the list of roles** (req 14), because every other
 * control in this row opens what it chooses between and the role is not the one
 * exception. The parameters it set are reached from *inside* that list, through
 * "Adjust parameters…", and **changing one of them is the whole of leaving the
 * role** (req 15) — which is why there is no "no role" entry and no clear
 * action.
 */

import { useMemo } from "react";
import { BaseballCapIcon, CaretDownIcon, LockIcon } from "@phosphor-icons/react";
import { ICON_SIZE, INSET_FOCUS_RING } from "../../design-tokens.js";
import { PickerOption } from "../pickers/Picker.js";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "../ui/dropdown-menu.js";
import { useSettingsStore } from "../../stores/settings-store.js";
import type { RoleView } from "../../../server/shared/types/agent-types.js";

/** The reserved reviewer, which is never offered to a user (req 10). */
const RESERVED_ROLE_NAME = "reviewer";

/**
 * Why the control is locked (req 4) — the one wording, worn by trigger and
 * wrapper alike.
 *
 * **It names what is still changeable, not only what is not**, in the shape
 * `lockedHarnessReason` already uses ("Models stay switchable"). The first
 * sentence alone was read as "this session's settings are frozen", which is what
 * the parameters vanishing at the same moment appeared to confirm — and they no
 * longer do (see `roleParamsRevealed`). A lock that states only a prohibition
 * makes the user guess how far it reaches.
 */
const ROLE_LOCKED_REASON =
  "A role can only be chosen before the session's first message. "
  + "The model and reasoning level it set stay changeable.";

/**
 * **The one appearance of "a role is in force"**, worn by both layouts.
 *
 * It exists as a constant for the reason `PICKER_TRIGGER_CLASS` does, and it was
 * added for the same reason that one was: the two had already drifted. The wide
 * row followed the approved prototype's tinted pill while the narrow anchor
 * inherited docs/260's plain settings control, so the same state wore two faces
 * depending on how wide the composer happened to be.
 *
 * Deliberately **appearance only** — colour, radius, padding, type. Layout
 * belongs to each call site, because the two genuinely differ there and must:
 * the wide row's control is `shrink-0`, while the narrow anchor is the row's one
 * elastic item and has to truncate before anything else is clipped (docs/260
 * req 8). Folding that in here would make one of them wrong.
 *
 * Guarded by a test asserting both triggers carry this string.
 */
const ROLE_PILL_BASE =
  `items-center gap-1.5 rounded-full bg-(--color-accent-subtle) px-2.5 py-1 text-xs font-medium `
  + `text-(--color-accent) ${INSET_FOCUS_RING}`;

export const ROLE_PILL_CLASS =
  `${ROLE_PILL_BASE} transition-colors hover:brightness-95 disabled:cursor-not-allowed `
  + `disabled:opacity-50`;

/**
 * The same pill once the session has locked it (req 4) — **at full contrast.**
 *
 * A locked role is not a control the user must wait to use; it is the READOUT of
 * what this session runs on, and it is that for the rest of the session's life.
 * Wearing `disabled:opacity-50` — which it did, because `locked` was passed
 * straight to the button's `disabled` — put the one permanent fact on the row at
 * half the contrast of every transient one, and it was reported as unreadable.
 *
 * `disabled:*` is therefore absent rather than overridden: the button still
 * carries the `disabled` attribute (nothing to press), and the dimming that
 * attribute normally brings is what does not apply. Dimming stays for the
 * genuinely transient case — a composer disabled mid-turn — because that state
 * ends.
 */
export const ROLE_PILL_LOCKED_CLASS = `${ROLE_PILL_BASE} cursor-default`;

/**
 * …and its counterpart when no role is chosen: the mark alone, quiet, in the
 * same tertiary weight the row's other icons use (req 16).
 */
export const ROLE_MARK_CLASS =
  `items-center gap-1.5 rounded-lg p-1.5 text-xs font-medium text-(--color-text-tertiary) `
  + `transition-colors hover:bg-(--color-bg-hover) hover:text-(--color-text-secondary) `
  + `disabled:cursor-not-allowed disabled:opacity-50 ${INSET_FOCUS_RING}`;

/**
 * One line saying why a role cannot be started, or `undefined` when it can.
 *
 * The three reasons are kept apart, exactly as Settings keeps them apart, because
 * the remedy differs in each and collapsing them sends the user to the wrong
 * place: only the first is the role's own fault (req 9).
 */
export function roleUnavailableDetail(role: RoleView): string | undefined {
  switch (role.unavailableReason) {
    case "stranded":
      return "Needs fixing in Settings";
    case "disconnected":
      return "Its service is disconnected";
    case "quota_exhausted":
      return "Its quota is spent";
    default:
      return undefined;
  }
}

/** What a role's row says about itself when it CAN run: its description, else what it runs. */
function roleDetail(role: RoleView): string | undefined {
  const unavailable = roleUnavailableDetail(role);
  if (unavailable) return unavailable;
  if (role.description) return role.description;
  if (!role.resolved) return undefined;
  return `${role.resolved.harnessName} · ${role.resolved.label}`;
}

/**
 * The roles a user may pick, and whether there are any at all.
 *
 * Shared with the narrow layout's settings menu so the two cannot disagree about
 * which roles exist or which of them can run — the same reason the harness and
 * model pickers export their state.
 *
 * **The reviewer is filtered out here, once.** It resolves its params per run
 * against whatever produced the work, so a session the user starts themselves
 * gives that rule nothing to measure (req 10). It is also why `hasRoles` is not
 * `roles.length > 0`: the reviewer exists on every install, including one where
 * nobody has configured anything, so counting it would make req 16's condition
 * permanently true and the rule dead on arrival.
 */
export function useRolePickerState(): {
  roles: RoleView[];
  hasRoles: boolean;
} {
  const allRoles = useSettingsStore((s) => s.roles);
  const roles = useMemo(
    () => allRoles.filter((role) => !role.reserved && role.name !== RESERVED_ROLE_NAME),
    [allRoles],
  );
  return { roles, hasRoles: roles.length > 0 };
}

export function RoleSelector({
  roles,
  selectedRole,
  onSelectRole,
  onAdjustParameters,
  disabled = false,
  locked = false,
}: {
  roles: RoleView[];
  /** The role in force, or undefined. Never derived from the parameters (req 13). */
  selectedRole?: string | undefined;
  onSelectRole: (roleName: string) => void;
  /**
   * "Adjust parameters…" — bring the three controls the role replaced back into
   * the row (req 15). Absent when no role is selected, because then they are
   * already there.
   */
  onAdjustParameters?: (() => void) | undefined;
  disabled?: boolean;
  /**
   * The session has taken its first turn, so no role applies any more (req 4).
   * Rendered as the same lock the pinned harness uses — a caret on a control
   * that will never open is a lie the user has to click to discover.
   */
  locked?: boolean;
}) {
  // Nothing to offer and nothing in force: the row is exactly as it is today,
  // not even an icon (req 16).
  if (roles.length === 0 && !selectedRole) return null;

  /*
    req 4 — **locked is a readout, and a readout has no menu.**

    `disabled` is not the way to say that, and this is the same finding
    `Picker.tsx` records for a picker with nothing to pick: Radix binds the
    trigger on `pointerdown`, so a disabled button under a `DropdownMenuTrigger`
    still opened its menu — here, a list of roles that could no longer be chosen.
    The fix cannot be a state on the trigger; the menu has to be ABSENT. So the
    locked pill is rendered on its own, outside `DropdownMenu`, and there is
    nothing left for a click to open.

    With no role in force there is nothing to read out either — the mark's whole
    job is to offer the list (req 16) — so the control goes rather than sitting
    there inert.
  */
  if (locked) {
    if (!selectedRole) return null;
    return (
      /*
        The `title` is on the WRAPPER, not only on the button, because Chrome
        dispatches no mouse events to a disabled control and so shows no tooltip
        for one — which would leave the lock stating a rule the user cannot read.
        The button keeps its own copy for the browsers that do.
      */
      <span className="flex min-w-0" title={ROLE_LOCKED_REASON}>
        <button
          type="button"
          disabled
          aria-label={`Role: ${selectedRole}`}
          title={ROLE_LOCKED_REASON}
          data-testid="role-selector-trigger"
          className={`flex shrink-0 ${ROLE_PILL_LOCKED_CLASS}`}
        >
          <BaseballCapIcon size={ICON_SIZE.SM} className="shrink-0" />
          <span className="truncate">{selectedRole}</span>
          <LockIcon size={ICON_SIZE.XS} className="shrink-0" />
        </button>
      </span>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-label={selectedRole ? `Role: ${selectedRole}` : "Choose a role"}
          title={selectedRole ? `Role: ${selectedRole}` : "Choose a role"}
          data-testid="role-selector-trigger"
          /*
            **Not the shared `PickerTrigger`, and the difference is the point.**
            The other three controls in this row each report ONE value; this one
            reports that the session is running a named configuration, and when
            it does it stands where all three of them were. Rendering it as a
            fourth identical trigger would say "here is a fourth setting", which
            is the reading req 5 exists to prevent. So the selected state is a
            tinted pill and the empty state is the mark alone.

            What IS shared is the menu below it — the same `PickerOption` rows
            every other picker uses — which is where docs/261 req 13's "learn one,
            learn all" actually lives: the thing the user operates.
          */
          className={`flex shrink-0 ${selectedRole ? ROLE_PILL_CLASS : ROLE_MARK_CLASS}`}
        >
          <BaseballCapIcon size={ICON_SIZE.SM} className="shrink-0" />
          {/*
            req 16 — with no role selected the control is the mark and NOTHING
            else: no label, and no caret either. A caret would be chrome on a
            9px-wide control, and the empty state is stable (unlike the value
            triggers, whose caret is kept through every disable so the row does
            not jump).
          */}
          {selectedRole && <span className="truncate">{selectedRole}</span>}
          {selectedRole && <CaretDownIcon size={ICON_SIZE.XS} className="shrink-0" />}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="w-64" data-testid="role-selector-menu">
        <DropdownMenuLabel>Role</DropdownMenuLabel>
        {roles.map((role) => {
          const unavailable = roleUnavailableDetail(role);
          const detail = roleDetail(role);
          return (
            <PickerOption
              key={role.name}
              label={role.name}
              {...(detail ? { detail } : {})}
              selected={role.name === selectedRole}
              // req 9 — shown, not hidden. A role the user configured vanishing
              // reads as a fault in ShipIt; a role that says why it cannot run
              // reads as the truth it is.
              disabled={Boolean(unavailable)}
              onSelect={() => onSelectRole(role.name)}
              testId={`role-option-${role.name}`}
            />
          );
        })}
        {onAdjustParameters && (
          <>
            <DropdownMenuSeparator />
            <PickerOption
              label="Adjust parameters…"
              detail="Show the harness, model and level this role set"
              onSelect={onAdjustParameters}
              testId="role-adjust-parameters"
            />
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
