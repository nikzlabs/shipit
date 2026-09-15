import { useCallback, useState, type ReactNode } from "react";
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

interface SelectionState {
  /** The keys of the previous render, so an item arriving anew can be told apart. */
  keys: ReadonlySet<string>;
  selected: ReadonlySet<string>;
}

function sameKeys(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return a.size === b.size && [...a].every((k) => b.has(k));
}

/**
 * Selection state for a checklist whose items may change under it: an item
 * applies its `defaultChecked` when it arrives, and a key that leaves or
 * becomes taken leaves the selection with it. A key that leaves and comes back
 * counts as arriving anew.
 *
 * The seen keys live in the same state as the selection so a discarded render
 * discards both; a ref advanced during render would survive one and lose the
 * defaults it recorded.
 */
export function useChecklistSelection(items: readonly ChecklistItem[]): ChecklistSelection {
  const [state, setState] = useState<SelectionState>({ keys: EMPTY, selected: EMPTY });

  const keys = new Set<string>();
  const live = new Set<string>();
  for (const item of items) {
    keys.add(item.key);
    if (selectable(item)) live.add(item.key);
  }

  let selected = state.selected;
  for (const item of items) {
    if (!state.keys.has(item.key) && item.defaultChecked && selectable(item)) {
      selected = new Set(selected).add(item.key);
    }
  }
  for (const key of selected) {
    if (!live.has(key)) {
      const pruned = new Set(selected);
      pruned.delete(key);
      selected = pruned;
    }
  }
  if (selected !== state.selected || !sameKeys(keys, state.keys)) {
    setState({ keys, selected });
  }

  const toggle = useCallback((key: string) => {
    setState((prev) => {
      const updated = new Set(prev.selected);
      if (updated.has(key)) updated.delete(key);
      else updated.add(key);
      return { ...prev, selected: updated };
    });
  }, []);

  const clear = useCallback(() => setState((prev) => ({ ...prev, selected: EMPTY })), []);

  return { selected, toggle, clear };
}

export interface ActionChecklistProps {
  items: readonly ChecklistItem[];
  selected: ReadonlySet<string>;
  onToggle: (key: string) => void;
  ariaLabel: string;
  /**
   * The offers of the session status card wrap in one row rather than stacking,
   * so the card stays as short as the mockup (docs/303 req 2).
   */
  dense?: boolean;
  /** Dense only: shares the wrapping row, so Send lands on its last line. */
  trailing?: ReactNode;
}

export function ActionChecklist({ items, selected, onToggle, ariaLabel, dense, trailing }: ActionChecklistProps) {
  if (dense) {
    return (
      <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1.5" role="group" aria-label={ariaLabel}>
        {items.map((item) => {
          const taken = !selectable(item);
          const checked = !taken && selected.has(item.key);
          return (
            <label
              key={item.key}
              className={`inline-flex items-center gap-1.5 ${taken ? "cursor-default" : "cursor-pointer"}`}
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
                className={`shrink-0 inline-flex items-center justify-center w-3.5 h-3.5 rounded-sm border transition-[background-color,border-color] duration-(--duration-fast) ${
                  checked
                    ? "bg-(--color-accent) border-(--color-accent) text-(--color-accent-text)"
                    : "border-(--color-border-primary) text-transparent"
                }`}
              >
                <CheckIcon size={ICON_SIZE.XS} weight="bold" />
              </span>
              <span className={taken ? "text-(--color-text-tertiary)" : "text-(--color-text-primary)"}>
                {item.label}
                {item.description && (
                  <span className={`ml-1.5 ${taken ? "text-(--color-text-tertiary)" : "text-(--color-text-secondary)"}`}>
                    {item.description}
                  </span>
                )}
              </span>
            </label>
          );
        })}
        {trailing && <span className="ml-auto">{trailing}</span>}
      </div>
    );
  }

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
  /** The status card's Send sits in the wrapping offers row; it stays small and quiet. */
  dense?: boolean;
}

export function ChecklistSubmitButton({ label, disabled, onClick, dense }: ChecklistSubmitButtonProps) {
  if (dense) {
    return (
      <Button variant="secondary" size="sm" onClick={onClick} disabled={disabled}>
        {label}
      </Button>
    );
  }
  return (
    <Button variant="primary" size="md" onClick={onClick} disabled={disabled}>
      <ArrowRightIcon size={ICON_SIZE.SM} weight="bold" />
      {label}
    </Button>
  );
}
