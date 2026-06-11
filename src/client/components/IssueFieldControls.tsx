/**
 * Inline status & priority editors for the Issues tab (docs/191).
 *
 * The user sets an issue's status (both trackers) or priority (Linear only — see
 * below) directly from a list row or the detail view, without leaving ShipIt or
 * asking the agent. Each editor is a single-select dropdown anchored on the
 * current value: the trigger renders whatever the call site already shows (a
 * status pill, a priority badge, a plain cell), with a caret that fades in on
 * hover; selecting an option fires the async write and shows a spinner until it
 * resolves, surfacing any error as a red ring + tooltip on the trigger.
 *
 * These are the user's own direct action, so — like a user-posted comment
 * (docs/189) — they leave no chat provenance card and have no undo (that's the
 * agent's do-then-surface path). Priority is Linear-only by product decision:
 * GitHub has no native priority field (it's label-derived), so the call sites
 * gate the priority editor on the tracker.
 *
 * Used inside clickable list rows, every trigger stops click/keydown propagation
 * so opening the menu never also opens the row's detail view.
 */

import { useState, type CSSProperties, type ReactNode } from "react";
import { CaretDownIcon, CheckIcon, CircleNotchIcon } from "@phosphor-icons/react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu.js";
import { PRIORITY_OPTIONS } from "./issues-filter.js";
import { ICON_SIZE } from "../design-tokens.js";
import { cn } from "../utils/cn.js";
import { useSurfaceLuminance } from "../hooks/useSurfaceLuminance.js";
import { adaptColorForSurface } from "../utils/status-color.js";
import type { IssuePriorityLevel, TrackerIssue } from "../../server/shared/types.js";

/** A tracker status option ({@link TrackerIssue.status} / `availableStatuses`). */
export interface IssueStatusRef {
  name: string;
  type?: string;
  /** The tracker's own state color (Linear hex), preferred for the dot. */
  color?: string;
}

/**
 * Priority palette — a FIXED, theme-independent set of hues, so a given priority
 * reads the same in every theme. Priority must NOT borrow the semantic
 * `--color-error/warning/info/success` tokens: the warm/Claude themes
 * deliberately re-tint those (e.g. `--color-info` is terracotta there, not blue),
 * which made "Medium" flip from blue to red across themes and collide with
 * Urgent/High. These base hues are run through {@link adaptColorForSurface} at
 * each use so they stay legible per theme while keeping one consistent hue.
 */
export const PRIORITY_DOT_COLOR: Record<IssuePriorityLevel, string> = {
  urgent: "#ef4444", // red
  high: "#f59e0b", // amber
  medium: "#3b82f6", // blue
  low: "#22c55e", // green
  none: "#9ca3af", // gray
};

/** The contrast-adapted priority hue for a surface (dot fill, badge text, etc.). */
export function priorityColor(level: IssuePriorityLevel, surfaceLum: number): string {
  return adaptColorForSurface(PRIORITY_DOT_COLOR[level], surfaceLum);
}

/** Shared pill chrome for the priority badge/trigger. */
const PRIORITY_PILL = "inline-flex items-center rounded-full px-2 h-[18px] text-[11px] font-medium leading-none";

/**
 * A higher contrast target for the pill's TEXT than the 1.8 used for dots: a
 * swatch only has to be *seen*, but text has to be *read*, so on a light theme a
 * light hue like amber "High" must darken further to stay legible on its tint.
 */
const PRIORITY_TEXT_CONTRAST = 3.8;

/**
 * Tinted-bg + colored-text style for a priority pill. The tint keeps the true
 * hue (a faint version of the base color); the text is adapted to the stronger
 * text-contrast target so it reads on that tint in every theme.
 */
function priorityPillStyle(level: IssuePriorityLevel, surfaceLum: number): CSSProperties {
  const base = PRIORITY_DOT_COLOR[level];
  return {
    backgroundColor: `color-mix(in oklab, ${base} 16%, transparent)`,
    color: adaptColorForSurface(base, surfaceLum, PRIORITY_TEXT_CONTRAST),
  };
}

/**
 * Read-only priority pill (e.g. GitHub, where priority isn't editable). Renders
 * nothing for "No priority". Shared so the list, detail, and trigger all match.
 */
