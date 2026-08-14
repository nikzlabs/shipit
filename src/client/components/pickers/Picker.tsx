/**
 * docs/261 phase 6 (req 13) — the one control every "choose a thing" surface in
 * ShipIt renders.
 *
 * Before this file there were three of them. The composer had a borderless
 * trigger with a caret; the Reviewer tab had its own bordered button and its own
 * copies of the two menus; Background work had a native `<select>` with
 * `<optgroup>`s, which matched nothing at all. Req 13 says a user who has
 * learned one of these controls has learned all of them, so the markup lives
 * here and the surfaces render it.
 *
 * **What is shared is the control, not the state.** The composer's pickers carry
 * a session's worth of machinery — an optimistic pending pick, the echo counter
 * that clears it, a localStorage seed, the pinned-harness rule — while Settings
 * is deliberately *not* optimistic, because reviewer slot 2 is ranked against
 * slot 1 and a local guess would have to reimplement the ranking (phase 3).
 * Sharing the state hooks would drag one into the other. So each surface keeps
 * its own state and renders {@link Picker} and {@link PickerOption}.
 *
 * The guard for all this is `picker-consistency.test.tsx`, which renders the
 * composer's trigger and the Reviewer tab's and asserts the two `className`
 * strings are identical. Asserting that this module is *imported* would not
 * catch the regression it exists to catch: an import can be present and the
 * class overridden at the call site.
 */

import { Children, forwardRef, type ComponentPropsWithoutRef, type ReactNode } from "react";
import { CaretDownIcon, CheckIcon, LockIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../../design-tokens.js";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
} from "../ui/dropdown-menu.js";

/**
 * The trigger's own classes, exported so the guard test has one string to
 * compare rather than a rendered snapshot to eyeball.
 */
export const PICKER_TRIGGER_CLASS =
  "flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-lg transition-colors font-medium text-(--color-text-secondary) disabled:opacity-50 disabled:cursor-not-allowed";

interface PickerTriggerProps extends ComponentPropsWithoutRef<"button"> {
  /** What the control currently holds. Never empty — a blank trigger is unclickable-looking. */
  label: string;
  /** An optional leading glyph, e.g. the reasoning control's brain. */
  icon?: ReactNode;
  /**
   * Not merely disabled — *cannot* change, ever, for a stated reason (the
   * composer's pinned harness). Renders a lock where the caret goes, because a
   * caret on a control that will never open is a lie the user has to click to
   * discover.
   */
  locked?: boolean;
}

/**
 * The button in the reference screenshot: label, caret, no border, hover fill.
 *
 * `forwardRef` and the prop spread are load-bearing — Radix's
 * `DropdownMenuTrigger asChild` clones this element and needs both to attach its
 * ref and its open/close handlers.
 */
export const PickerTrigger = forwardRef<HTMLButtonElement, PickerTriggerProps>(
  ({ label, icon, locked, disabled, className, ...rest }, ref) => {
    const inert = disabled || locked;
    return (
      <button
        ref={ref}
        disabled={inert}
        className={`${PICKER_TRIGGER_CLASS} ${
          inert ? "cursor-default" : "hover:bg-(--color-bg-hover) cursor-pointer"
        }${className ? ` ${className}` : ""}`}
        {...rest}
      >
        {icon}
        <span className="truncate">{label}</span>
        {/*
          **The trailing icon is always there, and it is always the same size**,
          because its absence is a layout change and `disabled` is a state the
          composer enters and leaves constantly — every reconnect, every running
          turn. Dropping the caret resized each trigger, so the whole composer row
          shifted back and forth while a session reconnected; that jump is far
          louder than the affordance the missing caret was withholding. The
          `disabled:opacity-50` on the trigger already says the control cannot
          open, without moving anything.

          Locked still swaps the caret for a lock, because a lock says *why* this
          one can never open — and being the same `ICON_SIZE.XS` glyph, the swap
          costs no movement either.

          Stated once, here, because the three triggers this file replaced had
          each answered it differently.
        */}
        {locked ? (
          <LockIcon size={ICON_SIZE.XS} className="text-(--color-text-tertiary)" />
        ) : (
          <CaretDownIcon size={ICON_SIZE.XS} />
        )}
      </button>
    );
  },
);
PickerTrigger.displayName = "PickerTrigger";

/**
 * A trigger plus its menu. Callers supply {@link PickerOption} children.
 *
 * `side`/`align` are props rather than constants because the composer opens
 * upward out of a bottom-anchored row and Settings opens downward out of a
 * card; everything else about the menu is fixed here on purpose.
 */
