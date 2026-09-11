import { CloudArrowDownIcon, GitMergeIcon, HardDrivesIcon, CheckCircleIcon, XCircleIcon, WrenchIcon } from "@phosphor-icons/react";
import { Spinner } from "../Spinner.js";
import { AUTO_MERGE_ICON_CLASS, ICON_SIZE } from "../../design-tokens.js";
import { useSessionStore } from "../../stores/session-store.js";
import { usePrStore, useActiveAutoMerge } from "../../stores/pr-store.js";
import { useCiDisplay } from "../../hooks/useCiDisplay.js";
import type { SessionInfo } from "../../../server/shared/types.js";

export function SessionStatusDot({ sessionId }: { sessionId: string }) {
  const card = usePrStore((s) => s.cardBySession[sessionId]);

  const isAgentRunning = useSessionStore(
    (s) => s.activeRunnerSessions.has(sessionId) || s.backgroundTaskSessions.has(sessionId),
  );

  const ci = useCiDisplay(card?.checks);
  const autoFix = card?.autoFix;

  // is the "running" signal and the rotation was never carrying it.
  if (autoFix?.status === "running") {
    return <span className="shrink-0 text-(--color-autofix) flex" title="Auto-fix running"><WrenchIcon size={ICON_SIZE.XS} /></span>;
  }

  if (isAgentRunning) {
    return <span className="w-2 h-2 rounded-full bg-(--color-success) animate-pulse shrink-0" title="Agent running" />;
  }

  if (ci.kind === "failure") {
    return <span className="shrink-0 text-(--color-error) flex" title={`CI failed ${ci.failed} of ${ci.total}`}><XCircleIcon size={ICON_SIZE.XS} /></span>;
  }

  if (ci.kind === "pending") {
    return <span className="shrink-0 text-(--color-warning) flex" title={`CI running ${ci.passed}/${ci.total}`}><Spinner size={ICON_SIZE.XS} /></span>;
  }

  if (ci.kind === "success") {
    return <span className="shrink-0 text-(--color-success) flex" title={`CI passed ${ci.total}/${ci.total}`}><CheckCircleIcon size={ICON_SIZE.XS} /></span>;
  }

  return null;
}

/**
 * Auto-merge indicator, right-aligned on the session row's meta line. Auto-merge
 * is a session-level preference that can be armed before any PR exists, so it's
 * read from the persistent per-session map (falling back to the open-phase card
 * value) and rendered independently of CI/PR state. Neutral secondary color: it's
 * an informational "armed" attribute, not a status, so it must not collide with
 * the colored CI glyphs (accent/success collide with status colors in warm/light
 * themes).
 */
export function AutoMergeBadge({ sessionId }: { sessionId: string }) {

  const autoMerge = useActiveAutoMerge(sessionId);
  if (!(autoMerge?.enabled ?? false)) return null;
  return (
    <span className={`shrink-0 flex ml-auto ${AUTO_MERGE_ICON_CLASS}`} title="Auto-merge enabled">
      <GitMergeIcon size={ICON_SIZE.XS} weight="bold" />
    </span>
  );
}

export function DiskTierBadge({ session }: { session: SessionInfo }) {
  if (session.diskTier === "light") {
    return (
      <span className="shrink-0 flex text-(--color-text-tertiary)" title="Dependencies cleared to save disk — reinstalled when you open it">
        <HardDrivesIcon size={ICON_SIZE.XS} />
      </span>
    );
  }
  if (session.diskTier === "evicted") {
    return (
      <span className="shrink-0 flex text-(--color-text-tertiary)" title="Workspace stored to save disk — restored from the cache when you open it">
        <CloudArrowDownIcon size={ICON_SIZE.XS} />
      </span>
    );
  }
  return null;
}
