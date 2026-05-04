import { CircleNotchIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import type { StreamingActivity } from "./StreamingIndicator.js";

interface AgentStatusBarProps {
  activity?: StreamingActivity;
}

export function AgentStatusBar({ activity }: AgentStatusBarProps) {
  // The `last:pb-2` adds 8px bottom padding only when this status bar is the
  // last rendered child of the bottom-stack wrapper — i.e. nothing (no PR
  // card, no rebase banner, no attachments) sits between it and the input.
  // When a card *does* render below it, `gap-2` on the wrapper supplies the
  // 8px gap and we leave bottom padding at 0.
  return (
    <div className="mx-4 px-4 py-0 last:pb-2 flex items-center gap-1.5">
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
