/**
 * PrLifecycleCard — sticky top chrome for the chat panel.
 *
 * Single-line design for each PR phase: ready, creating, open, merged, error.
 * Updates in place when the store state changes. Always renders (even pre-PR
 * or for sessions without a PR card) so the right cluster — search icon and
 * the overflow menu housing conversation- and PR-level preferences — has a
 * stable home. See docs/156.
 */

import { useState, useCallback, useMemo } from "react";
import { usePrStore } from "../../stores/pr-store.js";
import { collectPrCardIssueRefs } from "../../utils/pr-card-issue-refs.js";
import { useSessionStore } from "../../stores/session-store.js";
import { useIsMobile } from "../../hooks/useMediaQuery.js";
import { PrActionsMenu } from "../PrActionsMenu.js";
import { ChangedDocsStrip } from "../ChangedDocsStrip.js";
import {
  getSavedChangedDocsExpanded,
  saveChangedDocsExpanded,
} from "../../utils/local-storage.js";
import {
  MagnifyingGlassIcon,
  FilesIcon,
  CaretDownIcon,
} from "@phosphor-icons/react";
import { ICON_SIZE } from "../../design-tokens.js";
import { isDefaultBranch } from "./shared.js";
import { ReadyPhase, OpenPhase, TerminalPhase, ErrorPhase } from "./phases/index.js";

// ---- Changed-docs toggle (docs/205) ----

/**
 * Two-document toggle in the header's action cluster, left of the ⋯ menu. Its
 * presence is the signal that the PR touched a notable file, so there's no
 * count badge. Collapsed → icon only, caret points up, header height unchanged.
 * Expanded → icon turns active (purple), caret flips down toward the panel that
 * drops in below.
 */
function ChangedDocsToggle({ expanded, onToggle }: { expanded: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={expanded}
      aria-label="Related issues and changed docs in this PR"
      title="Related issues and changed docs in this PR"
      className={`flex items-center gap-0.5 px-1.5 py-1 rounded border transition-colors cursor-pointer ${
        expanded
          ? "text-(--color-pr) bg-(--color-pr-subtle) border-(--color-pr-border)"
          : "text-(--color-text-tertiary) border-transparent hover:text-(--color-text-secondary) hover:bg-(--color-bg-hover)"
      }`}
    >
      <FilesIcon size={ICON_SIZE.SM} />
      <CaretDownIcon
        size={ICON_SIZE.XS}
        className={`transition-transform ${expanded ? "" : "rotate-180"}`}
      />
    </button>
  );
}

// ---- Main component ----

export interface PrLifecycleCardProps {
  sessionId: string;
  onOpenDetails?: () => void;
  /** Ask the agent to create a PR. The agent has context the orchestrator doesn't, so it can pick a good title and write a proper Summary/Changes/Test plan body. */
  onCreatePr?: () => void;
  /** Whether the session has a GitHub remote — gates the Auto-fix / Auto-merge overflow toggles. */
  canAutoMerge?: boolean;
  /** Opens the conversation search bar. */
  onSearch?: () => void;
}

