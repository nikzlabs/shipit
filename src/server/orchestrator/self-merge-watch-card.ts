import type { SelfMergeWatchEnd } from "../shared/types.js";
import type { ChatHistoryManager, PersistedMessage } from "./chat-history.js";
import type { SessionRunnerRegistry } from "./session-runner.js";
import { persistCardTransition } from "./chat-card-persistence.js";

export interface SelfMergeWatchCardDeps {
  chatHistoryManager: ChatHistoryManager;
  runnerRegistry: Pick<SessionRunnerRegistry, "get">;
}

// docs/239 — the arm card of a watch that can no longer fire says so, live and after a reload.
// It never throws: a card that stays as it was must not stop an arm, a cancel or a wake.
export function endSelfMergeWatchCard(
  deps: SelfMergeWatchCardDeps,
  sessionId: string,
  watchId: string | undefined,
  ended: SelfMergeWatchEnd,
): void {
  if (!watchId) return;
  try {
    const card = deps.chatHistoryManager.findSelfMergeWatchCard(sessionId, watchId);
    if (!card) return;
    // The first end stays, except that a wake which was started can still fail.
    if (card.ended && !(card.ended === "merged" && ended === "wake-failed")) return;

    const updated = { ...card, ended };
    const write = () => {
      deps.chatHistoryManager.updateSelfMergeWatchCard(sessionId, watchId, { ended });
    };
    const runner = deps.runnerRegistry.get(sessionId);
    if (!runner) {
      write();
      return;
    }
    persistCardTransition(
      runner,
      { chatHistoryManager: deps.chatHistoryManager, sessionId },
      (m: PersistedMessage) => m.selfMergeWatch?.watchId === watchId,
      (m: PersistedMessage) => ({ ...m, selfMergeWatch: updated }),
      write,
    );
    runner.emitMessage({ type: "self_merge_watch_card", sessionId, card: updated });
  } catch (err) {
    console.error(`[merge-watch] could not mark the arm card of ${sessionId} as ${ended}:`, err);
  }
}
