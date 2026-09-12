

import { useState, useCallback, useMemo } from "react";
import { usePrStore } from "../../stores/pr-store.js";
import { collectPrCardIssueRefs } from "../../utils/pr-card-issue-refs.js";
import { useSessionStore } from "../../stores/session-store.js";
import { useIssuesStore } from "../../stores/issues-store.js";
import { useIsMobile } from "../../hooks/useMediaQuery.js";
import { PrActionsMenu } from "../PrActionsMenu.js";
import { Button } from "../ui/button.js";
import { ChangedDocsStrip } from "../ChangedDocsStrip.js";
import { PrMergeActions, PrStatusActions } from "./PrStatusActions.js";
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
import { useSessionDefaultBranch } from "../../utils/default-branch.js";
import { ReadyPhase, OpenPhase, TerminalPhase, ErrorPhase } from "./phases/index.js";
import type { NotableFileChange } from "../../../server/shared/types/github-types.js";

const EMPTY_NOTABLE_FILES: NotableFileChange[] = [];

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

export interface PrLifecycleCardProps {
  sessionId: string;
  onOpenDetails?: () => void;

  onCreatePr?: () => void;

  canAutoMerge?: boolean;

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

  const storedNotableFiles = usePrStore((s) => s.notableFilesBySession[sessionId]);
  const notableFiles = card ? (storedNotableFiles ?? EMPTY_NOTABLE_FILES) : EMPTY_NOTABLE_FILES;

  const repoDefaultBranch = useSessionDefaultBranch(sessionId);
  const prBody = usePrStore((s) => s.statusBySession[sessionId]?.prBody) ?? card?.pr?.body;
  const firstUserText = useSessionStore((s) => s.messages.find((m) => m.role === "user")?.text);

  const trackers = useIssuesStore((s) => s.trackers);
  const issueRefs = useMemo(
    () =>
      collectPrCardIssueRefs({
        prBody,
        firstUserMessage: firstUserText,
        destinations: trackers.map((t) => ({
          id: t.id,
          kind: t.kind,
          ...(t.name ? { name: t.name } : {}),
          ...(t.binding?.key ? { key: t.binding.key } : {}),
        })),
      }),
    [prBody, firstUserText, trackers],
  );

  const hasPanelContent = notableFiles.length > 0 || issueRefs.length > 0;

  const isMobile = useIsMobile();
  const defaultExpanded = !isMobile;
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

  // or copying the branch never also switches the tab — no per-control

  // `[role="menu"]` is in the guard because the PR actions overflow menu is

  // user could confirm, so the PR never closed.
  const hasPr = !!card?.pr && (card.phase === "open" || card.phase === "merged" || card.phase === "closed");
  const clickable = hasPr && !!onOpenDetails;

  const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!clickable) return;
    if ((e.target as HTMLElement).closest('button, a, input, textarea, [role="menu"], [role="menuitem"]')) return;
    onOpenDetails?.();
  };

  const stripShown = hasPanelContent && docsExpanded;

  const actionsRowShown = isMobile && card?.phase === "open" && !!card.pr;

  // The mobile actions row below is keyed on sessionId too, and must keep being:

  // The two keys MUST stay namespaced apart (`header:`/`actions:`), never the

  const phaseContent = card ? (
    <>
      {(card.phase === "ready" || card.phase === "creating") && <ReadyPhase card={card} sessionId={sessionId} creating={card.phase === "creating"} onCreatePr={onCreatePr} />}
      {card.phase === "open" && <OpenPhase card={card} sessionId={sessionId} canAutoMerge={canAutoMerge} />}
      {card.phase === "merged" && (
        <TerminalPhase card={card} sessionId={sessionId}
          text={`Merged: ${card.pr?.title ?? `PR #${card.pr?.number}`}${card.pr?.baseBranch && !isDefaultBranch(card.pr.baseBranch, repoDefaultBranch) ? ` into ${card.pr.baseBranch}` : ""}`}
        />
      )}
      {card.phase === "closed" && (
        <TerminalPhase card={card} sessionId={sessionId} text={`PR #${card.pr?.number} closed`} />
      )}
      {card.phase === "error" && <ErrorPhase card={card} sessionId={sessionId} onCreatePr={onCreatePr} />}
    </>
  ) : (

    <div className="min-w-0 flex-1" />
  );

  return (
    <>
      <div
        key={`header:${sessionId}`}
        onClick={handleClick}
        aria-label={clickable ? "Open PR details" : undefined}
        className={`shrink-0 flex items-start gap-2 px-3 sm:px-4 pt-2 ${actionsRowShown ? "pb-1" : "pb-2"} ${stripShown || actionsRowShown ? "" : "border-b border-(--color-border-primary)"} ${clickable ? "cursor-pointer hover:bg-(--color-bg-hover)/40 transition-colors" : ""}`}
      >
        <div className="min-w-0 flex-1 flex items-center">
          {phaseContent}
        </div>
        <div className="shrink-0 h-6 flex items-center gap-1">
          {onSearch && (
            <Button
              variant="ghost"
              size="icon"
              onClick={onSearch}
              title="Search conversation"
              aria-label="Search conversation"
            >
              <MagnifyingGlassIcon size={ICON_SIZE.SM} weight="bold" />
            </Button>
          )}
          {hasPanelContent && <ChangedDocsToggle expanded={docsExpanded} onToggle={toggleDocs} />}
          <PrActionsMenu sessionId={sessionId} />
        </div>
      </div>
      {actionsRowShown && card && (

        <div
          key={`actions:${sessionId}`}
          className={`shrink-0 flex flex-wrap items-center gap-x-3 gap-y-1 pl-11 sm:pl-12 pr-3 sm:pr-4 pb-2 ${stripShown ? "" : "border-b border-(--color-border-primary)"}`}
        >
          <PrStatusActions card={card} sessionId={sessionId} />
          {/* `basis-full` inside this wrapping row keeps the merge controls on a
              line of their own, below the chips. */}
          <PrMergeActions card={card} sessionId={sessionId} canAutoMerge={canAutoMerge} />
        </div>
      )}
      {hasPanelContent && docsExpanded && (
        <ChangedDocsStrip sessionId={sessionId} notableFiles={notableFiles} issueRefs={issueRefs} />
      )}
    </>
  );
}
