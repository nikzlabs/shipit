// eslint-disable-next-line no-restricted-imports -- effect subscribes to browser selection and focus
import { useCallback, useEffect, useMemo, useState, type RefObject } from "react";
import {
  compactRuns, countHidden, describeHidden, elementMessageIndex, isCompactDetail,
  rowToolCount, shouldCollapseRowTools, type CompactRun, type HiddenCounts, type NeedsUser,
} from "../compact-turns.js";
import type { ChatMessage } from "../types.js";
import type { VisualElement } from "../../visual-elements.js";
import type { SearchMatch } from "../../../hooks/useSearch.js";
import { useBugReportStore } from "../../../stores/bug-report-store.js";
import { usePermissionStore } from "../../../stores/permission-store.js";
import { useEgressPromptStore } from "../../../stores/egress-prompt-store.js";

/**
 * The control this row draws, on the rewind strip that CLOSES a collapsed turn
 * (req 14). The row is the next user message's — the turn it toggles is the one
 * above it, so every field here describes that turn, not this row.
 */
export interface ClosingControl {
  run: CompactRun;
  open: boolean;
  search: boolean;
  controls?: string;
  /** What the fold is holding, for the tooltip: "2 tool calls · 1 card". */
  holds?: string;
}

type CompactRowView =
  | { hidden: boolean; collapseTools: boolean; closes?: ClosingControl; empty?: undefined; run?: undefined; first?: undefined; open?: undefined; search?: undefined }
  | { hidden: boolean; collapseTools: boolean; closes?: ClosingControl; empty: boolean; run: CompactRun; first: boolean; open: boolean; search: boolean };

/**
 * docs/299 req 12 — a card is kept while the product is waiting on a person,
 * and hides once they have acted. An action card is NOT decided here: it is
 * kept unconditionally in `isCompactDetail`. The three stores outrank the
 * persisted row:
 * they are re-seeded from history on every load (`session-data.ts`), and a live
 * update lands there rather than on the message.
 */
function useNeedsUser(): NeedsUser {
  const bugReports = useBugReportStore((s) => s.cards);
  const permissions = usePermissionStore((s) => s.cards);
  const egress = useEgressPromptStore((s) => s.cards);
  return useCallback((m: ChatMessage) => {
    if (m.bugReport) {
      const phase = bugReports[m.bugReport.cardId]?.phase ?? m.bugReport.phase;
      return phase === "draft" || phase === "failed";
    }
    if (m.permissionPrompt) {
      const phase = permissions[m.permissionPrompt.requestId]?.phase ?? m.permissionPrompt.phase;
      return phase === "pending";
    }
    if (m.egressPrompt) {
      const phase = egress[m.egressPrompt.cardId]?.phase ?? m.egressPrompt.phase;
      return phase === "pending";
    }
    if (m.settingsProposal) return m.settingsProposal.phase === "pending";
    if (m.releaseCard) return m.releaseCard.phase === "proposed";
    return false;
  }, [bugReports, permissions, egress]);
}

