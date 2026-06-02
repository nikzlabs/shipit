/**
 * SpawnedSessionCard — in-chat affordance for a child session the running
 * agent spawned via `shipit session create` (docs/117 Phase 2).
 *
 * Renders inline in the parent's chat at the point in the message group
 * where the spawn happened. Shows:
 *
 *   - The child's title
 *   - The child's branch
 *   - A status pill (running / idle / unknown) sourced from the active-runner
 *     set; when the child doesn't appear in the sidebar (e.g. it was archived
 *     after spawning) we render a muted "session not found" fallback so the
 *     card never becomes a broken reference.
 *   - An "Open" button that switches the active session to the child via the
 *     same code path the sidebar uses.
 *
 * The card never fetches anything itself — every value is either a static
 * prop (title/branch baked in at spawn time) or read live from the session
 * store. That keeps the component cheap to mount and easy to test.
 */

import { ArrowSquareOutIcon, CircleNotchIcon, GitBranchIcon, GitCommitIcon, PlusCircleIcon, WrenchIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import { Button } from "./ui/button.js";
import { useSessionStore } from "../stores/session-store.js";

/**
 * docs/162 — Ops remediation metadata. Present only when the child was spawned
 * via `shipit session create --shipit-source` from an Ops session. Flips the
 * card into its "ShipIt fix" variant: a wrench header, the exact commit the
 * child branched from (with an exact/approximate badge), the target repo the
 * fix PR opens against, and a one-line diagnosis summary.
 */
export interface SpawnedSessionShipitFix {
  /** Commit the child branched from (the inspected source ref). */
  sourceRef: string;
  /** True only when `sourceRef` is the exact deployed build commit. */
  sourceExact: boolean;
  /** Where `sourceRef` came from — exact build id vs. checkout HEAD. */
  refSource?: "build-id" | "checkout-head";
  /** `owner/repo` the fix PR will open against. */
  targetRepo?: string;
  /** First line of the Ops diagnosis. */
  diagnosis?: string;
}

export interface SpawnedSessionCardProps {
  /** The child session id. */
  childSessionId: string;
  /** Child title, baked in by the spawn event so the card stays stable if the session row vanishes. */
  title: string;
  /** Child branch (matches the sidebar). May be omitted for very old events. */
  branch?: string;
  /** ISO8601 timestamp the child was spawned at. Currently unused in the rendering but kept for parity with the WS payload + future "spawned 2m ago" affordance. */
  spawnedAt?: string;
  /** docs/162 — Ops ShipIt-fix metadata; when set, renders the fix variant. */
  shipitFix?: SpawnedSessionShipitFix;
  /**
   * Optional click handler — when supplied, the card invokes this instead of
   * pulling the session-store directly. Lets the parent component decide how
   * to handle navigation (e.g. AppLayout's `onResumeSession` wraps the
   * router's `navigate`). When omitted, the card falls back to
   * `useSessionStore.getState().setSessionId(childSessionId)`, which works in
   * test renderings without router setup.
   */
  onOpen?: (childSessionId: string) => void;
}

export function SpawnedSessionCard({
  childSessionId,
  title,
  branch,
  shipitFix,
  onOpen,
}: SpawnedSessionCardProps) {
  // Existence check: a session row may have been archived/deleted since the
  // spawn happened. We don't refuse to render — the title/branch in the event
  // payload still tell the user what was spawned — but the status pill flips
  // to "session not found" and the Open button is disabled.
  const childRow = useSessionStore((s) =>
    s.sessions.find((row) => row.id === childSessionId),
  );
  const isAgentRunning = useSessionStore((s) =>
    s.activeRunnerSessions.has(childSessionId),
  );

  const sessionMissing = !childRow;
  const sessionArchived = childRow?.archived === true;

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
      data-testid="spawned-session-card"
      className="rounded-lg border border-(--color-border-secondary) bg-(--color-bg-secondary) px-3 py-2.5 text-xs flex flex-col gap-2"
    >
      <div className="flex items-start gap-2">
        <span className="shrink-0 text-(--color-success) mt-0.5">
          {shipitFix ? (
            <WrenchIcon size={ICON_SIZE.SM} weight="fill" />
          ) : (
            <PlusCircleIcon size={ICON_SIZE.SM} weight="fill" />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-(--color-text-tertiary) text-[10px] uppercase tracking-wide font-medium">
            {shipitFix ? "ShipIt fix session" : "Spawned session"}
          </div>
          <div className="text-(--color-text-primary) font-medium truncate" title={title}>
            {title}
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
          aria-label={`Open spawned session ${title}`}
        >
          <ArrowSquareOutIcon size={ICON_SIZE.XS} />
          Open
        </Button>
      </div>

      {/* docs/162 — Ops remediation context: which commit the fix branched
          from, where the PR opens, and the diagnosis that prompted it. Only
          rendered for `--shipit-source` spawns. */}
      {shipitFix && (
        <div
          className="flex flex-col gap-1.5 rounded border border-(--color-border-secondary) bg-(--color-bg-primary) px-2 py-1.5"
          data-testid="spawned-session-shipit-fix"
        >
          <div className="flex items-center gap-1.5 text-[11px] text-(--color-text-tertiary)">
            <GitCommitIcon size={ICON_SIZE.XS} className="shrink-0" />
            <span className="font-mono truncate" title={shipitFix.sourceRef}>
              {shipitFix.sourceRef.slice(0, 12)}
            </span>
            <span
              className={
                shipitFix.sourceExact
                  ? "text-[9px] font-semibold uppercase tracking-wide text-(--color-success) shrink-0"
                  : "text-[9px] font-semibold uppercase tracking-wide text-(--color-warning) shrink-0"
              }
              data-testid="spawned-session-source-exactness"
            >
              {shipitFix.sourceExact ? "exact" : "approximate"}
            </span>
          </div>
          {shipitFix.targetRepo && (
            <div className="flex items-center gap-1.5 text-[11px] text-(--color-text-tertiary)">
              <GitBranchIcon size={ICON_SIZE.XS} className="shrink-0" />
              <span className="font-mono truncate" title={shipitFix.targetRepo}>
                {shipitFix.targetRepo}
              </span>
            </div>
          )}
          {shipitFix.diagnosis && (
            <div
              className="text-[11px] text-(--color-text-secondary) italic line-clamp-2"
              title={shipitFix.diagnosis}
            >
              “{shipitFix.diagnosis}”
            </div>
          )}
        </div>
      )}

      {/* Status pill. Mirrors the sidebar's SessionStatusDot semantics so the
          two surfaces stay in sync without duplicating its full priority
          ladder — for an inline card, "running / idle / missing" is enough. */}
      <div className="flex items-center gap-1.5 text-[11px]">
        {sessionMissing ? (
          <span className="text-(--color-text-tertiary)" data-testid="spawned-session-status">
            Session not found
          </span>
        ) : sessionArchived ? (
          <span className="text-(--color-text-tertiary)" data-testid="spawned-session-status">
            Archived
          </span>
        ) : isAgentRunning ? (
          <span
            className="flex items-center gap-1 text-(--color-success)"
            data-testid="spawned-session-status"
          >
            <CircleNotchIcon size={ICON_SIZE.XS} className="animate-spin" />
            Running
          </span>
        ) : (
          <span
            className="flex items-center gap-1 text-(--color-text-tertiary)"
            data-testid="spawned-session-status"
          >
            <span className="w-2 h-2 rounded-full bg-(--color-text-tertiary)" />
            Idle
          </span>
        )}
      </div>
    </div>
  );
}
