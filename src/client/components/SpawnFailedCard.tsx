/**
 * SpawnFailedCard — in-chat affordance for a failed `shipit session create`
 * attempt (docs/117 cross-cutting follow-up).
 *
 * Counterpart to `SpawnedSessionCard`: when the running agent's spawn is
 * rejected (per-turn / per-parent quota hit, invalid branch, archived parent,
 * orchestrator error), the orchestrator emits a `session_spawn_failed` event
 * on the parent runner. Without this card the rejection would only show on
 * the shim's stderr — invisible in the parent's chat lane and impossible to
 * correlate with the spawn attempt that triggered it.
 *
 * Renders a muted card with:
 *   - Title (matches the `Spawned session` card layout, easy visual pairing)
 *   - The failure reason, rephrased for the user (quota / invalid / parent
 *     missing / generic)
 *   - The error message returned by the orchestrator
 *   - The first line of the prompt the agent tried to spawn, so the user can
 *     correlate the failure with the agent's intent
 *
 * No action buttons: there's nothing for the user to *do* here — the agent
 * will either retry or move on. The card is informational.
 */

import { WarningCircleIcon, GitBranchIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";

export interface SpawnFailedCardProps {
  /** Title the agent requested (or the prompt slug). Falls back to "Spawned session". */
  title?: string;
  /** Branch the agent requested. */
  branch?: string;
  /** Short outcome bucket — drives the friendly headline. */
  reason:
    | "quota_per_turn"
    | "quota_per_parent"
    | "invalid_request"
    | "parent_missing"
    | "error";
  /** Verbatim orchestrator error message. */
  message: string;
  /** HTTP status code (rendered as a small badge so power users can debug). */
  statusCode: number;
  /** First line of the prompt the spawn was meant to kick off. */
  promptPreview?: string;
  /** ISO8601 timestamp (currently unused in rendering; kept for parity with the WS event). */
  failedAt?: string;
}

function headlineForReason(reason: SpawnFailedCardProps["reason"]): string {
  switch (reason) {
    case "quota_per_turn":
      return "Per-turn spawn limit reached";
    case "quota_per_parent":
      return "Per-session spawn limit reached";
    case "invalid_request":
      return "Spawn request rejected";
    case "parent_missing":
      return "Parent session unavailable";
    case "error":
    default:
      return "Spawn failed";
  }
}

export function SpawnFailedCard({
  title,
  branch,
  reason,
  message,
  statusCode,
  promptPreview,
}: SpawnFailedCardProps) {
  const headline = headlineForReason(reason);
  const displayTitle = title?.trim() || "Spawned session";

  return (
    <div
      data-testid="spawn-failed-card"
      className="rounded-lg border border-(--color-border-secondary) bg-(--color-bg-secondary) px-3 py-2.5 text-xs flex flex-col gap-2"
    >
      <div className="flex items-start gap-2">
        <span className="shrink-0 text-(--color-warning) mt-0.5">
          <WarningCircleIcon size={ICON_SIZE.SM} weight="fill" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-(--color-text-tertiary) text-[10px] uppercase tracking-wide font-medium flex items-center gap-1.5">
            <span>Spawn failed</span>
            <span
              className="font-mono text-(--color-text-tertiary)"
              data-testid="spawn-failed-status"
            >
              · {statusCode}
            </span>
          </div>
          <div
            className="text-(--color-text-primary) font-medium truncate"
            title={displayTitle}
            data-testid="spawn-failed-title"
          >
            {displayTitle}
          </div>
          {branch && (
            <div className="mt-1 flex items-center gap-1 text-(--color-text-tertiary) text-[11px]">
              <GitBranchIcon size={ICON_SIZE.XS} className="shrink-0" />
              <span className="truncate font-mono" title={branch}>{branch}</span>
            </div>
          )}
        </div>
      </div>

      <div
        className="text-(--color-warning) text-[11px] font-medium"
        data-testid="spawn-failed-headline"
      >
        {headline}
      </div>

      <div
        className="text-(--color-text-secondary) text-[11px] whitespace-pre-wrap break-words"
        data-testid="spawn-failed-message"
      >
        {message}
      </div>

      {promptPreview && (
        <div
          className="rounded border border-(--color-border-secondary) bg-(--color-bg-primary) px-2 py-1.5 text-[11px] text-(--color-text-tertiary) italic line-clamp-2"
          title={promptPreview}
          data-testid="spawn-failed-prompt"
        >
          “{promptPreview}”
        </div>
      )}
    </div>
  );
}
