/**
 * planning#341 — keep the composer's "start from the latest base" control honest by
 * recomputing the `reset_eligible` signal when the WORKSPACE changes, not only
 * when a session activates, a turn ends, or a merge is detected.
 *
 * ## The false promise this closes
 *
 * `reset_eligible` is transient and was computed at exactly three moments
 * (activation, post-turn, merge detection). Nothing recomputed it in between —
 * so the moment anything dirtied the working tree of a merged, untouched
 * session, the client went on holding a `true` the server would no longer honour.
 * The user saw the checkbox, sent, and the pre-turn gate refused with
 * `dirty-tree`: the UI had promised an operation the server will not perform.
 *
 * The tree is dirtied by plenty of things the user does not think of as "work" —
 * a terminal command, a compose service that mounts the workspace read-write and
 * writes on a click (the motivating incident), a dev server materialising a
 * generated file. None of them ends a turn, so none of them refreshed the signal.
 *
 * ## Why the watcher, and not "re-validate at send time"
 *
 * The server ALREADY re-validates at send time — `autoResetMergedBranchOnContinue`
 * evaluates the full gate twice, and since planning#297 it reports the clause that
 * refused. Adding a second, client-driven pre-send validation would be a round
 * trip that changes nothing about correctness and still leaves the control
 * painted (and clickable) for as long as the user looks at it before sending.
 * The defect is that the *painted* control outlives the fact it depicts, so the
 * fix belongs where the fact changes: the file watcher already streams
 * `file_changes` from the worker into the runner, and pushing a fresh signal from
 * there is the same emit-only, recomputed-from-git shape the other three sites
 * use. Correctness stays server-side; this only stops the UI lying about it.
 *
 * ## Cost control
 *
 * `isResetEligible` shells out to git, and the watcher is chatty, so three gates
 * keep it cheap: it only schedules for sessions with a merged pull request (the
 * signal is a constant `false` for every other session, and that check is an
 * in-memory lookup); it debounces a burst into one recompute; and it skips while
 * a turn is running, because the agent rewrites files continuously and the
 * post-turn recompute fires immediately afterwards anyway. On top of that the
 * push is deduplicated against the last value this watcher sent — a watcher that
 * fires every few seconds against an unchanging answer should be silent, in the
 * transcript-adjacent WS stream and in the log alike.
 */

import type { WsServerMessage } from "../shared/types/ws-server-messages.js";
import type { ResetEligibleSignalDeps } from "./services/pre-turn-reset.js";
import { emitResetEligible } from "./services/pre-turn-reset.js";

/**
 * Long enough to collapse the burst a single `npm install`, `git checkout` or
 * editor save produces into one recompute; short enough that the control
 * disappears well before a user notices the file change and reaches for Send.
 */
export const RESET_ELIGIBLE_WATCH_DEBOUNCE_MS = 750;

/**
 * The slice of a runner this needs. Structural rather than
 * `Pick<SessionRunnerInterface, …>` so the tests can drive it with a bare
 * EventEmitter instead of standing up a container runner.
 */
export interface ResetEligibleWatchRunner {
  readonly sessionId: string;
  readonly sessionDir: string;
  /** True while a turn is in flight — see "Cost control" above. */
  readonly running: boolean;
  emitMessage(msg: WsServerMessage): void;
  on(event: "message", listener: (msg: WsServerMessage) => void): unknown;
  on(event: "disposed", listener: () => void): unknown;
}

/**
 * Recompute + push `reset_eligible` whenever the workspace file watcher reports
 * a change, debounced. Wired once per runner from `onRunnerCreated`; unwires
 * itself on `disposed` (the pending timer is cleared, so a disposed runner can
 * never be the thing that keeps the process's event loop alive).
 */
export function wireResetEligibleOnFileChange(
  deps: ResetEligibleSignalDeps,
  runner: ResetEligibleWatchRunner,
  opts: { debounceMs?: number } = {},
): void {
  const debounceMs = opts.debounceMs ?? RESET_ELIGIBLE_WATCH_DEBOUNCE_MS;
  let timer: NodeJS.Timeout | null = null;
  let disposed = false;
  /** The last value this watcher pushed, so an unchanged answer stays silent. */
  let lastEmitted: boolean | null = null;
  /** Guards against a slow git recompute overlapping the next debounce fire. */
  let inFlight = false;

  const recompute = (): void => {
    timer = null;
    if (disposed || inFlight) return;
    // The agent owns the tree while its turn runs and rewrites files
    // continuously; the post-turn recompute is authoritative and fires the
    // moment it ends, so nothing is lost by not shelling out to git here.
    if (runner.running) return;
    inFlight = true;
    void (async () => {
      try {
        lastEmitted = await emitResetEligible(deps, {
          sessionId: runner.sessionId,
          sessionDir: runner.sessionDir,
          origin: "file-change",
          emit: (msg) => {
            // A dispose that lands mid-recompute must not resurrect a signal for
            // a session whose runner is gone.
            if (!disposed) runner.emitMessage(msg);
          },
          previous: lastEmitted,
        });
      } catch (err) {
        // `emitResetEligible` is fail-safe, so this is belt-and-braces — but it
        // runs inside a timer callback, where a rejection is an unhandled one.
        console.error(`[pre-turn-reset] file-change eligibility recompute failed for ${runner.sessionId}:`, err);
      } finally {
        inFlight = false;
      }
    })();
  };

  runner.on("message", (msg: WsServerMessage) => {
    if (disposed || msg.type !== "files_changed") return;
    // Cheap-exit before scheduling anything: for a session with no merged pull
    // request the signal is a constant false, and this is the hot path — every
    // file the agent touches in every session arrives here.
    if (!deps.getSession(runner.sessionId)?.mergedAt) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(recompute, debounceMs);
    // Never hold the process open for a signal that only matters to a live viewer.
    timer.unref?.();
  });

  runner.on("disposed", () => {
    disposed = true;
    if (timer) clearTimeout(timer);
    timer = null;
  });
}
