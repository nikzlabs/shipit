import { CloudArrowDownIcon, GitMergeIcon, HardDrivesIcon, CheckCircleIcon, XCircleIcon, CircleNotchIcon, WrenchIcon } from "@phosphor-icons/react";
import { AUTO_MERGE_ICON_CLASS, ICON_SIZE } from "../../design-tokens.js";
import { useSessionStore } from "../../stores/session-store.js";
import { usePrStore } from "../../stores/pr-store.js";
import type { SessionInfo } from "../../../server/shared/types.js";

/** Consolidated status dot replacing separate AgentDot + CiDot. */
export function SessionStatusDot({ sessionId }: { sessionId: string }) {
  const card = usePrStore((s) => s.cardBySession[sessionId]);
  const isAgentRunning = useSessionStore((s) => s.activeRunnerSessions.has(sessionId));

  const checks = card?.checks;
  const autoFix = card?.autoFix;

  // Priority 1: Auto-fix running (a specific form of agent activity)
  if (autoFix?.status === "running") {
    return <span className="shrink-0 text-(--color-autofix) flex" title="Auto-fix running"><WrenchIcon size={ICON_SIZE.XS} className="animate-spin" /></span>;
  }

  // Priority 2: Agent running — takes precedence over CI status; the agent
  // may already be addressing the failure, so don't surface a stale CI-failed
  // indicator while it's working.
  if (isAgentRunning) {
    return <span className="w-2 h-2 rounded-full bg-(--color-success) animate-pulse shrink-0" title="Agent running" />;
  }

  // Priority 3: CI failed (auto-fix not running and agent idle, both checked above)
  if (checks?.state === "failure") {
    return <span className="shrink-0 text-(--color-error) flex" title={`CI failed ${checks.failed} of ${checks.total}`}><XCircleIcon size={ICON_SIZE.XS} /></span>;
  }

  // Priority 4: CI pending
  if (checks?.state === "pending") {
    return <span className="shrink-0 text-(--color-warning) flex" title={`CI running ${checks.passed}/${checks.total}`}><CircleNotchIcon size={ICON_SIZE.XS} className="animate-spin" /></span>;
  }

  // Priority 5: CI passed
  if (checks?.state === "success") {
    return <span className="shrink-0 text-(--color-success) flex" title={`CI passed ${checks.total}/${checks.total}`}><CheckCircleIcon size={ICON_SIZE.XS} /></span>;
  }

  // Priority 6: idle / no data
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
  const autoMerge = usePrStore((s) => s.autoMergeBySession[sessionId] ?? s.cardBySession[sessionId]?.autoMerge);
  if (!(autoMerge?.enabled ?? false)) return null;
  return (
    <span className={`shrink-0 flex ml-auto ${AUTO_MERGE_ICON_CLASS}`} title="Auto-merge enabled">
      <GitMergeIcon size={ICON_SIZE.XS} weight="bold" />
    </span>
  );
}

/**
 * docs/161 — surfaces a session's *disk tier* when it isn't fully `hot`, so the
 * user knows selecting it triggers a restore. Listing is orthogonal to disk: an
 * `evicted` session can still be in the sidebar (it re-clones from cache on
 * select) and a `light` one keeps its checkout but reinstalls deps on open. The
 * badge is suppressed for user-archived rows, where the archive icon already
 * conveys the (also-evicted) state.
 */
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
