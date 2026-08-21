import type { ReactNode } from "react";
import type { DockerMemoryStats, SubscriptionLimitsMap } from "../../server/shared/types.js";
import { DockerMemoryBadge } from "./DockerMemoryBadge.js";
import { SubscriptionLimitsBadge, useSubscriptionPillCount } from "./SubscriptionLimitsBadge.js";
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
 *
 * Radix unmounts `PopoverContent` on close, so this component mounts exactly
 * when the dropdown opens — which is what `autoRefresh` on the subscription
 * badge hangs off. Opening the dropdown is the user asking for the number, so
 * it spends one `/api/oauth/usage` call (throttled, lockout-aware) instead of
 * making them tap the refresh glyph as a second step.
 */
export function MobileStatusPanel({ subscriptionLimits, dockerMemory, processStartedAt }: MobileStatusPanelProps) {
  // Ask the badge what it would render rather than re-deriving it. This read
  // "any connected account, or any snapshot", which was the same answer until
  // docs/274 req 16: an xAI subscription reports no quota ShipIt can read, so
  // it has an account and no pill — and the two conditions disagreeing puts a
  // "Subscription" heading above an empty box.
  const hasSubscription = useSubscriptionPillCount(subscriptionLimits) > 0;
  const hasMemoryLimit = dockerMemory && dockerMemory.totalBytes > 0;

  return (
    <div className="flex flex-col items-stretch gap-3 min-w-[200px]">
      {hasSubscription && (
        <Section label="Subscription">
          <div className="flex flex-col items-start gap-1">
            <SubscriptionLimitsBadge limits={subscriptionLimits} autoRefresh />
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
