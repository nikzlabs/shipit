import type { GitHubDeploymentStatus } from "../../../../server/shared/types.js";
import { GlobeIcon, XCircleIcon, CircleNotchIcon } from "@phosphor-icons/react";

export function DeploymentStatusRow({ deployments }: { deployments: GitHubDeploymentStatus[] }) {
  if (deployments.length === 0) return null;

  return (
    <div className="mt-1.5 flex flex-col gap-1">
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
            {d.creator && <span className="text-(--color-text-tertiary)">via {d.creator}</span>}
          </div>
        );
      })}
    </div>
  );
}
