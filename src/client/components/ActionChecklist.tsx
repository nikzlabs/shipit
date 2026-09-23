import { useCallback, useState, type ReactNode } from "react";
import { ArrowRightIcon, CheckIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import { Button } from "./ui/button.js";
import { InlineMarkdown } from "./message-markdown.js";

/**
 * A row's text is markdown (docs/303-session-status-card req 41), with ShipIt
 * pointers enabled. Every item here is text the agent composed in a tool call —
 * a status card's offer or manual step, a transcript action card's action — so
 * it sits at the trust level of the agent's own transcript prose, which enables
 * them too. Nothing ingests a repository, tracker or PR document into a row;
 * what the boundary in `shipitLinkComponents` rules out is a surface that
 * renders such a document, and this is not one.
 */

/** What a click on a row's text must leave alone rather than turn into a tick. */
const INTERACTIVE = "a, button, input, textarea, select, label, [role='button']";

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
  /**
   * Was ticked at the moment it was sent, so the box keeps a tick as a RECORD
   * of what the user reported (docs/303 req 44). Drawn muted, never in the
   * accent, so it cannot be read as a tick waiting to be submitted; a row sent
   * with a note alone carries no record.
   */
  takenChecked?: boolean;
  /**
   * An extra pill after the label, in the same style as RECOMMENDED. The status
   * card marks a step ANSWERED with it: unticked normally means "nothing will be
   * sent", and an answered step breaks that (docs/303 req 37).
   */
  tag?: string;
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
  /**
   * A control beside the row's text, OUTSIDE the label — a button inside it
   * would toggle the checkbox as well as itself. The status card's manual steps
   * put the note control here (docs/303 req 37).
   */
  renderTrailing?: (item: ChecklistItem) => ReactNode;
  /** Content under the row, indented to the label's text and inside its tint. */
  renderBelow?: (item: ChecklistItem) => ReactNode;
}

export function ActionChecklist({
  items,
  selected,
  onToggle,
  ariaLabel,
  toggleHint,
  renderTrailing,
  renderBelow,
}: ActionChecklistProps) {
  return (
    <div className="flex flex-col gap-0.5" role="group" aria-label={ariaLabel}>
      {items.map((item) => {
        const taken = item.taken === true;
        const checked = selected.has(item.key);
        // req 44 — the record only shows while the row is NOT ticked now: a
        // fresh tick is the louder of the two states and says the same thing.
        const record = !checked && item.takenChecked === true;
        const below = renderBelow?.(item);
        return (
          <div
            key={item.key}
            // The tint is on the wrapper, not the label, so anything rendered
            // under the row sits inside the row rather than beside it.
            className={`rounded-md transition-colors ${
              checked ? "bg-(--color-accent-subtle)" : "hover:bg-(--color-bg-hover)"
            }`}
          >
          <div className="flex items-start">
          <label
            title={toggleHint}
            // `relative` contains the `sr-only` box below, which is absolutely
            // positioned: with no containing block in the row it lands far down
            // the page, and focusing it on click scrolls the chat column out of
            // the window (planning#592).
            //
            // It wraps the box ALONE, not the row's text. The text is markdown
            // (req 41), and the links ShipIt renders for a repo file and for a
            // ShipIt pointer are anchors with NO href, which the HTML spec does
            // not count as interactive content — so a label around them
            // forwards the click to its checkbox and opening a file would tick
            // the row. Measured in Chromium, where `role`/`tabindex` do not
            // help; jsdom disagrees, so no test here can see it. The text keeps
            // its own click handler below, so ticking by clicking the words
            // survives.
            className="relative flex shrink-0 items-start pl-2 pr-2.5 py-1.5 cursor-pointer"
          >
            <input
              type="checkbox"
              className="sr-only"
              checked={checked}
              // The record is not the input's state — the input is the
              // selection, and a tick drawn over an unchecked box would
              // otherwise reach assistive technology as nothing at all.
              aria-label={`${toggleHint ? `${toggleHint}: ` : ""}${item.label}${
                record ? " (sent as ticked)" : ""
              }`}
              onChange={() => onToggle(item.key)}
            />
            <span
              aria-hidden="true"
              className={`shrink-0 mt-px inline-flex items-center justify-center w-4 h-4 rounded border transition-colors ${
                checked
                  ? "bg-(--color-accent) border-(--color-accent) text-(--color-accent-text)"
                  : record
                    ? "bg-(--color-bg-tertiary) border-(--color-border-secondary) text-(--color-text-tertiary)"
                    // An empty box needs a surface of its own: on the status card's
                    // accent-tinted body, a borderline alone all but disappears.
                    : "bg-(--color-bg-primary) border-(--color-border-secondary) text-transparent"
              }`}
            >
              <CheckIcon size={ICON_SIZE.XS} weight="bold" />
            </span>
          </label>
            <span
              title={toggleHint}
              onClick={(e) => {
                // Anything the user can operate keeps its own click: a link, the
                // issue badge a reference renders as, a trailing control.
                if ((e.target as HTMLElement).closest(INTERACTIVE)) return;
                onToggle(item.key);
              }}
              className="min-w-0 flex-1 py-1.5 pr-2 cursor-pointer"
            >
              <InlineMarkdown
                text={item.label}
                shipitLinks
                className={`font-medium ${taken ? "text-(--color-text-tertiary)" : "text-(--color-text-primary)"}`}
              />
              {item.defaultChecked && !taken && (
                <span className="ml-1.5 align-middle text-[10px] font-semibold tracking-wide text-(--color-text-link) bg-(--color-accent-subtle) rounded-full px-1.5 py-px">
                  RECOMMENDED
                </span>
              )}
              {/* Shown on a taken row too: a row already sent that now carries
                  a NEW answer is pending, and SENT alone would deny it. */}
              {item.tag && (
                <span className="ml-1.5 align-middle text-[10px] font-semibold tracking-wide text-(--color-text-link) bg-(--color-accent-subtle) rounded-full px-1.5 py-px">
                  {item.tag}
                </span>
              )}
              {/* Grey alone does not say why a row is grey (docs/303 req 17). */}
              {taken && (
                <span className="ml-1.5 align-middle text-[10px] font-semibold tracking-wide text-(--color-text-tertiary) bg-(--color-bg-tertiary) rounded-full px-1.5 py-px">
                  SENT
                </span>
              )}
              {item.description && (
                <InlineMarkdown
                  text={item.description}
                  shipitLinks
                  className={`block mt-0.5 ${taken ? "text-(--color-text-tertiary)" : "text-(--color-text-secondary)"}`}
                />
              )}
            </span>
            {renderTrailing?.(item)}
          </div>
          {/* Aligned under the label's text: px-2 + the 16px box + the 10px gap. */}
          {below && <div className="pl-[34px] pr-2 pb-1.5">{below}</div>}
          </div>
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