export function useCompactConversation(
  messages: ChatMessage[], sessionId: string | undefined,
  enabled: boolean, elements: VisualElement[], matches: Map<number, SearchMatch[]>,
  containerRef: RefObject<HTMLDivElement | null>,
) {
  const [expanded, setExpanded] = useState<Set<ChatMessage>>(() => new Set());
  const [protectedIndices, setProtectedIndices] = useState<number[]>([]);
  const [observed, setObserved] = useState({ sessionId, count: messages.length });
  if (observed.sessionId !== sessionId || observed.count !== messages.length) {
    if (observed.sessionId !== sessionId || messages.length < observed.count) {
      setExpanded(new Set());
      setProtectedIndices([]);
    }
    setObserved({ sessionId, count: messages.length });
  }

  /**
   * planning#540 — protection is ONE-WAY: focus or a selection entering a turn
   * opens it, and nothing but the user's own button closes it again. Closing it
   * on focus/selection LEAVING, as the shipped guard did, hid rows between
   * `mousedown` and `mouseup` — so the click never reached what was pressed and
   * the scroll re-anchored under the user.
   */
  // eslint-disable-next-line no-restricted-syntax -- subscribe to browser focus/selection, not derived application state
  useEffect(() => {
    const root = containerRef.current;
    if (!root || !enabled) return;
    const update = () => {
      const indices = new Set<number>();
      const indexOf = (node: Node | null) => {
        const el = node instanceof Element ? node : node?.parentElement;
        const row = el?.closest<HTMLElement>("[data-compact-index]");
        return row && root.contains(row) ? Number(row.dataset.compactIndex) : undefined;
      };
      const focused = indexOf(document.activeElement);
      if (focused !== undefined) indices.add(focused);
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed) {
        const a = indexOf(selection.anchorNode);
        const b = indexOf(selection.focusNode);
        if (a !== undefined && b !== undefined) {

          for (let i = Math.min(a, b); i <= Math.max(a, b); i++) indices.add(i);
        } else {

          root.querySelectorAll<HTMLElement>("[data-compact-index]").forEach((row) => {
            if (selection.rangeCount > 0 && selection.getRangeAt(0).intersectsNode(row)) indices.add(Number(row.dataset.compactIndex));
          });
        }
      }
      if (indices.size === 0) return;
      setProtectedIndices((prev) => {
        const next = prev.slice();
        for (const index of indices) if (!next.includes(index)) next.push(index);
        return next.length === prev.length ? prev : next;
      });
    };
    update();
    document.addEventListener("selectionchange", update);
    document.addEventListener("focusin", update);
    document.addEventListener("focusout", update);
    return () => {
      document.removeEventListener("selectionchange", update);
      document.removeEventListener("focusin", update);
      document.removeEventListener("focusout", update);
    };
  }, [containerRef, enabled]);

  const needsUser = useNeedsUser();
  const runs = useMemo(() => enabled ? compactRuns(messages) : [], [messages, enabled]);
  const rows = useMemo<CompactRowView[]>(() => {
    if (!enabled) return elements.map(() => ({ hidden: false, collapseTools: false }));
    const byIndex = new Map<number, CompactRun>();
    for (const run of runs) for (let i = run.start; i < run.end; i++) byIndex.set(i, run);
    const withDetails = new Set<CompactRun>();
    const detail = new Set<VisualElement>();
    const collapsedTools = new Set<VisualElement>();
    // Only a row that HAS something hidden can be worth protecting; a kept reply
    // must not expand its own turn just because the user selected a word in it.
    const protectableIndices = new Set<number>();
    // A turn that keeps nothing at all: its collapsed form is the button alone,
    // which is the only case worth labelling. An error row or a pending card is
    // its own explanation and needs no note beside it.
    const showsSomething = new Set<CompactRun>();
    // What the fold rule says it is holding (req 8), tallied where the same pass
    // decides what goes: a count taken anywhere else could disagree with it.
    const held = new Map<CompactRun, HiddenCounts>();
    const tally = (run: CompactRun): HiddenCounts => {
      const counts = held.get(run) ?? { tools: 0, messages: 0, cards: 0 };
      held.set(run, counts);
      return counts;
    };
    for (const el of elements) {
      const index = elementMessageIndex(el);
      const run = byIndex.get(index);
      if (!run) continue;
      if (isCompactDetail(el, messages, run, needsUser)) {
        withDetails.add(run);
        detail.add(el);
        protectableIndices.add(index);
        countHidden(el, messages[index], tally(run));
      } else if (shouldCollapseRowTools(el, messages[index])) {
        showsSomething.add(run);
        withDetails.add(run);
        collapsedTools.add(el);
        protectableIndices.add(index);
        tally(run).tools += rowToolCount(el, messages[index]);
      } else {
        showsSomething.add(run);
      }
    }
    const controls = new Map<CompactRun, string[]>();
    elements.forEach((el, index) => {
      const run = byIndex.get(elementMessageIndex(el));
      if (run) {
        const ids = controls.get(run) ?? [];
        ids.push(`compact-row-${index}`);
        controls.set(run, ids);
      }
    });
    const searchRuns = new Set<CompactRun>();
    for (const index of matches.keys()) {
      const run = byIndex.get(index);
      if (run) searchRuns.add(run);
    }
    const protectedRuns = new Set<CompactRun>();
    for (const index of protectedIndices) {
      const run = byIndex.get(index);
      if (run && protectableIndices.has(index)) protectedRuns.add(run);
    }
    const isOpen = (run: CompactRun): boolean =>
      expanded.has(run.identity) || searchRuns.has(run) || protectedRuns.has(run);
    // req 14 — the control rides the strip that closes the turn, which belongs
    // to the row AFTER the run: the user message that ended it.
    const closingIndex = new Map<number, CompactRun>();
    for (const run of runs) if (withDetails.has(run)) closingIndex.set(run.end, run);

    const seen = new Set<CompactRun>();
    return elements.map((el) => {
      const closesRun = el.kind === "message" ? closingIndex.get(el.index) : undefined;
      const closes: ClosingControl | undefined = closesRun && {
        run: closesRun,
        open: isOpen(closesRun),
        search: searchRuns.has(closesRun),
        controls: controls.get(closesRun)?.join(" "),
        holds: describeHidden(held.get(closesRun) ?? { tools: 0, messages: 0, cards: 0 }),
      };
      const run = byIndex.get(elementMessageIndex(el));
      if (!run || !withDetails.has(run)) return { hidden: false, collapseTools: false, closes };
      const search = searchRuns.has(run);
      const open = isOpen(run);
      const first = !seen.has(run);
      seen.add(run);
      return {
        hidden: !open && detail.has(el),
        collapseTools: !open && collapsedTools.has(el),
        empty: !showsSomething.has(run),
        run, first, open, search, closes,
      };
    });
  }, [runs, messages, elements, enabled, matches, expanded, protectedIndices, needsUser]);

  const toggle = (run: CompactRun, open: boolean) => {
    if (open) {
      const selection = window.getSelection();
      const root = containerRef.current;
      if (selection && !selection.isCollapsed && root) {
        const intersects = [...root.querySelectorAll<HTMLElement>("[data-compact-index]")].some((row) => {
          const index = Number(row.dataset.compactIndex);
          return index >= run.start && index < run.end && selection.rangeCount > 0 && selection.getRangeAt(0).intersectsNode(row);
        });
        if (intersects) selection.removeAllRanges();
      }
      setProtectedIndices((prev) => prev.filter((index) => index < run.start || index >= run.end));
    }
    setExpanded((prev) => {
      const next = new Set(prev);
      if (open) next.delete(run.identity); else next.add(run.identity);
      return next;
    });
  };
  return { rows, toggle };
}
