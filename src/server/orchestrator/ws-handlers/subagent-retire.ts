/**
 * Wire the "background subagent finished" edge to the card it belongs to
 * (docs/109 reqs 10–11).
 *
 * The decision logic — which result may be rewritten, and to what — lives in
 * `orchestrator/subagent-completion.ts` and is shared with `ChatHistoryManager`.
 * This module is only the plumbing: find the card in the two places a
 * transcript row can live, and tell live viewers.
 */

import { projectToolResult } from "../transcript-projection.js";
import {
  buildRetiredSubagentResult,
  retireInCarriers,
  toTerminalStatus,
} from "../subagent-completion.js";
import type { BackgroundSubagentCompletion, RetiredSubagentHit } from "../subagent-completion.js";
import type { ChatHistoryManager } from "../chat-history.js";
import type { SessionRunnerInterface } from "../session-runner.js";
import type { WsServerMessage } from "../../shared/types.js";

export interface FinishedBackgroundSubagent extends Omit<BackgroundSubagentCompletion, "status"> {
  sessionId: string;
  /** The backend's raw status string; narrowed here, ignored if unrecognised. */
  status?: string;
}

/**
 * Replace a finished background subagent's launch acknowledgement with what it
 * reported, everywhere that copy exists, and push the result to viewers.
 *
 * ## Why both stores are patched, not one
 *
 * The launching turn may or may not still be open when the notification lands,
 * and the transcript row lives somewhere different in each case:
 *
 *  - **Turn still open** (verified as the common case — a short subagent's
 *    notification arrived 168ms *before* its launching turn's `result`; see the
 *    wire trace in `subagent-completion.ts`): the row is the runner's live
 *    `chatMessageGroups`. Patching only the database would be *undone*, because
 *    the next tool-result boundary's `replaceInProgress` deletes every
 *    `in_progress` row and re-inserts from that accumulator.
 *  - **Turn already finalized** (a long subagent): the accumulator has been
 *    reset and the row is committed history, so only the database has it.
 *
 * Neither store subsumes the other, so both are attempted and either hit is
 * enough. When both hit they converge on the same content, so the order is
 * irrelevant.
 *
 * Nothing here throws into the event listener: an unparseable status, a missing
 * card or a database failure all end as a no-op. This runs on a **self-woken**
 * turn, which skips the post-turn machinery entirely (docs/235 §6), so there is
 * no later pass to clean up after a throw here — but there is also nothing that
 * depends on it having run.
 */
export function retireFinishedBackgroundSubagent(
  chatHistory: ChatHistoryManager,
  runner: SessionRunnerInterface | null,
  emit: (msg: WsServerMessage) => void,
  finished: FinishedBackgroundSubagent,
): void {
  const status = toTerminalStatus(finished.status);
  if (!status) return;

  const completion: BackgroundSubagentCompletion = {
    toolUseId: finished.toolUseId,
    status,
    ...(finished.summary !== undefined ? { summary: finished.summary } : {}),
    ...(finished.usage ? { usage: finished.usage } : {}),
  };
  const built = buildRetiredSubagentResult(completion);

  let hit: RetiredSubagentHit | null = null;
  try {
    // The accumulator first, so a mid-turn notification is reflected in the
    // snapshot a reconnecting viewer gets even if the write below fails.
    if (runner) hit = retireInCarriers(runner.chatMessageGroups, completion, built);
    hit = chatHistory.retireBackgroundSubagentResult(finished.sessionId, completion, built) ?? hit;
  } catch (err) {
    console.error(
      `[subagent-retire] session=${finished.sessionId} tool=${finished.toolUseId}: ${String(err)}`,
    );
    return;
  }
  if (!hit) return;

  emit({
    type: "subagent_report_update",
    sessionId: finished.sessionId,
    toolUseId: finished.toolUseId,
    // Projected exactly as the serve path would (docs/244), so a long report
    // arrives clamped with the rest behind the modal's fetch — which resolves
    // against the row we just wrote.
    result: projectToolResult(
      finished.sessionId,
      { toolUseId: finished.toolUseId, content: hit.slot.content, ...(hit.slot.isError ? { isError: true } : {}) },
      hit.toolName,
    ),
  });
}
