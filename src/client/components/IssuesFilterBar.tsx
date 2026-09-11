// eslint-disable-next-line no-restricted-imports -- useEffect debounces the search box to the store (timer with cleanup) and mirrors external resets (Clear filters) back into the local input
import { useEffect, useState, type ReactNode } from "react";
import { CaretDownIcon, CheckIcon, MagnifyingGlassIcon, XIcon } from "@phosphor-icons/react";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover.js";
import { Avatar } from "./ui/avatar.js";
import { priorityColor, statusDotColor } from "./IssueFieldControls.js";
import { labelDotColor } from "./issue-label-color.js";
import { useSurfaceLuminance } from "../hooks/useSurfaceLuminance.js";
import { adaptColorForSurface } from "../utils/status-color.js";
import { ICON_SIZE } from "../design-tokens.js";
import {
  PRIORITY_OPTIONS,
  UNASSIGNED,
  type AssigneeOption,
  type IssueFilters,
  type LabelOption,
  type StatusOption,
} from "./issues-filter.js";
import type { IssuePriorityLevel } from "../../server/shared/types.js";

export interface IssuesFilterBarProps {
  filters: IssueFilters;
  statusOptions: StatusOption[];
  assigneeOptions: AssigneeOption[];
  labelOptions: LabelOption[];
  priorityCounts: Record<IssuePriorityLevel, number>;
  onSetQuery: (query: string) => void;
  onTogglePriority: (level: IssuePriorityLevel) => void;
  onToggleStatus: (name: string) => void;
  onToggleAssignee: (value: string) => void;
  onToggleLabel: (name: string) => void;
}

function SearchBox({ query, onSetQuery }: { query: string; onSetQuery: (q: string) => void }) {
  const [text, setText] = useState(query);

  // eslint-disable-next-line no-restricted-syntax -- sync local input state when the store query is reset externally
  useEffect(() => {
    setText(query);
  }, [query]);

  // eslint-disable-next-line no-restricted-syntax -- debounce timer with cleanup; commits keystrokes to the store after a pause
  useEffect(() => {
    if (text === query) return;
    const id = setTimeout(() => onSetQuery(text), 150);
    return () => clearTimeout(id);
  }, [text, query, onSetQuery]);

  return (
    <label className="flex-1 flex items-center gap-2 min-w-0 h-8 rounded-md border border-(--color-border-secondary) bg-(--color-bg-tertiary) px-2.5">
      <MagnifyingGlassIcon size={ICON_SIZE.SM} className="shrink-0 text-(--color-text-tertiary)" />
      <input
        type="text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Search issues…"
        aria-label="Search issues"
        className="flex-1 min-w-0 bg-transparent text-sm text-(--color-text-primary) placeholder:text-(--color-text-tertiary) outline-none"
      />
      {text && (
        <button
          type="button"
          onClick={() => {
            setText("");
            onSetQuery("");
          }}
          aria-label="Clear search"
          className="shrink-0 text-(--color-text-tertiary) hover:text-(--color-text-secondary)"
        >
          <XIcon size={ICON_SIZE.XS} />
        </button>
      )}
    </label>
  );
}

function FacetTrigger({
  label,
  count,
  variant = "button",
}: {
  label: string;
  count: number;
  variant?: "button" | "chip";
}) {
  const active = count > 0;
  const base = variant === "chip" ? "rounded-full px-3" : "rounded-md px-2.5";
  return (
    <button
      type="button"
      className={`inline-flex items-center gap-1.5 whitespace-nowrap h-8 border text-xs transition-colors cursor-pointer ${base} ${
        active
          ? "border-(--color-accent) text-(--color-text-primary) bg-(--color-bg-tertiary)"
          : "border-(--color-border-secondary) text-(--color-text-secondary) bg-(--color-bg-tertiary) hover:text-(--color-text-primary)"
      }`}
    >
      {label}
      {active && (
        <span className="inline-flex items-center justify-center min-w-[16px] h-4 px-1 rounded-full bg-(--color-accent) text-(--color-accent-text) text-[10px] font-bold">
          {count}
        </span>
      )}
      <CaretDownIcon size={ICON_SIZE.XS} className="text-(--color-text-tertiary)" />
    </button>
  );
}

function OptionRow({
  checked,
  onToggle,
  count,
  color,
  children,
}: {
  checked: boolean;
  onToggle: () => void;
  count: number;
  color?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitemcheckbox"
      aria-checked={checked}
      onClick={onToggle}
      className="w-full flex items-center gap-2.5 px-2 py-1.5 rounded-md text-sm text-(--color-text-secondary) hover:bg-(--color-bg-hover) hover:text-(--color-text-primary) cursor-pointer"
    >
      <span
        className={`shrink-0 w-4 h-4 rounded border inline-flex items-center justify-center transition-colors ${
          color
            ? ""
            : checked
              ? "bg-(--color-accent) border-(--color-accent) text-(--color-accent-text)"
              : "border-(--color-border-secondary)"
        }`}
        style={
          color
            ? {
                borderColor: color,
                color,
                backgroundColor: checked ? `color-mix(in oklab, ${color} 22%, transparent)` : "transparent",
              }
            : undefined
        }
      >
        {checked && <CheckIcon size={ICON_SIZE.XS} weight="bold" />}
      </span>
      {children}
      <span className="flex-1" />
      <span className="text-[11px] text-(--color-text-tertiary)">{count}</span>
    </button>
  );
}

