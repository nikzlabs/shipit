/**
 * PrStatusSection — full status breakdown for the PR detail panel.
 *
 * Reads from the SAME store slice the inline card reads (`pr-store`:
 * `cardBySession` + `statusBySession`), so the card and panel are always two
 * views of one model — never parallel state. This is the richer, wider
 * rendering of the compact card status row.
 *
 * Actionable controls (merge, auto-fix, auto-merge) remain on the card for
 * now; wiring them into the panel is docs/133 Phase 3 follow-up.
 */

import {
  CheckCircleIcon,
  XCircleIcon,
  CircleNotchIcon,
  GlobeIcon,
  WarningIcon,
} from "@phosphor-icons/react";
import { ICON_SIZE } from "../../design-tokens.js";
import { usePrStore } from "../../stores/pr-store.js";
import type { PrCardState } from "../../stores/pr-store.js";

function ChecksSummary({ checks }: { checks: PrCardState["checks"] }) {
  if (!checks || checks.state === "none") {
    return <p className="text-sm text-(--color-text-tertiary)">No CI checks for this PR.</p>;
  }

  let icon: React.ReactNode;
  let label: string;
  if (checks.state === "success") {
    icon = <CheckCircleIcon size={ICON_SIZE.SM} className="text-(--color-success)" />;
    label = `${checks.passed}/${checks.total} checks passed`;
  } else if (checks.state === "failure") {
    icon = <XCircleIcon size={ICON_SIZE.SM} className="text-(--color-error)" />;
    label = `${checks.failed} of ${checks.total} checks failing`;
  } else {
    icon = <CircleNotchIcon size={ICON_SIZE.SM} className="text-(--color-warning) animate-spin" />;
    label = checks.total === 0 ? "Waiting for CI to start" : `${checks.passed}/${checks.total} checks complete`;
  }

  return (
    <div>
      <div className="flex items-center gap-2 text-sm text-(--color-text-secondary)">
        {icon} {label}
      </div>
      {checks.failedChecks && checks.failedChecks.length > 0 && (
        <ul className="mt-1.5 space-y-1 pl-6">
          {checks.failedChecks.map((c) => (
            <li key={c.name} className="text-xs text-(--color-text-secondary)">
              <XCircleIcon size={12} className="inline text-(--color-error)" /> {c.name}
              {c.summary && <span className="text-(--color-text-tertiary)"> — {c.summary}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function PrStatusSection({ sessionId, card }: { sessionId: string; card: PrCardState }) {
  const status = usePrStore((s) => s.statusBySession[sessionId]);
  const deployments = status?.deployments ?? [];
  const mergeable = status?.mergeable;
  const checks = card.checks ?? (status ? status.checks : undefined);

  return (
    <section className="px-4 py-3 border-b border-(--color-border-primary) space-y-3">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-(--color-text-tertiary)">
        Status
      </h3>

      <ChecksSummary checks={checks} />

      {mergeable === "conflicting" && (
        <div className="flex items-center gap-2 text-sm text-(--color-warning)">
          <WarningIcon size={ICON_SIZE.SM} /> Branch has merge conflicts with the base branch.
        </div>
      )}

      {deployments.length > 0 && (
        <div className="space-y-1">
          {deployments.map((d, i) => {
            const isActive = d.state === "success";
            const isPending = d.state === "pending" || d.state === "in_progress" || d.state === "queued";
            const isFailed = d.state === "failure" || d.state === "error";
            return (
              <div key={`${d.environment}-${i}`} className="flex items-center gap-1.5 text-xs">
                {isPending && <CircleNotchIcon size={12} className="text-(--color-warning) animate-spin shrink-0" />}
                {isActive && <GlobeIcon size={12} className="text-(--color-success) shrink-0" />}
                {isFailed && <XCircleIcon size={12} className="text-(--color-error) shrink-0" />}
                {!isPending && !isActive && !isFailed && <GlobeIcon size={12} className="text-(--color-text-tertiary) shrink-0" />}
                <span className="text-(--color-text-secondary)">{d.environment}</span>
                {d.environmentUrl && (
                  <a href={d.environmentUrl} target="_blank" rel="noopener noreferrer" className="text-(--color-text-link) hover:text-(--color-accent) truncate max-w-xs">
                    {(() => { try { return new URL(d.environmentUrl).hostname; } catch { return d.environmentUrl; } })()}
                  </a>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
