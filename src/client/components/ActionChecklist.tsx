import { useCallback, useState } from "react";
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
  /**
   * Already sent to the agent: greyed and tagged SENT. Still selectable —
   * an agent can crash or ignore it, and re-sending is the user's call
   * (docs/303 req 17).
   */
  taken?: boolean;
}

const EMPTY: ReadonlySet<string> = new Set();

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
  for (const item of items) keys.add(item.key);

  let selected = state.selected;
  for (const item of items) {
    // A row already sent is never pre-ticked: sending it again is deliberate.
    if (!state.keys.has(item.key) && item.defaultChecked && !item.taken) {
      selected = new Set(selected).add(item.key);
    }
  }
  for (const key of selected) {
    if (!keys.has(key)) {
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
   * What ticking a row means, when it is not "approve this". The status card's
   * manual steps read "I've done this" (docs/303 req 29).
   */
  toggleHint?: string;
}

export function ActionChecklist({ items, selected, onToggle, ariaLabel, toggleHint }: ActionChecklistProps) {
  return (
    <div className="flex flex-col gap-0.5" role="group" aria-label={ariaLabel}>
      {items.map((item) => {
        const taken = item.taken === true;
        const checked = selected.has(item.key);
        return (
          <label
            key={item.key}
            title={toggleHint}
            // `relative` contains the `sr-only` box below, which is absolutely
            // positioned: with no containing block in the row it lands far down
            // the page, and focusing it on click scrolls the chat column out of
            // the window (planning#592).
            className={`relative flex items-start gap-2.5 rounded-md px-2 py-1.5 transition-colors cursor-pointer ${
              checked ? "bg-(--color-accent-subtle)" : "hover:bg-(--color-bg-hover)"
            }`}
          >
            <input
              type="checkbox"
              className="sr-only"
              checked={checked}
              {...(toggleHint ? { "aria-label": `${toggleHint}: ${item.label}` } : {})}
              onChange={() => onToggle(item.key)}
            />
            <span
              aria-hidden="true"
              className={`shrink-0 mt-px inline-flex items-center justify-center w-4 h-4 rounded border transition-colors ${
                checked
                  ? "bg-(--color-accent) border-(--color-accent) text-(--color-accent-text)"
                  // An empty box needs a surface of its own: on the status card's
                  // accent-tinted body, a borderline alone all but disappears.
                  : "bg-(--color-bg-primary) border-(--color-border-secondary) text-transparent"
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
              {/* Grey alone does not say why a row is grey (docs/303 req 17). */}
              {taken && (
                <span className="ml-1.5 align-middle text-[10px] font-semibold tracking-wide text-(--color-text-tertiary) bg-(--color-bg-tertiary) rounded-full px-1.5 py-px">
                  SENT
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
