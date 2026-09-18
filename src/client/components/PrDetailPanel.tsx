

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

  const editable = card.phase === "open";

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <PrDetailHeader card={card} sessionId={sessionId} />
      <PrDescriptionSection sessionId={sessionId} body={card.pr.body} editable={editable} />
      <PrStatusSection sessionId={sessionId} card={card} />
      <PrConversationSection
        sessionId={sessionId}
        issueComments={card.issueComments}
        reviewThreads={card.reviewThreads}
      />
      <PrFilesSection sessionId={sessionId} baseBranch={card.pr.baseBranch} files={card.pr.files} />
    </div>
  );
}
