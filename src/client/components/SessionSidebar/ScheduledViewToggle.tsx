import { ClockIcon, WarningIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../../design-tokens.js";
import { Button } from "../ui/button.js";
import { WithTooltip } from "../ui/tooltip.js";

interface ScheduledViewToggleProps {
  active: boolean;
  /** Schedules whose last start failed (req 18); any of them puts a warning mark on the control. */
  failedCount?: number;
  onToggle: () => void;
}

/**
 * docs/324-scheduled-sessions req 20 — the switch to the sidebar's Scheduled
 * view, beside `AttentionViewToggle` and in the same house toggle pattern. The
 * warning mark sits beside the glyph, as that control's count does, never over it.
 */
export function ScheduledViewToggle({ active, failedCount = 0, onToggle }: ScheduledViewToggleProps) {
  const view = active ? "Show all sessions" : "Show scheduled runs";
  const label = failedCount === 0
    ? view
    : `${view} (${failedCount === 1 ? "a schedule" : `${failedCount} schedules`} could not start)`;
  return (
    <WithTooltip label={label}>
      <Button
        variant="ghost"
        size="sm"
        onClick={onToggle}
        aria-pressed={active}
        aria-label={label}
        className={`${failedCount > 0 ? "px-1.5! gap-1" : "p-0! w-7"} h-7 ${
          active
            ? "bg-(--color-bg-tertiary) text-(--color-accent-text)"
            : "text-(--color-text-tertiary)"
        }`}
      >
        <ClockIcon size={ICON_SIZE.SM} weight={active ? "fill" : "regular"} className="shrink-0" />
        {failedCount > 0 && (
          <WarningIcon
            size={ICON_SIZE.XS}
            weight="fill"
            className="shrink-0 text-(--color-warning)"
            data-testid="scheduled-view-warning"
          />
        )}
      </Button>
    </WithTooltip>
  );
}