export function PriorityBadge({
  priority,
  surfaceLum,
}: {
  priority: TrackerIssue["priority"];
  surfaceLum: number;
}) {
  if (priority.level === "none") return null;
  return (
    <span className={PRIORITY_PILL} style={priorityPillStyle(priority.level, surfaceLum)}>
      {priority.label}
    </span>
  );
}

/** Fallback dot color by workflow-state type, when the tracker gives no color. */
function statusTypeColor(type?: string): string {
  switch (type) {
    case "completed":
      return "var(--color-success)";
    case "started":
      return "var(--color-accent)";
    default:
      return "var(--color-text-tertiary)";
  }
}

/**
 * The status-dot color (a CSS color string): the tracker's own state color when
 * present (Linear's per-state hex / GitHub's open-closed hues), falling back to
 * a coarse type→token only when the tracker gives none. Shared so the list,
 * detail pill, edit menu, and filter all show the exact same color a status has.
 */
export function statusDotColor(status?: { type?: string; color?: string }): string {
  return status?.color ?? statusTypeColor(status?.type);
}

/**
 * The clickable priority value used as an editor trigger. Renders the colored
 * badge, or a faint "No priority" placeholder when unset so an unprioritized
 * issue still has something to click. Exported for read-only-adjacent reuse.
 */
export function PriorityTrigger({
  priority,
  surfaceLum,
}: {
  priority: TrackerIssue["priority"];
  surfaceLum: number;
}) {
  // Caret lives INSIDE the value and reveals on hover by growing from zero
  // width — so the colored pill itself widens slightly to show a "⌄" in its own
  // color, rather than a separate gray box appearing around it. `group/fe` is
  // the editor button (FieldEditor); read-only uses of this trigger have no such
  // ancestor, so the caret simply stays collapsed.
  const caret = (
    <CaretDownIcon
      size={ICON_SIZE.XS}
      className="shrink-0 max-w-0 overflow-hidden opacity-0 transition-all duration-150 group-hover/fe:ml-0.5 group-hover/fe:max-w-3.5 group-hover/fe:opacity-100 group-focus-visible/fe:ml-0.5 group-focus-visible/fe:max-w-3.5 group-focus-visible/fe:opacity-100 group-data-[state=open]/fe:ml-0.5 group-data-[state=open]/fe:max-w-3.5 group-data-[state=open]/fe:opacity-100"
    />
  );
  if (priority.level === "none") {
    return (
      <span className="inline-flex items-center text-[11px] text-(--color-text-tertiary)">
        No priority
        {caret}
      </span>
    );
  }
  return (
    <span className={PRIORITY_PILL} style={priorityPillStyle(priority.level, surfaceLum)}>
      {priority.label}
      {caret}
    </span>
  );
}

/**
 * Presentational dropdown shell shared by the status + priority editors: a
 * value-shaped trigger (with hover caret / saving spinner / error ring) plus the
 * option menu. Stops click + keydown propagation so it's safe inside a clickable
 * row.
 */
