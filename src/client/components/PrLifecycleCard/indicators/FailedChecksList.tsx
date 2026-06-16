import type { PrCardState } from "../../../stores/pr-store.js";
import { XCircleIcon } from "@phosphor-icons/react";
import { MAX_VISIBLE_FAILURES } from "../shared.js";

export function FailedChecksList({ checks }: { checks: PrCardState["checks"] }) {
  const failedChecks = checks?.failedChecks;
  if (!failedChecks || failedChecks.length === 0) return null;

  const visible = failedChecks.slice(0, MAX_VISIBLE_FAILURES);
  const remaining = failedChecks.length - visible.length;

  return (
    <div className="mt-1 space-y-0.5">
      {visible.map((check) => (
        <div key={check.name} className="text-xs text-(--color-text-secondary)">
          <XCircleIcon size={12} className="inline text-(--color-error)" /> {check.name} — <span className="text-(--color-text-tertiary)">{check.summary}</span>
        </div>
      ))}
      {remaining > 0 && (
        <div className="text-xs text-(--color-text-tertiary)">
          and {remaining} more...
        </div>
      )}
    </div>
  );
}
