/**
 * Thread services — reads (list threads) and mutations (checkpoint creation).
 */

import type { GitManager } from "../git.js";
import type { ThreadManager } from "../threads.js";
import { ServiceError } from "./types.js";

// ---- Read operations ----

/** List threads for a session. */
export function listThreads(threadManager: ThreadManager, sessionId: string) {
  return threadManager.listThreads(sessionId);
}

// ---- Mutation operations ----

/** Create a checkpoint on the active thread. */
export async function createCheckpoint(
  git: GitManager,
  threadManager: ThreadManager,
  chatHistoryManager: { load: (sessionId: string) => unknown[] },
  sessionId: string,
  label?: string,
): Promise<{ checkpoint: unknown; threadId: string }> {
  const trimmedLabel = typeof label === "string" ? label.trim() : undefined;
  if (trimmedLabel !== undefined && trimmedLabel.length > 200) {
    throw new ServiceError(400, "Checkpoint label too long (max 200 characters)");
  }

  const commits = await git.log(1);
  const commitHash = commits.length > 0 ? commits[0].hash : "";
  const messages = chatHistoryManager.load(sessionId);

  const checkpoint = threadManager.createCheckpoint(
    sessionId,
    messages.length,
    commitHash,
    trimmedLabel || undefined,
  );

  if (!checkpoint) throw new ServiceError(400, "Failed to create checkpoint — no active thread");

  const activeThread = threadManager.getActiveThread(sessionId);
  return { checkpoint, threadId: activeThread?.id ?? "" };
}
