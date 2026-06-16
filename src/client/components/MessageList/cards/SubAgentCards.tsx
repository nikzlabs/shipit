import { CircleNotchIcon } from "@phosphor-icons/react";
import type { SubAgentConsultCard as SubAgentConsultCardData } from "../../../../server/shared/types.js";
import type { SubAgentSpawnChip } from "../../../stores/session-store.js";

/** Display names for the spawn chip / consult card. */
const SUB_AGENT_DISPLAY_NAMES: Record<string, string> = { claude: "Claude", codex: "Codex" };

/**
 * docs/144 — transient in-flight "Asking Codex…" spinner, rendered at the bottom
 * of the transcript as live activity while the `shipit agent` call is in flight.
 * Emit-only, not persisted (CLAUDE.md §5) — it disappears once the terminal
 * `SubAgentConsultCardRow` lands inline where the consultation happened.
 */
export function SubAgentSpawnChipRow({ chip }: { chip: SubAgentSpawnChip }) {
  const name = SUB_AGENT_DISPLAY_NAMES[chip.subAgentId] ?? chip.subAgentId;
  return (
    <div className="flex justify-start" data-testid="sub-agent-spawn-chip">
      <div className="flex items-center gap-2 rounded-lg border border-(--color-border-primary) bg-(--color-bg-tertiary) px-3 py-2 text-xs text-(--color-text-secondary)">
        <CircleNotchIcon size={14} className="animate-spin text-(--color-text-tertiary)" />
        Asking {name}… <span className="text-(--color-text-tertiary)">(typically 30–120s)</span>
      </div>
    </div>
  );
}

/**
 * docs/144 — the persisted terminal "Consulted Codex · 47s · $0.03" record for a
 * completed sub-agent spawn. Renders inline at the spawn position (anchored in
 * chat history) and survives a session switch / full reload, unlike the transient
 * spinner above. Covers every terminal status, not just success.
 */
export function SubAgentConsultCardRow({ card }: { card: SubAgentConsultCardData }) {
  const name = SUB_AGENT_DISPLAY_NAMES[card.subAgentId] ?? card.subAgentId;
  const secs = card.durationMs ? Math.round(card.durationMs / 1000) : null;
  const cost = card.costUsd && card.costUsd > 0 ? `$${card.costUsd.toFixed(2)}` : null;
  const verb =
    card.status === "success" ? "Consulted"
    : card.status === "cancelled" ? "Cancelled"
    : card.status === "timeout" ? "Timed out asking"
    : "Asked";
  const parts = [`${verb} ${name}`];
  if (secs !== null) parts.push(`${secs}s`);
  if (cost) parts.push(cost);
  if (card.truncated) parts.push("truncated");
  return (
    <div data-testid="sub-agent-consult-card" className="rounded-lg border border-(--color-border-primary) bg-(--color-bg-tertiary) px-3 py-1.5 text-xs text-(--color-text-tertiary)">
      {parts.join(" · ")}
    </div>
  );
}
