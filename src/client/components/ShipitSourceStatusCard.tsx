

import { CheckCircleIcon, GitCommitIcon, WarningIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";

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

  status: SourceStatus | null;

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
