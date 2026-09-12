import { TargetIcon } from "@phosphor-icons/react";
import type { AgentGoal } from "../../server/shared/types.js";
import { ICON_SIZE } from "../design-tokens.js";

const STATUS_LABELS: Record<string, string> = {
  active: "Active",
  paused: "Paused",
  blocked: "Blocked",
  usageLimited: "Usage limit",
  budgetLimited: "Budget reached",
  complete: "Complete",
};

export function GoalChip({ goal }: { goal: AgentGoal }) {
  return (
    <div className="mx-4 last:mb-2" data-testid="goal-chip">
      <div className="flex items-center gap-2 px-3 py-2 rounded-lg border border-(--color-border-secondary) bg-(--color-bg-secondary) text-xs">
        <TargetIcon size={ICON_SIZE.SM} className="text-(--color-text-secondary) shrink-0" />
        <span className="shrink-0 text-(--color-text-secondary)">
          Goal · {STATUS_LABELS[goal.status] ?? goal.status}
        </span>
        <span className="flex-1 min-w-0 truncate text-(--color-text-primary)" title={goal.objective}>
          {goal.objective}
        </span>
        <span className="shrink-0 text-(--color-text-tertiary)">/goal clear to remove</span>
      </div>
    </div>
  );
}
