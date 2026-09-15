import { useCallback, useRef, useState } from "react";
import { ArrowRightIcon, CheckIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import { Button } from "./ui/button.js";

/**
 * One tickable row. `key` is the selection identity and is the caller's to
 * choose: the action id on a transcript action card, the server-owned
 * `offerId` on the session status card (docs/303-session-status-card).
 */
export interface ChecklistItem {
  key: string;
  label: string;
  description?: string;
  defaultChecked?: boolean;
  /** Already sent to the agent: greyed, unchecked and not selectable. */
  taken?: boolean;
}

const EMPTY: ReadonlySet<string> = new Set();

function selectable(item: ChecklistItem): boolean {
  return !item.taken;
}

export interface ChecklistSelection {
  selected: ReadonlySet<string>;
  toggle: (key: string) => void;
  clear: () => void;
}

/**
 * Selection state for a checklist whose items may change under it: an item
 * applies its `defaultChecked` the first time it appears, and a key that
 * leaves or becomes taken leaves the selection with it.
 */
export function useChecklistSelection(items: readonly ChecklistItem[]): ChecklistSelection {
  const [selected, setSelected] = useState<ReadonlySet<string>>(EMPTY);
  const seen = useRef<Set<string>>(new Set());

  let next = selected;
  const live = new Set<string>();
  for (const item of items) {
    if (selectable(item)) live.add(item.key);
    if (!seen.current.has(item.key) && item.defaultChecked && selectable(item)) {
      next = new Set(next).add(item.key);
    }
  }
  seen.current = new Set(items.map((i) => i.key));
  for (const key of next) {
    if (!live.has(key)) {
      const pruned = new Set(next);
      pruned.delete(key);
      next = pruned;
    }
  }
  if (next !== selected) setSelected(next);

  const toggle = useCallback((key: string) => {
    setSelected((prev) => {
      const updated = new Set(prev);
      if (updated.has(key)) updated.delete(key);
      else updated.add(key);
      return updated;
    });
  }, []);

  const clear = useCallback(() => setSelected(EMPTY), []);

  return { selected: next, toggle, clear };
}

export interface ActionChecklistProps {
  items: readonly ChecklistItem[];
  selected: ReadonlySet<string>;
  onToggle: (key: string) => void;
  ariaLabel: string;
}

export function ActionChecklist({ items, selected, onToggle, ariaLabel }: ActionChecklistProps) {
  return (
    <div className="flex flex-col gap-0.5" role="group" aria-label={ariaLabel}>
      {items.map((item) => {
        const taken = !selectable(item);
        const checked = !taken && selected.has(item.key);
        return (
          <label
            key={item.key}
            className={`flex items-start gap-2.5 rounded-md px-2 py-1.5 transition-colors ${
              taken
                ? "cursor-default"
                : `cursor-pointer ${checked ? "bg-(--color-accent-subtle)" : "hover:bg-(--color-bg-hover)"}`
            }`}
          >
            <input
              type="checkbox"
              className="sr-only"
              checked={checked}
              disabled={taken}
              onChange={() => onToggle(item.key)}
            />
            <span
              aria-hidden="true"
              className={`shrink-0 mt-0.5 inline-flex items-center justify-center w-4 h-4 rounded border transition-colors ${
                checked
                  ? "bg-(--color-accent) border-(--color-accent) text-(--color-accent-text)"
                  : "border-(--color-border-primary) text-transparent"
              }`}
            >
              <CheckIcon size={ICON_SIZE.XS} weight="bold" />
            </span>
            <span className="min-w-0 flex-1">
              <span
                className={`font-medium ${taken ? "text-(--color-text-tertiary)" : "text-(--color-text-primary)"}`}
              >
                {item.label}
              </span>
              {item.defaultChecked && !taken && (
                <span className="ml-1.5 align-middle text-[10px] font-semibold tracking-wide text-(--color-text-link) bg-(--color-accent-subtle) rounded-full px-1.5 py-px">
                  RECOMMENDED
                </span>
              )}
              {item.description && (
                <span
                  className={`block mt-0.5 ${taken ? "text-(--color-text-tertiary)" : "text-(--color-text-secondary)"}`}
                >
                  {item.description}
                </span>
              )}
            </span>
          </label>
        );
      })}
    </div>
  );
}

export interface ChecklistSubmitButtonProps {
  label: string;
  disabled?: boolean;
  onClick: () => void;
}

export function ChecklistSubmitButton({ label, disabled, onClick }: ChecklistSubmitButtonProps) {
  return (
    <Button variant="primary" size="md" onClick={onClick} disabled={disabled}>
      <ArrowRightIcon size={ICON_SIZE.SM} weight="bold" />
      {label}
    </Button>
  );
}