export function PrLifecycleCard({
  sessionId,
  onOpenDetails,
  onCreatePr,
  canAutoMerge,
  onSearch,
}: PrLifecycleCardProps) {
  const card = usePrStore((s) => s.cardBySession[sessionId]);

  // docs/205 — the changed-docs strip. The toggle is hidden entirely when the
  // PR changed no notable file (its presence is the signal). Collapse state is
  // pure view state, per session in localStorage, defaulting to collapsed.
  const notableFiles = card?.notableFiles ?? [];

  // docs/206 — related-issue chips, computed purely from data already on the
  // client: the PR body (poller `prBody`, falling back to the lifecycle card's
  // `pr.body`) for Closes/Refs, and the session's first user message for the
  // issue it was started from. No server round-trip.
  const prBody = usePrStore((s) => s.statusBySession[sessionId]?.prBody) ?? card?.pr?.body;
  const firstUserText = useSessionStore((s) => s.messages.find((m) => m.role === "user")?.text);
  const issueRefs = useMemo(
    () => collectPrCardIssueRefs({ prBody, firstUserMessage: firstUserText }),
    [prBody, firstUserText],
  );

  // The panel (and its header toggle) appears when there's anything to show in
  // it — related issues OR notable files. An issues-only PR still gets a toggle.
  const hasPanelContent = notableFiles.length > 0 || issueRefs.length > 0;
  // Collapse state is per-session view state in localStorage. A session with no
  // stored preference defaults to expanded on desktop (roomy) and collapsed on
  // mobile (where header height is precious); a stored preference always wins.
  // We adjust state during render when `sessionId` changes (re-reading the saved
  // value) rather than reaching for useEffect — the React-endorsed "store info
  // from previous render" pattern, so a session switch restores that session's
  // own expanded/collapsed preference without an effect.
  const defaultExpanded = !useIsMobile();
  const [docsState, setDocsState] = useState(() => ({
    sessionId,
    expanded: getSavedChangedDocsExpanded(sessionId, defaultExpanded),
  }));
  let docsExpanded = docsState.expanded;
  if (docsState.sessionId !== sessionId) {
    docsExpanded = getSavedChangedDocsExpanded(sessionId, defaultExpanded);
    setDocsState({ sessionId, expanded: docsExpanded });
  }
  const toggleDocs = useCallback(() => {
    setDocsState((prev) => {
      const base =
        prev.sessionId === sessionId
          ? prev.expanded
          : getSavedChangedDocsExpanded(sessionId, defaultExpanded);
      const next = !base;
      saveChangedDocsExpanded(sessionId, next);
      return { sessionId, expanded: next };
    });
  }, [sessionId, defaultExpanded]);

  // The whole card body opens the PR detail tab, but only once a PR exists
  // (open/merged/closed) — the ready/creating/error phases have no PR to
  // drill into. Clicks that originate on an interactive control (button, link,
  // input) are ignored via the closest() guard, so toggling auto-fix, merging,
  // or copying the branch never also switches the tab — no per-control
  // stopPropagation needed. See docs/133.
  const hasPr = !!card?.pr && (card.phase === "open" || card.phase === "merged" || card.phase === "closed");
  const clickable = hasPr && !!onOpenDetails;

  const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!clickable) return;
    if ((e.target as HTMLElement).closest("button, a, input, textarea")) return;
    onOpenDetails?.();
  };

  // Key the inner subtree on sessionId so transient per-session UI state
  // (e.g. MergeButton's "Merging..." flag, CreatePR's "Creating..." flag,
  // OpenPhase's "Fixing..." flag) resets when the user switches sessions.
  // Without this, switching sessions while a merge is in flight leaves the
  // button stuck on "Merging..." against the new session.
  const phaseContent = card ? (
    <>
      {(card.phase === "ready" || card.phase === "creating") && <ReadyPhase card={card} sessionId={sessionId} creating={card.phase === "creating"} onCreatePr={onCreatePr} />}
      {card.phase === "open" && <OpenPhase card={card} sessionId={sessionId} canAutoMerge={canAutoMerge} />}
      {card.phase === "merged" && (
        <TerminalPhase card={card} sessionId={sessionId}
          text={`Merged: ${card.pr?.title ?? `PR #${card.pr?.number}`}${card.pr?.baseBranch && !isDefaultBranch(card.pr.baseBranch) ? ` into ${card.pr.baseBranch}` : ""}`}
        />
      )}
      {card.phase === "closed" && (
        <TerminalPhase card={card} sessionId={sessionId} text={`PR #${card.pr?.number} closed`} />
      )}
      {card.phase === "error" && <ErrorPhase card={card} sessionId={sessionId} onCreatePr={onCreatePr} />}
    </>
  ) : (
    // No PR card yet — leave the left side empty so the right cluster (search
    // + overflow) anchors the bar. Keeps session-management actions reachable
    // pre-PR without re-introducing a separate top bar.
    <div className="min-w-0 flex-1" />
  );

  return (
    <>
      <div
        key={sessionId}
        onClick={handleClick}
        aria-label={clickable ? "Open PR details" : undefined}
        className={`shrink-0 flex items-start gap-2 px-3 sm:px-4 py-2 border-b border-(--color-border-primary) ${clickable ? "cursor-pointer hover:bg-(--color-bg-hover)/40 transition-colors" : ""}`}
      >
        <div className="min-w-0 flex-1 flex items-center">
          {phaseContent}
        </div>
        <div className="shrink-0 h-6 flex items-center gap-1">
          {onSearch && (
            <button
              onClick={onSearch}
              className="p-1 rounded text-(--color-text-tertiary) hover:text-(--color-text-primary) hover:bg-(--color-bg-hover) transition-colors"
              title="Search conversation"
              aria-label="Search conversation"
            >
              <MagnifyingGlassIcon size={ICON_SIZE.SM} weight="bold" />
            </button>
          )}
          {hasPanelContent && <ChangedDocsToggle expanded={docsExpanded} onToggle={toggleDocs} />}
          <PrActionsMenu sessionId={sessionId} />
        </div>
      </div>
      {hasPanelContent && docsExpanded && (
        <ChangedDocsStrip sessionId={sessionId} notableFiles={notableFiles} issueRefs={issueRefs} />
      )}
    </>
  );
}
