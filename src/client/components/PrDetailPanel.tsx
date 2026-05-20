/**
 * PrDetailPanel — the body of the "PR" tab in the right-hand panel.
 *
 * docs/133: the inline drill-in destination for a session's pull request.
 * Rendered as the `rightTab === "pr"` branch in App.tsx. Reads from the same
 * `pr-store` slice as the inline `PrLifecycleCard`, so the two surfaces are
 * always consistent views of one model.
 *
 * Phase 1 + status scaffold: header, markdown description, status breakdown,
 * and a link to the existing diff viewer. Editing, conversation threads, and
 * the activity timeline are later phases (see the plan).
 */

import { GitPullRequestIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import { usePrStore } from "../stores/pr-store.js";
import { PrDetailHeader } from "./pr-detail/PrDetailHeader.js";
import { PrDescriptionSection } from "./pr-detail/PrDescriptionSection.js";
import { PrStatusSection } from "./pr-detail/PrStatusSection.js";
import { PrConversationSection } from "./pr-detail/PrConversationSection.js";
import { PrFilesSection } from "./pr-detail/PrFilesSection.js";

export function PrDetailPanel({ sessionId }: { sessionId: string }) {
  const card = usePrStore((s) => s.cardBySession[sessionId]);

  if (!card?.pr) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-(--color-text-tertiary)">
        <GitPullRequestIcon size={ICON_SIZE.LG} />
        <p className="text-sm">No pull request for this session yet.</p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <PrDetailHeader card={card} />
      <PrDescriptionSection body={card.pr.body} />
      <PrStatusSection sessionId={sessionId} card={card} />
      <PrConversationSection
        sessionId={sessionId}
        issueComments={card.issueComments}
        reviewThreads={card.reviewThreads}
      />
      <PrFilesSection sessionId={sessionId} baseBranch={card.pr.baseBranch} />
    </div>
  );
}
