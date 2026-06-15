/**
 * Sort & group editor for the Issues panel (docs/206).
 *
 * The toolbar row already holds search + filter facets, so this two-level sort
 * (primary → secondary, each with a direction) plus an independent group-by
 * field lives in a modal behind a sliders icon rather than inline. Changes apply
 * live; "Reset to default" restores the priority→identifier order with no
 * grouping; "Done" closes.
 */

import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog.js";
import { Button } from "./ui/button.js";
import {
  DEFAULT_SORT_PREFS,
  SORT_KEY_LABELS,
  type GroupKey,
  type SecondaryKey,
  type SortDir,
  type SortKey,
  type SortPrefs,
} from "./issues-sort.js";
import { cn } from "../utils/cn.js";

const SORT_KEYS: SortKey[] = ["priority", "status", "title", "updated", "assignee"];
const GROUP_KEYS: GroupKey[] = ["none", "priority", "status", "assignee"];

const SELECT_CLASS =
  "flex-1 appearance-none rounded-md bg-(--color-bg-tertiary) border border-(--color-border-secondary) " +
  "px-2.5 py-1.5 pr-7 text-sm text-(--color-text-primary) cursor-pointer hover:border-(--color-accent) " +
  "focus:outline-none focus-visible:ring-1 focus-visible:ring-(--color-border-focus) " +
  "bg-[url('data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%2212%22 height=%2212%22 viewBox=%220 0 24 24%22 fill=%22none%22 stroke=%22%23a1a1aa%22 stroke-width=%222.5%22><path d=%22M6 9l6 6 6-6%22/></svg>')] bg-no-repeat bg-[right_0.5rem_center]";

/** Segmented Asc/Desc direction toggle. */
function DirToggle({
  value,
  onChange,
  ariaLabel,
}: {
  value: SortDir;
  onChange: (dir: SortDir) => void;
  ariaLabel: string;
}) {
  return (
    <div className="inline-flex shrink-0 rounded-md border border-(--color-border-secondary) overflow-hidden" role="group" aria-label={ariaLabel}>
      {([1, -1] as SortDir[]).map((dir) => (
        <button
          key={dir}
          type="button"
          aria-pressed={value === dir}
          onClick={() => onChange(dir)}
          className={cn(
            "px-2.5 py-1.5 text-xs font-semibold cursor-pointer transition-colors",
            dir === -1 && "border-l border-(--color-border-secondary)",
            value === dir
              ? "bg-(--color-accent) text-(--color-accent-text)"
              : "bg-(--color-bg-tertiary) text-(--color-text-tertiary) hover:text-(--color-text-secondary)",
          )}
        >
          {dir === 1 ? "Asc" : "Desc"}
        </button>
      ))}
    </div>
  );
}

function FieldLabel({ children }: { children: string }) {
  return (
    <span className="text-[11px] uppercase tracking-wide font-semibold text-(--color-text-tertiary)">{children}</span>
  );
}

export function IssuesSortModal({
  open,
  onOpenChange,
  prefs,
  onChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  prefs: SortPrefs;
  onChange: (prefs: SortPrefs) => void;
}) {
  const patch = (p: Partial<SortPrefs>) => onChange({ ...prefs, ...p });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[380px] max-w-[calc(100vw-2rem)]">
        <DialogHeader>
          <DialogTitle>Sort &amp; group</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4 px-5 py-4">
          {/* Sort by (primary) */}
          <div className="flex flex-col gap-2">
            <FieldLabel>Sort by</FieldLabel>
            <div className="flex items-center gap-2">
              <select
                className={SELECT_CLASS}
                value={prefs.primary}
                aria-label="Primary sort key"
                onChange={(e) => {
                  const primary = e.target.value as SortKey;
                  // Don't let the secondary duplicate the primary — drop it to none.
                  patch({ primary, ...(prefs.secondary === primary ? { secondary: "none" } : {}) });
                }}
              >
                {SORT_KEYS.map((k) => (
                  <option key={k} value={k}>{SORT_KEY_LABELS[k]}</option>
                ))}
              </select>
              <DirToggle value={prefs.primaryDir} ariaLabel="Primary direction" onChange={(d) => patch({ primaryDir: d })} />
            </div>

            {/* then by (secondary) */}
            <span className="text-[11px] text-(--color-text-tertiary) ml-0.5">then by</span>
            <div className="flex items-center gap-2">
              <select
                className={SELECT_CLASS}
                value={prefs.secondary}
                aria-label="Secondary sort key"
                onChange={(e) => patch({ secondary: e.target.value as SecondaryKey })}
              >
                <option value="none">None</option>
                {SORT_KEYS.filter((k) => k !== prefs.primary).map((k) => (
                  <option key={k} value={k}>{SORT_KEY_LABELS[k]}</option>
                ))}
              </select>
              <DirToggle
                value={prefs.secondaryDir}
                ariaLabel="Secondary direction"
                onChange={(d) => patch({ secondaryDir: d })}
              />
            </div>
          </div>

          {/* Group by */}
          <div className="flex flex-col gap-2">
            <FieldLabel>Group by</FieldLabel>
            <select
              className={SELECT_CLASS}
              value={prefs.group}
              aria-label="Group by field"
              onChange={(e) => patch({ group: e.target.value as GroupKey })}
            >
              {GROUP_KEYS.map((k) => (
                <option key={k} value={k}>{k === "none" ? "None" : SORT_KEY_LABELS[k as SortKey]}</option>
              ))}
            </select>
          </div>
        </div>

        <DialogFooter className="justify-between">
          <button
            type="button"
            onClick={() => onChange({ ...DEFAULT_SORT_PREFS })}
            className="text-xs text-(--color-text-tertiary) hover:text-(--color-text-secondary) cursor-pointer"
          >
            Reset to default
          </button>
          <Button variant="primary" size="md" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
