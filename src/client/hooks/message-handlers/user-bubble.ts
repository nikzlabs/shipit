import type { ChatMessage } from "../../components/MessageList.js";

type UserBubbleFields = Pick<
  ChatMessage,
  "images" | "files" | "uploadPaths" | "agentInterface" | "messageOrigin" | "userReview"
>;

/**
 * planning#691 — adds what a server event knows of a user message to its bubble. A viewer
 * that had the text alone gets the attachments; a bubble that has attachments keeps its own,
 * so the sender's composed bubble stays as it was drawn.
 */
export function fillUserBubble(bubble: ChatMessage, from: UserBubbleFields): ChatMessage {
  const filled = { ...bubble };
  if (!bubble.images?.length && !bubble.files?.length && !bubble.uploadPaths?.length) {
    if (from.images?.length) filled.images = from.images;
    if (from.files?.length) filled.files = from.files;
    if (from.uploadPaths?.length) filled.uploadPaths = from.uploadPaths;
  }
  if (!filled.agentInterface && from.agentInterface) filled.agentInterface = from.agentInterface;
  if (!filled.messageOrigin && from.messageOrigin) filled.messageOrigin = from.messageOrigin;
  if (!filled.userReview && from.userReview) filled.userReview = from.userReview;
  return filled;
}
