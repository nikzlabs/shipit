import { CircleNotchIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import type { StreamingActivity } from "./StreamingIndicator.js";

interface AgentStatusBarProps {
  activity?: StreamingActivity;
  /**
   * Whether a PR lifecycle card sits directly below this status bar.
   * When true, we omit our bottom padding because the PR card already
   * provides an `mt-2` of its own — keeping the gap consistent at 8px
   * regardless of whether the PR card is present.
   */
  hasPrCard?: boolean;
}

export function AgentStatusBar({ activity, hasPrCard = false }: AgentStatusBarProps) {
  return (
    <div className={`mx-4 px-4 pt-0 ${hasPrCard ? "pb-0" : "pb-2"} flex items-center gap-1.5`}>
      <CircleNotchIcon
        size={ICON_SIZE.XS}
        className="animate-spin text-(--color-text-tertiary)"
      />
      <span className="text-xs text-(--color-text-tertiary)">
        {activity?.label ?? "Working..."}
      </span>
    </div>
  );
}
