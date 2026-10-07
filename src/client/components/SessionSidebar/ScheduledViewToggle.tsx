import { ClockIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../../design-tokens.js";
import { Button } from "../ui/button.js";
import { WithTooltip } from "../ui/tooltip.js";

interface ScheduledViewToggleProps {
  active: boolean;
  onToggle: () => void;
}

/**
 * docs/324-scheduled-sessions req 20 — the switch to the sidebar's Scheduled
 * view, beside `AttentionViewToggle` and in the same house toggle pattern.
 */
export function ScheduledViewToggle({ active, onToggle }: ScheduledViewToggleProps) {
  const label = active ? "Show all sessions" : "Show scheduled runs";
  return (
    <WithTooltip label={label}>
      <Button
        variant="ghost"
        size="sm"
        onClick={onToggle}
        aria-pressed={active}
        aria-label={label}
        className={`p-0! w-7 h-7 ${
          active
            ? "bg-(--color-bg-tertiary) text-(--color-accent-text)"
            : "text-(--color-text-tertiary)"
        }`}
      >
        <ClockIcon size={ICON_SIZE.SM} weight={active ? "fill" : "regular"} className="shrink-0" />
      </Button>
    </WithTooltip>
  );
}
