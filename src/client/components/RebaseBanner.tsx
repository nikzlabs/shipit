/**
 * RebaseBanner — shows rebase status in the chat area.
 *
 * Displays a compact banner when:
 * - Push was rejected (non-fast-forward) — offers "Update branch" button
 * - Rebase is in progress — shows spinner
 * - Rebase has conflicts — shows conflict list + abort button
 */

import { useGitStore } from "../stores/git-store.js";
import { Button } from "./ui/button.js";
import {
  ArrowsClockwiseIcon,
  CircleNotchIcon,
  WarningIcon,
  XCircleIcon,
} from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";

function Spinner() {
  return (
    <CircleNotchIcon size={14} className="animate-spin text-(--color-info) shrink-0" />
  );
}

export function RebaseBanner({ sessionId }: { sessionId: string }) {
  const rebaseStatus = useGitStore((s) => s.rebaseStatus);
  const rebaseConflicts = useGitStore((s) => s.rebaseConflicts);
  const pushRejected = useGitStore((s) => s.pushRejected);
  const startRebase = useGitStore((s) => s.startRebase);
  const abortRebase = useGitStore((s) => s.abortRebase);

  const baseBranch = "main";

  // Nothing to show
  if (!pushRejected && rebaseStatus === "idle") return null;

  // `last:mb-2` provides 8px gap to the MessageInput only when this banner is
  // the last rendered child of the bottom-stack wrapper. Otherwise the
  // wrapper's `gap-2` handles spacing to the next card (e.g. the PR card).
  return (
    <div className="mx-4 last:mb-2">
      <div className="flex items-center gap-2 px-3 py-2 rounded-lg border border-(--color-border-secondary) bg-(--color-bg-secondary) text-xs">
        {/* Push rejected — offer rebase */}
        {pushRejected && rebaseStatus === "idle" && (
          <>
            <WarningIcon size={ICON_SIZE.SM} className="text-(--color-warning) shrink-0" />
            <span className="text-(--color-text-secondary) flex-1">
              Branch is behind <code className="font-mono text-(--color-text-tertiary)">{baseBranch}</code>. Update to resolve.
            </span>
            <Button
              size="sm"
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
            <Spinner />
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
              size="sm"
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
            <Spinner />
            <span className="text-(--color-text-secondary) flex-1">
              Agent is resolving merge conflicts…
            </span>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => abortRebase(sessionId)}
            >
              Abort rebase
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
