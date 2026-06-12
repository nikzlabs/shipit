/**
 * IssueLabelsEditor — the on-page, multi-select label editor for the inline
 * issue detail view (the follow-up to the label-colors foundation).
 *
 * Unlike the single-select status/priority inline editors (`IssueFieldControls`),
 * labels are a *set*, so this uses a `Popover` (which stays open across clicks)
 * with checkbox rows rather than a `DropdownMenu` (which closes on select). It's
 * a "pick from existing" editor: it lists the tracker's pickable label set and
 * toggles membership — it never creates a brand-new label.
 *
 * Each toggle commits immediately, posting the issue's COMPLETE new label-name
 * set (a wholesale replace). The committed issue patches the store in place, so
 * `current` flows back down and the checkboxes reflect the saved state — the
 * same immediate-write model the status/priority editors use, just multi-select.
 */

import { useMemo, useState } from "react";
import { CheckIcon, MagnifyingGlassIcon, PlusIcon } from "@phosphor-icons/react";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover.js";
import { labelDotColor } from "./issue-label-color.js";
import { ICON_SIZE } from "../design-tokens.js";
import type { IssueLabel } from "../../server/shared/types.js";

export interface IssueLabelsEditorProps {
  /** The labels currently on the issue (the live, store-patched set). */
  current: IssueLabel[];
  /** The tracker's full pickable label set (name + color). */
  available: IssueLabel[];
  /** Fired when the popover opens — lazily fetch {@link available}. */
  onOpen: () => void;
  /**
   * Commit the issue's COMPLETE desired label-name set (wholesale replace).
   * Resolves to an error message, or null on success.
   */
  onCommit: (names: string[]) => Promise<string | null>;
}

export function IssueLabelsEditor({ current, available, onOpen, onCommit }: IssueLabelsEditorProps) {
  const [query, setQuery] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const currentNames = useMemo(() => new Set(current.map((l) => l.name)), [current]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return available;
    return available.filter((l) => l.name.toLowerCase().includes(q));
  }, [available, query]);

  const toggle = async (name: string) => {
    if (saving) return;
    const next = new Set(currentNames);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    setSaving(true);
    setError(null);
    const err = await onCommit([...next]);
    setSaving(false);
    if (err) setError(err);
  };

  return (
    <Popover
      onOpenChange={(open) => {
        if (open) {
          setQuery("");
          setError(null);
          onOpen();
        }
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Edit labels"
          className="inline-flex items-center gap-1 rounded-full border border-dashed border-(--color-border-secondary) px-2.5 py-0.5 text-[11px] font-medium text-(--color-text-secondary) transition-colors cursor-pointer hover:border-(--color-accent) hover:text-(--color-text-primary)"
        >
          <PlusIcon size={ICON_SIZE.XS} weight="bold" />
          {current.length === 0 ? "Add label" : "Edit"}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-60 p-1.5">
        <label className="mb-1 flex h-8 items-center gap-2 rounded-md border border-(--color-border-primary) bg-(--color-bg-tertiary) px-2">
          <MagnifyingGlassIcon size={ICON_SIZE.XS} className="shrink-0 text-(--color-text-tertiary)" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter labels…"
            aria-label="Filter labels"
            className="min-w-0 flex-1 bg-transparent text-sm text-(--color-text-primary) outline-none placeholder:text-(--color-text-tertiary)"
          />
        </label>

        <div className="max-h-64 overflow-y-auto">
          {available.length === 0 ? (
            <div className="px-2 py-1.5 text-xs text-(--color-text-tertiary)">No labels in this tracker</div>
          ) : filtered.length === 0 ? (
            <div className="px-2 py-1.5 text-xs text-(--color-text-tertiary)">No match</div>
          ) : (
            filtered.map((label) => {
              const checked = currentNames.has(label.name);
              return (
                <button
                  key={label.name}
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={checked}
                  disabled={saving}
                  onClick={() => void toggle(label.name)}
                  className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-sm text-(--color-text-secondary) hover:bg-(--color-bg-hover) hover:text-(--color-text-primary) cursor-pointer disabled:opacity-60"
                >
                  <span
                    className={`inline-flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                      checked
                        ? "border-(--color-accent) bg-(--color-accent) text-(--color-accent-text)"
                        : "border-(--color-border-secondary)"
                    }`}
                  >
                    {checked && <CheckIcon size={ICON_SIZE.XS} weight="bold" />}
                  </span>
                  <span
                    className="size-2 shrink-0 rounded-full"
                    style={{ backgroundColor: label.color ?? labelDotColor(label.name) }}
                    aria-hidden="true"
                  />
                  <span className="flex-1 truncate text-left">{label.name}</span>
                </button>
              );
            })
          )}
        </div>

        {error && <div className="px-2 pt-1 text-[11px] text-(--color-error)">{error}</div>}
      </PopoverContent>
    </Popover>
  );
}
