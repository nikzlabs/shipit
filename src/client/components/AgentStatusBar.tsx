import { ICON_SIZE } from "../design-tokens.js";
import { Spinner } from "./Spinner.js";
import type { StreamingActivity } from "./StreamingIndicator.js";

interface AgentStatusBarProps {
  activity?: StreamingActivity;
}

export function AgentStatusBar({ activity }: AgentStatusBarProps) {
  return (
    <div className="mx-4 px-4 py-0 last:pb-2 flex items-center gap-1.5">
      <Spinner size={ICON_SIZE.XS} className="text-(--color-text-tertiary)" />
      <span className="text-xs text-(--color-text-tertiary)">
        {activity?.label ?? "Working..."}
      </span>
    </div>
  );
}
