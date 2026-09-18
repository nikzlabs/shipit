import { ICON_SIZE } from "../design-tokens.js";
import { Spinner } from "./Spinner.js";
import type { StreamingActivity } from "./StreamingIndicator.js";
import { useSessionStore } from "../stores/session-store.js";

interface AgentStatusBarProps {
  activity?: StreamingActivity;
}

export function AgentStatusBar({ activity }: AgentStatusBarProps) {
  // docs/178 — a compaction is what the agent is doing, so it is said here
  // rather than as a card of its own. The card the compaction leaves behind,
  // with the token counts, is still the record that it ran.
  const compacting = useSessionStore((s) => s.compacting);
  return (
    <div className="mx-4 px-4 py-0 last:pb-2 flex items-center gap-1.5">
      <Spinner size={ICON_SIZE.XS} className="text-(--color-text-tertiary)" />
      <span className="text-xs text-(--color-text-tertiary)">
        {compacting ? "Compacting context..." : activity?.label ?? "Working..."}
      </span>
    </div>
  );
}
