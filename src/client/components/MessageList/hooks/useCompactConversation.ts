// eslint-disable-next-line no-restricted-imports -- effect subscribes to browser selection and focus
import { useEffect, useMemo, useState, type RefObject } from "react";
import { compactRuns, elementMessageIndex, isCompactDetail, type CompactRun } from "../compact-turns.js";
import type { ChatMessage } from "../types.js";
import type { VisualElement } from "../../visual-elements.js";
import type { SearchMatch } from "../../../hooks/useSearch.js";

type CompactRowView =
  | { hidden: boolean; run?: undefined; first?: undefined; open?: undefined; search?: undefined; controls?: undefined }
  | { hidden: boolean; run: CompactRun; first: boolean; open: boolean; search: boolean; controls?: string };

export function useCompactConversation(
  messages: ChatMessage[], isLoading: boolean, sessionId: string | undefined,
  enabled: boolean, elements: VisualElement[], matches: Map<number, SearchMatch[]>,
  containerRef: RefObject<HTMLDivElement | null>,
) {
  // Mounting during a turn: its start is unknown, so keep that history full until idle.
  // Live appends do not mark every row inProgress (agent-event.ts), hence the boundary.
  const [expanded, setExpanded] = useState<Set<ChatMessage>>(() => new Set());
  const [observed, setObserved] = useState({ sessionId, loading: isLoading, count: messages.length, activeFrom: isLoading ? 0 : Infinity });
  let activeFrom = observed.activeFrom;
  if (observed.sessionId !== sessionId || messages.length < observed.count) activeFrom = isLoading ? 0 : Infinity;
  else if (!isLoading) activeFrom = Infinity;
  else if (!observed.loading) activeFrom = observed.count;
  if (observed.sessionId !== sessionId || observed.loading !== isLoading || observed.count !== messages.length) {
    if (observed.sessionId !== sessionId || messages.length < observed.count) setExpanded(new Set());
    setObserved({ sessionId, loading: isLoading, count: messages.length, activeFrom });
  }
  const [protectedIndices, setProtectedIndices] = useState<number[]>([]);
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
          // Typical drag: work is bounded to the selected range, not the whole history.
          for (let i = Math.min(a, b); i <= Math.max(a, b); i++) indices.add(i);
        } else {
          // A selection crossing the transcript boundary needs the full intersection check.
          root.querySelectorAll<HTMLElement>("[data-compact-index]").forEach((row) => {
            if (selection.rangeCount > 0 && selection.getRangeAt(0).intersectsNode(row)) indices.add(Number(row.dataset.compactIndex));
          });
        }
      }
      const next = [...indices];
      setProtectedIndices((prev) => prev.join() === next.join() ? prev : next);
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

  const runs = useMemo(() => enabled ? compactRuns(messages, activeFrom) : [], [messages, activeFrom, enabled]);
  const rows = useMemo<CompactRowView[]>(() => {
    if (!enabled) return elements.map(() => ({ hidden: false }));
    const byIndex = new Map<number, (typeof runs)[number]>();
    for (const run of runs) for (let i = run.start; i < run.end; i++) byIndex.set(i, run);
    const withDetails = new Set<CompactRun>();
    const detail = new Set<VisualElement>();
    const detailIndices = new Set<number>();
    for (const el of elements) {
      const run = byIndex.get(elementMessageIndex(el));
      if (run && isCompactDetail(el, messages, run)) {
        withDetails.add(run);
        detail.add(el);
        detailIndices.add(elementMessageIndex(el));
      }
    }
    const controls = new Map<(typeof runs)[number], string[]>();
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
      if (run && detailIndices.has(index)) protectedRuns.add(run);
    }
    const seen = new Set<CompactRun>();
    return elements.map((el) => {
      const run = byIndex.get(elementMessageIndex(el));
      if (!run || !withDetails.has(run)) return { hidden: false };
      const search = searchRuns.has(run);
      const protectedRun = protectedRuns.has(run);
      const open = expanded.has(run.identity) || search || protectedRun;
      const first = !seen.has(run);
      seen.add(run);
      return { hidden: !open && detail.has(el), run, first, open, search, controls: first ? controls.get(run)?.join(" ") : undefined };
    });
  }, [runs, messages, elements, enabled, matches, expanded, protectedIndices]);

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
