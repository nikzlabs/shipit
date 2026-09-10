// Refresh merge state before turn admission; a merge detected mid-turn is too late to reset safely.
import type { SessionInfo } from "../../shared/types.js";
import type { GitManager } from "../../shared/git.js";
import type { PrStatusSummary } from "../../shared/types/github-types.js";
import { checkResetPreconditions } from "./pre-turn-reset.js";

export const MERGE_RECHECK_TIMEOUT_MS = 8_000;

/** An unsettled merge must not reset this turn: branch deletion may still be running. */
export type MergeRecheckOutcome = "unchanged" | "merged" | "unsettled";

export interface PreTurnMergeRecheckDeps {
  getSession: (id: string) => SessionInfo | undefined;
  getPrStatus: (id: string) => PrStatusSummary | null;
  createGitManager: (dir: string) => GitManager;
  /** Probe without arming verifiedAbsent, which would delay the next merge's detection. */
  verifyPrState: (sessionId: string) => Promise<void>;
  /** Wait for the merge callback, including the merged_at write and branch deletion. */
  awaitMergeHandling: (sessionId: string) => Promise<void>;
}

export async function recheckMergeBeforeTurn(
  deps: PreTurnMergeRecheckDeps,
  sessionId: string,
  sessionDir: string,
  opts: { timeoutMs?: number } = {},
): Promise<MergeRecheckOutcome> {
  try {
    const session = deps.getSession(sessionId);
    if (!session || session.mergedAt || !session.branch || !session.remoteUrl) return "unchanged";

    if (deps.getPrStatus(sessionId)?.prState !== "open") return "unchanged";

    const git = deps.createGitManager(sessionDir);

    // A missing remote ref may reflect deletion after merge; only a differing ref proves movement.
    const head = await git.getHeadHash();
    if (!head) return "unchanged";
    const remoteTip = await git.getRefHash(`origin/${session.branch}`);
    if (remoteTip && remoteTip !== head) return "unchanged";
    if (await checkResetPreconditions(session, git)) return "unchanged";

    try {
      await withTimeout(
        (async () => {
          await deps.verifyPrState(sessionId);
          await deps.awaitMergeHandling(sessionId);
        })(),
        opts.timeoutMs ?? MERGE_RECHECK_TIMEOUT_MS,
        sessionId,
      );
    } catch (err) {
      // merged_at is written before branch deletion; a reset here could race the pending delete.
      if (deps.getSession(sessionId)?.mergedAt) {
        console.warn(
          `[pre-turn-reset] merge recheck for ${sessionId} found the pull request merged but its `
            + "bookkeeping did not settle in time — skipping the branch reset for this turn rather "
            + "than racing the in-flight head-branch delete:",
          err,
        );
        return "unsettled";
      }
      throw err;
    }

    if (!deps.getSession(sessionId)?.mergedAt) return "unchanged";
    console.log(
      `[pre-turn-reset] merge observed at turn admission for ${sessionId} — the poller had not `
        + "seen it yet; the branch reset is decided against the fresh state",
    );
    return "merged";
  } catch (err) {
    console.warn(
      `[pre-turn-reset] merge recheck failed for ${sessionId} (running the turn on the poller's `
        + "last known state):",
      err,
    );
    return "unchanged";
  }
}

async function withTimeout(work: Promise<void>, ms: number, sessionId: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => { reject(new Error(`merge recheck for ${sessionId} exceeded ${ms}ms`)); },
          ms,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
