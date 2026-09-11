import { useState, type CSSProperties, type ReactNode } from "react";
import { Spinner } from "./Spinner.js";
import { CaretDownIcon, CheckIcon } from "@phosphor-icons/react";
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

export interface IssueStatusRef {
  name: string;
  type?: string;
  color?: string;
}

// Fixed hues keep priorities distinct when themes retint semantic colors.
export const PRIORITY_DOT_COLOR: Record<IssuePriorityLevel, string> = {
  urgent: "#ef4444",
  high: "#f59e0b",
  medium: "#3b82f6",
  low: "#22c55e",
  none: "#9ca3af",
};

export function priorityColor(level: IssuePriorityLevel, surfaceLum: number): string {
  return adaptColorForSurface(PRIORITY_DOT_COLOR[level], surfaceLum);
}

const PRIORITY_PILL = "inline-flex items-center rounded-full px-2 h-[18px] text-[11px] font-medium leading-none";

// Text needs more contrast than a color swatch.
const PRIORITY_TEXT_CONTRAST = 3.8;

function priorityPillStyle(level: IssuePriorityLevel, surfaceLum: number): CSSProperties {
  const base = PRIORITY_DOT_COLOR[level];
  return {
    backgroundColor: `color-mix(in oklab, ${base} 16%, transparent)`,
    color: adaptColorForSurface(base, surfaceLum, PRIORITY_TEXT_CONTRAST),
  };
}

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

export function statusDotColor(status?: { type?: string; color?: string }): string {
  return status?.color ?? statusTypeColor(status?.type);
}

export function PriorityTrigger({
  priority,
  surfaceLum,
}: {
  priority: TrackerIssue["priority"];
  surfaceLum: number;
}) {
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
            "group/fe inline-flex max-w-full items-center rounded-full",
            "cursor-pointer focus:outline-none focus-visible:ring-1 focus-visible:ring-(--color-border-focus)",
            error && "ring-1 ring-(--color-error)",
          )}
        >
          <span className="inline-flex min-w-0 items-center gap-1">{trigger}</span>
          {saving ? (
            <Spinner size={ICON_SIZE.XS} className="ml-1 shrink-0 text-(--color-text-tertiary)" />
          ) : chevron ? (
            <CaretDownIcon
              size={ICON_SIZE.XS}
              className="ml-0.5 shrink-0 opacity-0 text-(--color-text-tertiary) transition-opacity duration-150 group-hover/fe:opacity-100 group-focus-visible/fe:opacity-100 group-data-[state=open]/fe:opacity-100"
            />
          ) : null}
        </button>
      </DropdownMenuTrigger>
      {/* Portal events still bubble through React to the clickable issue row. */}
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
