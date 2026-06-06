import { ArrowsInLineVerticalIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import { formatTokenCount } from "../utils/model-info.js";
import type { CompactionCard as CompactionCardData } from "../../server/shared/types.js";

/**
 * docs/178 — inline "Context compacted" transcript card. Rendered when a chat
 * message carries a `compaction` payload (live from a `compaction_card` WS event
 * or rehydrated from persisted history).
 *
 * Both CLIs may compact unsolicited, and Codex supplies no token/duration
 * figures, so every detail is optional: the card always shows the headline and
 * fills in the before→after token delta and trigger ("/compact" vs automatic)
 * only when the backend reported them.
 */
export function CompactionCard({ card }: { card: CompactionCardData }) {
  const hasTokens =
    typeof card.preTokens === "number" && typeof card.postTokens === "number";
  const triggerLabel =
    card.trigger === "manual"
      ? "/compact"
      : card.trigger === "auto"
        ? "automatic"
        : undefined;

  return (
    <div
      className="flex items-center gap-2.5 rounded-lg border border-(--color-border-primary) bg-(--color-bg-tertiary) px-3 py-2 text-xs"
      data-testid="compaction-card"
    >
      <ArrowsInLineVerticalIcon
        size={ICON_SIZE.SM}
        className="shrink-0 text-(--color-context-ok)"
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-(--color-text-secondary)">
          <span className="font-medium text-(--color-text-primary)">Context compacted</span>
          {triggerLabel && (
            <span className="text-(--color-text-tertiary)">· {triggerLabel}</span>
          )}
        </div>
        {hasTokens && (
          <p className="mt-0.5 font-mono text-(--color-text-tertiary)">
            {formatTokenCount(card.preTokens!)} → {formatTokenCount(card.postTokens!)} tokens
          </p>
        )}
        {!hasTokens && (
          <p className="mt-0.5 text-(--color-text-tertiary)">
            Conversation history summarized to free up context.
          </p>
        )}
      </div>
    </div>
  );
}
