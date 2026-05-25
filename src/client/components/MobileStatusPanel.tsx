import type { ReactNode } from "react";
import type { DockerMemoryStats, SubscriptionLimitsMap } from "../../server/shared/types.js";
import { DockerMemoryBadge } from "./DockerMemoryBadge.js";
import { SubscriptionLimitsBadge } from "./SubscriptionLimitsBadge.js";
import { UptimeBadge } from "./UptimeBadge.js";

interface MobileStatusPanelProps {
  subscriptionLimits: SubscriptionLimitsMap;
  dockerMemory: DockerMemoryStats | null;
  processStartedAt: number | null;
}

/**
 * Mobile-only rendering of the header status pills. On desktop the
 * pills sit inline with hover tooltips carrying the long form
 * (start date, memory percentage, plan name). Mobile has no hover,
 * so this panel surrounds each pill with a label header and an
 * explanatory caption so the popover is self-describing.
 */
export function MobileStatusPanel({ subscriptionLimits, dockerMemory, processStartedAt }: MobileStatusPanelProps) {
  const hasSubscription = Object.values(subscriptionLimits).some((s) => s);
  const hasMemoryLimit = dockerMemory && dockerMemory.totalBytes > 0;

  return (
    <div className="flex flex-col items-stretch gap-3 min-w-[200px]">
      {hasSubscription && (
        <Section label="Subscription">
          <div className="flex flex-col items-start gap-1">
            <SubscriptionLimitsBadge limits={subscriptionLimits} />
          </div>
        </Section>
      )}
      {processStartedAt !== null && (
        <Section label="Uptime">
          <UptimeBadge processStartedAt={processStartedAt} />
          <Caption>Started {new Date(processStartedAt).toLocaleString()}</Caption>
        </Section>
      )}
      {dockerMemory && (
        <Section label="Docker memory">
          <DockerMemoryBadge stats={dockerMemory} />
          {hasMemoryLimit && (
            <Caption>
              {Math.round((dockerMemory.usedBytes / dockerMemory.totalBytes) * 100)}% used
            </Caption>
          )}
        </Section>
      )}
    </div>
  );
}

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="flex flex-col items-start gap-1">
      <span className="text-[10px] uppercase tracking-wide text-(--color-text-tertiary) font-semibold">
        {label}
      </span>
      {children}
    </section>
  );
}

function Caption({ children }: { children: ReactNode }) {
  return <span className="text-[11px] text-(--color-text-secondary)">{children}</span>;
}
