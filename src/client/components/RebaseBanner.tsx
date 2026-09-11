

import { useGitStore } from "../stores/git-store.js";
import { Spinner } from "./Spinner.js";
import { useSessionDefaultBranch, useSessionHasBaseBranch } from "../utils/default-branch.js";
import { Button } from "./ui/button.js";
import {
  ArrowsClockwiseIcon, WarningIcon,
  XCircleIcon,
  XIcon,
} from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";

export function RebaseBanner({ sessionId }: { sessionId: string }) {
  const rebaseStatus = useGitStore((s) => s.rebaseStatus);
  const rebaseConflicts = useGitStore((s) => s.rebaseConflicts);
  const rebaseError = useGitStore((s) => s.rebaseError);
  const setRebaseError = useGitStore((s) => s.setRebaseError);
  const pushRejected = useGitStore((s) => s.pushRejected);
  const startRebase = useGitStore((s) => s.startRebase);
  const abortRebase = useGitStore((s) => s.abortRebase);

  // The repo's real default branch — a `master` repo must not be told its
  // branch is behind "main" (and must not be rebased onto a ref that

  const baseBranch = useSessionDefaultBranch(sessionId);

  const hasBaseBranch = useSessionHasBaseBranch(sessionId);
  const showPushRejected = pushRejected && hasBaseBranch;

  if (rebaseError && rebaseStatus === "idle") {
    return (
      <div className="mx-4 last:mb-2">
        <div className="flex items-start gap-2 px-3 py-2 rounded-lg border border-(--color-border-secondary) bg-(--color-bg-secondary) text-xs">
          <XCircleIcon size={ICON_SIZE.SM} className="text-(--color-error) shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <div className="text-(--color-text-secondary)">Rebase failed</div>
            <div className="mt-0.5 text-(--color-text-tertiary) break-words">{rebaseError}</div>
          </div>
          {showPushRejected && (
            <Button
              size="md"
              variant="secondary"
              onClick={() => startRebase(sessionId, baseBranch)}
            >
              <ArrowsClockwiseIcon size={ICON_SIZE.XS} />
              Retry
            </Button>
          )}
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => setRebaseError(null)}
            className="shrink-0 text-(--color-text-tertiary) hover:text-(--color-text-secondary)"
          >
            <XIcon size={ICON_SIZE.SM} />
          </button>
        </div>
      </div>
    );
  }

  if (!showPushRejected && rebaseStatus === "idle") return null;

  return (
    <div className="mx-4 last:mb-2">
      <div className="flex items-center gap-2 px-3 py-2 rounded-lg border border-(--color-border-secondary) bg-(--color-bg-secondary) text-xs">
        {/* Push rejected — offer rebase */}
        {showPushRejected && rebaseStatus === "idle" && (
          <>
            <WarningIcon size={ICON_SIZE.SM} className="text-(--color-warning) shrink-0" />
            <span className="text-(--color-text-secondary) flex-1">
              Branch is behind <code className="font-mono text-(--color-text-tertiary)">{baseBranch}</code>. Update to resolve.
            </span>
            <Button
              size="md"
              variant="secondary"
              onClick={() => startRebase(sessionId, baseBranch)}
            >
              <ArrowsClockwiseIcon size={ICON_SIZE.XS} />
              Update branch
            </Button>
          </>
        )}

        {/* Rebase in progress */}
        {rebaseStatus === "in_progress" && (
          <>
            <Spinner size={14} className="text-(--color-info) shrink-0" />
            <span className="text-(--color-text-secondary) flex-1">
              Rebasing onto <code className="font-mono text-(--color-text-tertiary)">{baseBranch}</code>…
            </span>
          </>
        )}

        {/* Rebase has conflicts */}
        {rebaseStatus === "conflicts" && (
          <>
            <XCircleIcon size={ICON_SIZE.SM} className="text-(--color-error) shrink-0" />
            <div className="flex-1">
              <span className="text-(--color-text-secondary)">
                {rebaseConflicts.length} conflict{rebaseConflicts.length !== 1 ? "s" : ""} during rebase
              </span>
              {rebaseConflicts.length > 0 && (
                <div className="mt-1 text-(--color-text-tertiary) font-mono text-[10px] leading-tight">
                  {rebaseConflicts.map((c) => (
                    <div key={c.path}>• {c.path}</div>
                  ))}
                </div>
              )}
            </div>
            <Button
              size="md"
              variant="secondary"
              onClick={() => abortRebase(sessionId)}
            >
              Abort rebase
            </Button>
          </>
        )}

        {/* Resolving (agent is working on conflicts) */}
        {rebaseStatus === "resolving" && (
          <>
            <Spinner size={14} className="text-(--color-info) shrink-0" />
            <span className="text-(--color-text-secondary) flex-1">
              Rebase in progress — agent is resolving conflicts…
            </span>
          </>
        )}
      </div>
    </div>
  );
}
