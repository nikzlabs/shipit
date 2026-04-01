import { CircleNotchIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import type { StreamingActivity } from "./StreamingIndicator.js";

interface AgentStatusBarProps {
  activity?: StreamingActivity;
}

export function AgentStatusBar({ activity }: AgentStatusBarProps) {
  return (
    <div className="mx-4 px-4 py-0 flex items-center gap-1.5">
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