function FieldEditor({
  ariaLabel,
  trigger,
  saving,
  error,
  align = "start",
  chevron = true,
  children,
}: {
  ariaLabel: string;
  trigger: ReactNode;
  saving: boolean;
  error: string | null;
  align?: "start" | "end";
  /**
   * Render the shared inline (gray) caret after the trigger. The priority
   * editor sets this `false` because its trigger ({@link PriorityTrigger})
   * grows the colored pill to reveal an in-pill caret instead, so the value
   * itself is the only affordance — no separate box or sibling chevron.
   */
  chevron?: boolean;
  children: ReactNode;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={saving}
          aria-label={ariaLabel}
          title={error ?? undefined}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
          className={cn(
            // No hover box — the affordance is the value reacting (the pill
            // grows / a caret slides out). A surrounding highlight clashed with
            // the pill's round corners and read as a weird nested box.
            "group/fe inline-flex max-w-full items-center rounded-full",
            "cursor-pointer focus:outline-none focus-visible:ring-1 focus-visible:ring-(--color-border-focus)",
            error && "ring-1 ring-(--color-error)",
          )}
        >
          <span className="inline-flex min-w-0 items-center gap-1">{trigger}</span>
          {saving ? (
            <CircleNotchIcon size={ICON_SIZE.XS} className="ml-1 shrink-0 animate-spin text-(--color-text-tertiary)" />
          ) : chevron ? (
            // Caret space is RESERVED (always `ml-0.5` + icon width), only its
            // opacity fades in — so revealing it never changes the trigger's
            // width and never pushes a sibling (e.g. the priority pill next to
            // the status on the detail page). The priority editor opts out
            // (`chevron={false}`) and grows its pill instead.
            <CaretDownIcon
              size={ICON_SIZE.XS}
              className="ml-0.5 shrink-0 opacity-0 text-(--color-text-tertiary) transition-opacity duration-150 group-hover/fe:opacity-100 group-focus-visible/fe:opacity-100 group-data-[state=open]/fe:opacity-100"
            />
          ) : null}
        </button>
      </DropdownMenuTrigger>
      {/* The menu renders in a portal but is still a React descendant of the
          (clickable) row, so React bubbles its click/keydown to the row's open
          handler. Stop both here so selecting an option never also opens the
          row's detail view. */}
      <DropdownMenuContent
        align={align}
        className="min-w-44 max-w-64"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Hook: run an async field write, tracking saving + error state. */
function useFieldWrite() {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<string | null>) => {
    setSaving(true);
    setError(null);
    const err = await fn();
    setSaving(false);
    if (err) setError(err);
  };
  return { saving, error, run };
}

/**
 * Inline status editor. Falls back to the read-only trigger when there are no
 * options to choose from (an unconfigured/empty tracker), so it degrades to the
 * prior plain rendering rather than an empty menu.
 */
export function IssueStatusEditor({
  current,
  options,
  onSelect,
  trigger,
  ariaLabel,
  align,
}: {
  current?: IssueStatusRef;
  options: IssueStatusRef[];
  onSelect: (name: string) => Promise<string | null>;
  trigger: ReactNode;
  ariaLabel: string;
  align?: "start" | "end";
}) {
  const { saving, error, run } = useFieldWrite();
  // The menu pops in a dropdown (elevated surface), so adapt the option dots to
  // that surface's luminance — not wherever the trigger row happens to sit.
  const menuSurface = useSurfaceLuminance("--color-bg-elevated");

  if (options.length === 0) return <>{trigger}</>;

  return (
    <FieldEditor ariaLabel={ariaLabel} trigger={trigger} saving={saving} error={error} align={align}>
      {options.map((opt) => {
        const selected = opt.name === current?.name;
        return (
          <DropdownMenuItem
            key={opt.name}
            onSelect={() => {
              if (!selected) void run(() => onSelect(opt.name));
            }}
          >
            <span
              className="size-2 shrink-0 rounded-full"
              style={{ backgroundColor: adaptColorForSurface(statusDotColor(opt), menuSurface) }}
              aria-hidden="true"
            />
            <span className={cn("flex-1 truncate", selected && "text-(--color-text-primary)")}>{opt.name}</span>
            {selected && <CheckIcon size={ICON_SIZE.XS} weight="bold" className="shrink-0 text-(--color-accent)" />}
          </DropdownMenuItem>
        );
      })}
    </FieldEditor>
  );
}

/** Inline priority editor (Linear-only; the call site gates by tracker). */
export function IssuePriorityEditor({
  current,
  onSelect,
  trigger,
  ariaLabel,
  align,
}: {
  current: IssuePriorityLevel;
  onSelect: (level: IssuePriorityLevel) => Promise<string | null>;
  trigger: ReactNode;
  ariaLabel: string;
  align?: "start" | "end";
}) {
  const { saving, error, run } = useFieldWrite();
  const menuSurface = useSurfaceLuminance("--color-bg-elevated");

  return (
    <FieldEditor ariaLabel={ariaLabel} trigger={trigger} saving={saving} error={error} align={align} chevron={false}>
      {PRIORITY_OPTIONS.map((opt) => {
        const selected = opt.level === current;
        return (
          <DropdownMenuItem
            key={opt.level}
            onSelect={() => {
              if (!selected) void run(() => onSelect(opt.level));
            }}
          >
            <span
              className="size-2 shrink-0 rounded-full"
              style={{ backgroundColor: priorityColor(opt.level, menuSurface) }}
              aria-hidden="true"
            />
            <span className={cn("flex-1 truncate", selected && "text-(--color-text-primary)")}>{opt.label}</span>
            {selected && <CheckIcon size={ICON_SIZE.XS} weight="bold" className="shrink-0 text-(--color-accent)" />}
          </DropdownMenuItem>
        );
      })}
    </FieldEditor>
  );
}
