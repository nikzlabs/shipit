/**
 * ShipitSourceStatusCard — read-only "running ShipIt source" status for the
 * Ops Host tab (docs/162).
 *
 * Surfaces the source ref the Ops agent's `shipit source *` reads run against:
 * the exact deployed commit when the orchestrator can resolve it from the build
 * id, or the source checkout's HEAD (flagged "approximate") otherwise. This is
 * the inline counterpart to `shipit source status` — the operator can see at a
 * glance which commit a fix session would branch from without asking the agent.
 *
 * Informational only, in keeping with the Host tab contract (§1/§5): no buttons
 * that run commands or mutate state. To inspect source or spawn a fix session,
 * the operator asks the agent in chat.
 */

import { CheckCircleIcon, GitCommitIcon, WarningIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";

/**
 * Mirror of the orchestrator's `ShipitSourceStatus` DTO
 * (services/shipit-source.ts). Kept local so the client doesn't reach into
 * orchestrator service internals — only the read-only fields the card renders.
 */
interface SourceStatus {
  available: boolean;
  ref?: string;
  shortRef?: string;
  exact: boolean;
  refSource?: "build-id" | "checkout-head";
  remoteUrl?: string;
  reason?: string;
}

export interface ShipitSourceStatusCardProps {
  /** Resolved status, or null while loading / before first fetch. */
  status: SourceStatus | null;
  /** Error message from the fetch, if any. */
  error?: string | null;
}

export function ShipitSourceStatusCard({ status, error }: ShipitSourceStatusCardProps) {
  return (
    <div
      className="px-3 py-2.5 border-b border-(--color-border-primary)"
      data-testid="shipit-source-status"
    >
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide font-medium text-(--color-text-tertiary)">
        <GitCommitIcon size={ICON_SIZE.XS} className="shrink-0" />
        <span>Running ShipIt source</span>
      </div>

      {error ? (
        <div className="mt-1 flex items-center gap-1.5 text-[11px] text-(--color-error)">
          <WarningIcon size={ICON_SIZE.XS} className="shrink-0" />
          <span className="break-words">Failed to read source status: {error}</span>
        </div>
      ) : !status ? (
        <div className="mt-1 text-[11px] text-(--color-text-tertiary)">Loading…</div>
      ) : !status.available ? (
        <div
          className="mt-1 text-[11px] text-(--color-text-tertiary)"
          data-testid="shipit-source-unavailable"
        >
          {status.reason ?? "Running source is unavailable."}
        </div>
      ) : (
        <div className="mt-1 flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <span
              className="font-mono text-xs text-(--color-text-primary) truncate"
              title={status.ref}
            >
              {status.shortRef ?? status.ref?.slice(0, 12)}
            </span>
            {status.exact ? (
              <span
                className="flex items-center gap-1 text-[9px] font-semibold uppercase tracking-wide text-(--color-success) shrink-0"
                data-testid="shipit-source-exactness"
              >
                <CheckCircleIcon size={ICON_SIZE.XS} weight="fill" />
                exact
              </span>
            ) : (
              <span
                className="flex items-center gap-1 text-[9px] font-semibold uppercase tracking-wide text-(--color-warning) shrink-0"
                data-testid="shipit-source-exactness"
              >
                <WarningIcon size={ICON_SIZE.XS} weight="fill" />
                approximate
              </span>
            )}
          </div>
          {status.remoteUrl && (
            <div
              className="text-[10px] text-(--color-text-tertiary) font-mono truncate opacity-70"
              title={status.remoteUrl}
            >
              {status.remoteUrl}
            </div>
          )}
          <div className="text-[10px] text-(--color-text-tertiary)">
            {status.exact
              ? "Exact deployed commit (matches the running build)."
              : "Source checkout HEAD — may differ from the running build."}
          </div>
        </div>
      )}
    </div>
  );
}
