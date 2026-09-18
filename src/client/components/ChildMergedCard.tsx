import { ArrowSquareOutIcon, GitBranchIcon, GitCommitIcon, GitMergeIcon, GitPullRequestIcon, WarningIcon, XCircleIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import { Button } from "./ui/button.js";
import { useSessionStore } from "../stores/session-store.js";

export interface ChildMergedCardProps {
  childSessionId: string;
  childTitle: string;
  branch?: string;
  outcome: "merged" | "closed-unmerged";
  prNumber: number;
  prUrl: string;
  prTitle?: string;
  mergeSha?: string;
  deliveryFailure?: { attempts: number; error?: string };
  onOpen?: (childSessionId: string) => void;
}

export function ChildMergedCard({
  childSessionId,
  childTitle,
  branch,
  outcome,
  prNumber,
  prUrl,
  prTitle,
  mergeSha,
  deliveryFailure,
  onOpen,
}: ChildMergedCardProps) {
  const childRow = useSessionStore((s) => s.sessions.find((row) => row.id === childSessionId));
  const sessionMissing = !childRow;
  const failed = !!deliveryFailure;
  const merged = outcome === "merged" && !failed;

  const handleOpen = () => {
    if (sessionMissing) return;
    if (onOpen) {
      onOpen(childSessionId);
      return;
    }
    useSessionStore.getState().setSessionId(childSessionId);
  };

  return (
    <div
      data-testid="child-merged-card"
      data-outcome={outcome}
      {...(failed ? { "data-delivery-failed": "true" } : {})}
      className="rounded-lg border border-(--color-border-secondary) bg-(--color-bg-secondary) px-3 py-2.5 text-xs flex flex-col gap-2"
    >
      <div className="flex items-start gap-2">
        <span className={`shrink-0 mt-0.5 ${merged ? "text-(--color-success)" : "text-(--color-warning)"}`}>
          {failed ? (
            <WarningIcon size={ICON_SIZE.SM} weight="fill" />
          ) : merged ? (
            <GitMergeIcon size={ICON_SIZE.SM} weight="fill" />
          ) : (
            <XCircleIcon size={ICON_SIZE.SM} weight="fill" />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-(--color-text-tertiary) text-[10px] uppercase tracking-wide font-medium">
            {failed
              ? "Couldn't resume this session"
              : merged ? "Child PR merged" : "Child PR closed — not merged"}
          </div>
          <div className="text-(--color-text-primary) font-medium truncate" title={childTitle}>
            {childTitle}
          </div>
          {branch && (
            <div className="mt-1 flex items-center gap-1 text-(--color-text-tertiary) text-[11px]">
              <GitBranchIcon size={ICON_SIZE.XS} className="shrink-0" />
              <span className="truncate font-mono" title={branch}>{branch}</span>
            </div>
          )}
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={handleOpen}
          disabled={sessionMissing}
          className="shrink-0 gap-1"
          aria-label={`Open child session ${childTitle}`}
        >
          <ArrowSquareOutIcon size={ICON_SIZE.XS} />
          Open
        </Button>
      </div>

      <a
        href={prUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center gap-1.5 rounded border border-(--color-border-secondary) bg-(--color-bg-primary) px-2 py-1.5 text-[11px] text-(--color-text-secondary) hover:text-(--color-text-primary)"
        title={prTitle}
      >
        <GitPullRequestIcon size={ICON_SIZE.XS} className="shrink-0" />
        <span className="font-mono shrink-0">#{prNumber}</span>
        {prTitle && <span className="truncate">{prTitle}</span>}
      </a>

      {outcome === "merged" && mergeSha && (
        <div className="flex items-center gap-1.5 text-[11px] text-(--color-text-tertiary)">
          <GitCommitIcon size={ICON_SIZE.XS} className="shrink-0" />
          <span className="font-mono truncate" title={mergeSha}>{mergeSha.slice(0, 12)}</span>
        </div>
      )}

      {failed ? (
        <div className="flex flex-col gap-1 text-[11px] text-(--color-warning)">
          <span>
            {`This session could not be woken automatically after ${deliveryFailure.attempts} `
              + `attempt${deliveryFailure.attempts === 1 ? "" : "s"} — the agent did not start. `
              + "Send a message here to continue."}
          </span>
          {deliveryFailure.error && (
            <span className="font-mono text-(--color-text-tertiary) truncate" title={deliveryFailure.error}>
              {deliveryFailure.error}
            </span>
          )}
        </div>
      ) : (
        <div className="text-[11px] text-(--color-text-tertiary)">
          {merged
            ? "Proceeding here with the planned rebase / integration."
            : "This work did not ship — reassessing before proceeding."}
        </div>
      )}
    </div>
  );
}
