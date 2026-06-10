import type { WsAgentReviewAdded } from "../../../server/shared/types.js";
import { useSessionStore } from "../../stores/session-store.js";
import type { Handler } from "./types.js";

/**
 * docs/151 — the chat-native review subagent finished a review. Append an
 * inline `AgentReviewCard` to the chat transcript at the point the review
 * landed. The card opens a snapshot-mode FilePreviewModal showing the file
 * as the reviewer saw it; the snapshot + full comments are fetched lazily
 * on click via `GET /api/sessions/:sessionId/agent-reviews/:reviewId`.
 *
 * Deliberately does NOT touch `file-review-store`. AI findings now live in
 * their own immutable storage path (`agent_reviews`), not in the human draft
 * bucket that store backs.
 *
 * The card is persisted in chat history (recorded in-band via `emitChatCard`)
 * so the breadcrumb survives a session switch / full reload, not just a WS
 * reconnect. Idempotent by `reviewId`: persisted + buffered means a reconnect
 * can deliver it twice (history reload + buffer replay) — skip the duplicate.
 */
export const handleAgentReviewAdded: Handler<WsAgentReviewAdded> = (_ctx, data) => {
  const session = useSessionStore.getState();
  if (session.messages.some((m) => m.agentReview?.reviewId === data.reviewId)) return;
  session.setMessages((prev) =>
    prev.some((m) => m.agentReview?.reviewId === data.reviewId)
      ? prev
      : [
          ...prev,
          {
            role: "assistant" as const,
            text: "",
            agentReview: {
              reviewId: data.reviewId,
              filePath: data.filePath,
              fileType: data.fileType,
              findingCount: data.findingCount,
              snapshotHash: data.snapshotHash,
              ...(data.summary ? { summary: data.summary } : {}),
              createdAt: data.createdAt,
            },
          },
        ],
  );
};
