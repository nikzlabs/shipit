import { TargetIcon } from "@phosphor-icons/react";
import type { AgentGoal } from "../../server/shared/types.js";
import { ICON_SIZE } from "../design-tokens.js";

const STATUS_LABELS: Record<string, string> = {
  active: "Active",
  paused: "Paused",
  // docs/298 — Grok's words. Every `grok -r` leaves an active goal user_paused.
  user_paused: "Paused",
  back_off_paused: "Backing off",
  no_progress_paused: "No progress",
  infra_paused: "Paused (error)",
  budget_limited: "Budget reached",
  interrupted: "Interrupted",
  blocked: "Blocked",
  usageLimited: "Usage limit",
  budgetLimited: "Budget reached",
  complete: "Complete",
};

const PAUSED_STATUSES = new Set([
  "paused", "user_paused", "back_off_paused", "no_progress_paused", "infra_paused",
]);

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
        <span className="shrink-0 text-(--color-text-tertiary)">
          {PAUSED_STATUSES.has(goal.status) ? "/goal resume to continue · " : ""}/goal clear to remove
        </span>
      </div>
    </div>
  );
}