export function Picker({
  label,
  icon,
  locked,
  lockedTitle,
  title,
  ariaLabel,
  triggerTestId,
  menuTestId,
  menuLabel,
  menuWidth = "w-60",
  side,
  align = "start",
  disabled,
  whenEmpty = "hide",
  children,
}: {
  label: string;
  icon?: ReactNode;
  locked?: boolean;
  /** Why the control is locked. Shown on hover; ignored when not locked. */
  lockedTitle?: string;
  title?: string;
  ariaLabel: string;
  triggerTestId?: string;
  menuTestId?: string;
  /** A heading over the options — the knob's own name, where it has one. */
  menuLabel?: string;
  menuWidth?: string;
  side?: "top" | "bottom";
  align?: "start" | "end";
  disabled?: boolean;
  /**
   * What to do when there is nothing to pick (req 14).
   *
   * `hide` — render nothing. The default, and what Settings wants: a control
   * that offers no choice is a claim there is one, and the surrounding text
   * already explains the empty install.
   *
   * `readout` — keep the trigger, inert and unopenable. The composer wants this
   * and it is not a loophole: its row is a *status* line as much as a control,
   * and on a first-run install "No model" beside a disabled input is the
   * sentence that tells the user what would run if they added a service. The
   * menu is still never rendered, so the reported bug — an empty dropdown
   * opening on click — cannot happen either way.
   */
  whenEmpty?: "hide" | "readout";
  children: ReactNode;
}) {
  /**
   * req 14 — **a picker with nothing to pick is not rendered at all.**
   *
   * `disabled` is not the alternative it looks like, and that is the whole
   * finding: the empty service control was already disabled and its menu opened
   * anyway, because Radix binds the trigger on `pointerdown` and a disabled
   * button does not reliably suppress it. So the fix cannot be a state — the
   * control has to be absent.
   *
   * `Children.toArray` is what makes this exact rather than approximate: it
   * flattens the `.map()` every caller passes and DROPS `null`, `undefined` and
   * the booleans a `&&` guard leaves behind, so what it counts is what the menu
   * would actually show. `Children.count` counts those empty slots and would
   * keep a menu of nothing but holes.
   *
   * Deliberately here rather than at each call site: every picker gets it,
   * including ones nobody has thought about the empty state of yet.
   */
  if (Children.toArray(children).length === 0) {
    if (whenEmpty === "hide") return null;
    return (
      <PickerTrigger
        label={label}
        icon={icon}
        disabled
        title={title}
        aria-label={ariaLabel}
        data-testid={triggerTestId}
      />
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <PickerTrigger
          label={label}
          icon={icon}
          locked={locked}
          disabled={disabled}
          title={locked ? lockedTitle : title}
          aria-label={ariaLabel}
          data-testid={triggerTestId}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent side={side} align={align} className={menuWidth} data-testid={menuTestId}>
        {menuLabel && <DropdownMenuLabel>{menuLabel}</DropdownMenuLabel>}
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * One row of a picker menu.
 *
 * `detail` is the quiet second line — what a derived default currently resolves
 * to, how many models a harness offers. It is a second *line* rather than a
 * right-aligned column because a column invites the eye to compare across rows,
 * which is the comparison none of these controls is for (the harness menu's
 * model count learned this first).
 */
export function PickerOption({
  label,
  detail,
  leading,
  selected,
  disabled,
  trailing,
  indent = false,
  onSelect,
  testId,
  className = "",
}: {
  label: string;
  detail?: string;
  /**
   * A glyph at the left edge — the service rows' vendor mark.
   *
   * `shrink-0` and a fixed 12px box, so a row's text truncates and the column of
   * glyphs stays a column: a mark that could shrink would make each row's label
   * start at a slightly different place. It is the caller's job to keep it
   * `aria-hidden` — the row's own `label` is what a screen reader reads, and a
   * mark that announced itself would say the same thing twice.
   */
  leading?: ReactNode;
  selected?: boolean;
  disabled?: boolean;
  /** Rendered before the checkmark — the service rows' billing-mode pill. */
  trailing?: ReactNode;
  /** Indented, for a row that sits under a group header. */
  indent?: boolean;
  onSelect: () => void;
  testId?: string;
  className?: string;
}) {
  return (
    <DropdownMenuItem
      onSelect={onSelect}
      disabled={disabled}
      className={`${indent ? "pl-5 pr-3" : "px-3"} py-1.5 text-sm ${
        selected ? "bg-(--color-accent-subtle) text-(--color-text-link)" : ""
      }${className ? ` ${className}` : ""}`}
      data-testid={testId}
    >
      {leading && <span className="flex w-3 shrink-0 justify-center">{leading}</span>}
      <span className="min-w-0 flex-1">
        <span className="block truncate">{label}</span>
        {detail && (
          <span className="block truncate text-xs text-(--color-text-tertiary)">{detail}</span>
        )}
      </span>
      {trailing}
      <span className="flex w-4 shrink-0 justify-end">
        {selected && <CheckIcon size={ICON_SIZE.SM} className="text-(--color-accent)" />}
      </span>
    </DropdownMenuItem>
  );
}
