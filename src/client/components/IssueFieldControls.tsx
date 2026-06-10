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

import { useState, type ReactNode } from "react";
import { CaretDownIcon, CheckIcon, CircleNotchIcon } from "@phosphor-icons/react";
import { Badge } from "./ui/badge.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu.js";
import { PRIORITY_OPTIONS } from "./issues-filter.js";
import { ICON_SIZE } from "../design-tokens.js";
import { cn } from "../utils/cn.js";
import type { IssuePriorityLevel, TrackerIssue } from "../../server/shared/types.js";

/** A tracker status option ({@link TrackerIssue.status} / `availableStatuses`). */
export interface IssueStatusRef {
  name: string;
  type?: string;
}

/**
 * Priority badge variant by normalized level — shared so the editor's trigger
 * and option rows match the read-only badges elsewhere in the tab.
 */
export const PRIORITY_VARIANT: Record<IssuePriorityLevel, "default" | "error" | "warning" | "info"> = {
  urgent: "error",
  high: "warning",
  medium: "info",
  low: "default",
  none: "default",
};

/** Menu-dot color by normalized priority level. */
const PRIORITY_DOT: Record<IssuePriorityLevel, string> = {
  urgent: "bg-(--color-error)",
  high: "bg-(--color-warning)",
  medium: "bg-(--color-info)",
  low: "bg-(--color-text-tertiary)",
  none: "bg-(--color-text-tertiary)",
};

/** Status-dot color by normalized workflow-state type (mirrors the detail pill). */
export function statusDotClass(type?: string): string {
  switch (type) {
    case "completed":
      return "bg-(--color-success)";
    case "started":
      return "bg-(--color-accent)";
    case "canceled":
    case "unstarted":
    case "backlog":
    case "triage":
    default:
      return "bg-(--color-text-tertiary)";
  }
}

/**
 * The clickable priority value used as an editor trigger. Renders the colored
 * badge, or a faint "No priority" placeholder when unset so an unprioritized
 * issue still has something to click. Exported for read-only-adjacent reuse.
 */
export function PriorityTrigger({ priority }: { priority: TrackerIssue["priority"] }) {
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
    <Badge variant={PRIORITY_VARIANT[priority.level]} className="h-[18px] text-[11px]">
      {priority.label}
      {caret}
    </Badge>
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
            <CaretDownIcon
              size={ICON_SIZE.XS}
              className="shrink-0 max-w-0 overflow-hidden opacity-0 text-(--color-text-tertiary) transition-all duration-150 group-hover/fe:ml-0.5 group-hover/fe:max-w-3.5 group-hover/fe:opacity-100 group-focus-visible/fe:ml-0.5 group-focus-visible/fe:max-w-3.5 group-focus-visible/fe:opacity-100 group-data-[state=open]/fe:ml-0.5 group-data-[state=open]/fe:max-w-3.5 group-data-[state=open]/fe:opacity-100"
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
            <span className={cn("size-2 shrink-0 rounded-full", statusDotClass(opt.type))} aria-hidden="true" />
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
            <span className={cn("size-2 shrink-0 rounded-full", PRIORITY_DOT[opt.level])} aria-hidden="true" />
            <span className={cn("flex-1 truncate", selected && "text-(--color-text-primary)")}>{opt.label}</span>
            {selected && <CheckIcon size={ICON_SIZE.XS} weight="bold" className="shrink-0 text-(--color-accent)" />}
          </DropdownMenuItem>
        );
      })}
    </FieldEditor>
  );
}
