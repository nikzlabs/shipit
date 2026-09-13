// eslint-disable-next-line no-restricted-imports -- effect subscribes to browser selection and focus
import { useCallback, useEffect, useMemo, useState, type RefObject } from "react";
import {
  compactRuns, elementMessageIndex, isCompactDetail, shouldCollapseRowTools,
  type CompactRun, type NeedsUser,
} from "../compact-turns.js";
import type { ChatMessage } from "../types.js";
import type { VisualElement } from "../../visual-elements.js";
import type { SearchMatch } from "../../../hooks/useSearch.js";
import { useBugReportStore } from "../../../stores/bug-report-store.js";
import { usePermissionStore } from "../../../stores/permission-store.js";
import { useEgressPromptStore } from "../../../stores/egress-prompt-store.js";

type CompactRowView =
  | { hidden: boolean; collapseTools: boolean; run?: undefined; first?: undefined; open?: undefined; search?: undefined; controls?: undefined }
  | { hidden: boolean; collapseTools: boolean; run: CompactRun; first: boolean; open: boolean; search: boolean; controls?: string };

/**
 * docs/299 req 12 — the cards a collapsed turn keeps, each reading the state
 * that decides it. Nothing here is a judgement about importance: a card is kept
 * while the product is waiting on a person, and hides once they have acted.
 *
 * The three card stores are authoritative over the persisted row — they are
 * re-seeded from history on every load (`session-data.ts`), and a live update
 * lands there rather than on the message.
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
    if (m.releaseCard) return m.releaseCard.phase === "proposed";
    if (m.actionChecklist) return !m.actionChecklist.submittedAt;
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
   * opens it, and nothing but the user's own button closes it again.
   *
   * The shipped guard also closed a turn the moment focus or the selection left
   * it, synchronously. A press inside the transcript collapses the selection and
   * moves focus on `mousedown`, so rows hid and the list shrank between
   * `mousedown` and `mouseup`: no `click` ever reached the control the user was
   * pressing, and the reading anchor re-anchored the scroll underneath them.
   * Requirement 1's automatic collapse still governs a turn nobody has touched;
   * a turn the user has touched is theirs until they say otherwise.
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
    for (const el of elements) {
      const index = elementMessageIndex(el);
      const run = byIndex.get(index);
      if (!run) continue;
      if (isCompactDetail(el, messages, run, needsUser)) {
        withDetails.add(run);
        detail.add(el);
        protectableIndices.add(index);
      } else if (shouldCollapseRowTools(el, messages[index])) {
        withDetails.add(run);
        collapsedTools.add(el);
        protectableIndices.add(index);
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
    const seen = new Set<CompactRun>();
    return elements.map((el) => {
      const run = byIndex.get(elementMessageIndex(el));
      if (!run || !withDetails.has(run)) return { hidden: false, collapseTools: false };
      const search = searchRuns.has(run);
      const protectedRun = protectedRuns.has(run);
      const open = expanded.has(run.identity) || search || protectedRun;
      const first = !seen.has(run);
      seen.add(run);
      return {
        hidden: !open && detail.has(el),
        collapseTools: !open && collapsedTools.has(el),
        run, first, open, search,
        controls: first ? controls.get(run)?.join(" ") : undefined,
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