function AssigneeAvatar({ option }: { option: AssigneeOption }) {
  if (option.value === UNASSIGNED) {
    return (
      <span className="shrink-0 w-[18px] text-center text-(--color-text-tertiary)" aria-hidden="true">
        —
      </span>
    );
  }
  return (
    <Avatar
      name={option.label}
      avatarUrl={option.avatarUrl}
      size={18}
      getInitials={initials}
      alt=""
      className="bg-(--color-bg-hover) text-(--color-text-secondary) text-[9px] font-bold inline-flex"
    />
  );
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function IssuesFilterBar({
  filters,
  statusOptions,
  assigneeOptions,
  labelOptions,
  priorityCounts,
  onSetQuery,
  onTogglePriority,
  onToggleStatus,
  onToggleAssignee,
  onToggleLabel,
}: IssuesFilterBarProps) {
  const popoverSurfaceLum = useSurfaceLuminance("--color-bg-elevated");

  const priorityFacet = (variant: "button" | "chip") => (
    <Popover>
      <PopoverTrigger asChild>
        <span>
          <FacetTrigger label="Priority" count={filters.priorities.size} variant={variant} />
        </span>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-56 p-1.5">
        {PRIORITY_OPTIONS.map((opt) => (
          <OptionRow
            key={opt.level}
            checked={filters.priorities.has(opt.level)}
            onToggle={() => onTogglePriority(opt.level)}
            count={priorityCounts[opt.level] ?? 0}
            color={priorityColor(opt.level, popoverSurfaceLum)}
          >
            <span>{opt.label}</span>
          </OptionRow>
        ))}
      </PopoverContent>
    </Popover>
  );

  const statusFacet = (variant: "button" | "chip") => (
    <Popover>
      <PopoverTrigger asChild>
        <span>
          <FacetTrigger label="Status" count={filters.statuses.size} variant={variant} />
        </span>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-56 p-1.5">
        {statusOptions.length === 0 ? (
          <div className="px-2 py-1.5 text-xs text-(--color-text-tertiary)">No statuses</div>
        ) : (
          statusOptions.map((opt) => (
            <OptionRow
              key={opt.name}
              checked={filters.statuses.has(opt.name)}
              onToggle={() => onToggleStatus(opt.name)}
              count={opt.count}
              color={adaptColorForSurface(statusDotColor(opt), popoverSurfaceLum)}
            >
              <span className="truncate">{opt.name}</span>
            </OptionRow>
          ))
        )}
      </PopoverContent>
    </Popover>
  );

  const assigneeFacet = (variant: "button" | "chip") => (
    <Popover>
      <PopoverTrigger asChild>
        <span>
          <FacetTrigger label="Assignee" count={filters.assignees.size} variant={variant} />
        </span>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-56 p-1.5">
        {assigneeOptions.length === 0 ? (
          <div className="px-2 py-1.5 text-xs text-(--color-text-tertiary)">No assignees</div>
        ) : (
          assigneeOptions.map((opt) => (
            <OptionRow
              key={opt.value}
              checked={filters.assignees.has(opt.value)}
              onToggle={() => onToggleAssignee(opt.value)}
              count={opt.count}
            >
              <AssigneeAvatar option={opt} />
              <span className="truncate">{opt.label}</span>
            </OptionRow>
          ))
        )}
      </PopoverContent>
    </Popover>
  );

  const labelFacet = (variant: "button" | "chip") => (
    <Popover>
      <PopoverTrigger asChild>
        <span>
          <FacetTrigger label="Labels" count={filters.labels.size} variant={variant} />
        </span>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-56 p-1.5">
        {labelOptions.length === 0 ? (
          <div className="px-2 py-1.5 text-xs text-(--color-text-tertiary)">No labels</div>
        ) : (
          labelOptions.map((opt) => (
            <OptionRow
              key={opt.name}
              checked={filters.labels.has(opt.name)}
              onToggle={() => onToggleLabel(opt.name)}
              count={opt.count}
              color={opt.color ?? labelDotColor(opt.name)}
            >
              <span className="truncate">{opt.name}</span>
            </OptionRow>
          ))
        )}
      </PopoverContent>
    </Popover>
  );

  return (
    <div className="border-b border-(--color-border-secondary) bg-(--color-bg-primary)">
      <div className="hidden md:flex items-center gap-2 px-3 py-2">
        <SearchBox query={filters.query} onSetQuery={onSetQuery} />
        {priorityFacet("button")}
        {statusFacet("button")}
        {assigneeFacet("button")}
        {labelFacet("button")}
      </div>

      <div className="md:hidden flex flex-col gap-2 px-3 py-2">
        <SearchBox query={filters.query} onSetQuery={onSetQuery} />
        <div className="flex items-center gap-2 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {priorityFacet("chip")}
          {statusFacet("chip")}
          {assigneeFacet("chip")}
          {labelFacet("chip")}
        </div>
      </div>
    </div>
  );
}
