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
 * keep it cheap: it only recomputes for sessions with a merged pull request (the
 * signal is a constant `false` for every other session); it collapses a burst
 * into one recompute; and it skips while a turn is running, because the agent
 * rewrites files continuously and the post-turn recompute fires immediately
 * afterwards anyway.
 *
 * What it deliberately does NOT do is suppress a push whose value matches the one
 * it last sent. See {@link emitResetEligible} — the client holds one value per
 * session and takes whichever message arrived last, so a private "I already said
 * false" check reasons about state an unconditional emitter may have overwritten
 * since, and the suppressed push is precisely the one that would have corrected
 * it. The saving was one WS message, never the git work: the comparison could
 * only happen after the recompute.
 */

import { EventEmitter } from "node:events";
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
 * The ceiling on how long a change can be held back by *later* changes.
 *
 * A pure trailing-edge debounce starves: every `files_changed` cancels and
 * replaces the pending timer, so a writer producing changes more often than the
 * debounce window postpones the recompute forever and the control stays stale
 * indefinitely — the exact failure this module exists to prevent, reintroduced
 * by its own optimisation. That writer is not hypothetical here: the worker's
 * file watcher already collapses events on its own 300 ms trailing debounce
 * (`session/file-watcher.ts`), so anything writing on a 300–750 ms cadence
 * (a dev server, a test watcher, a compose service polling) emits a steady
 * stream of `files_changed` that never leaves a quiet window.
 *
 * So the debounce is capped: the recompute fires at the latest this long after
 * the FIRST change of a run, however many arrive behind it.
 */
export const RESET_ELIGIBLE_WATCH_MAX_WAIT_MS = 5_000;

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
  getMaxListeners(): number;
  setMaxListeners(n: number): unknown;
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
  opts: { debounceMs?: number; maxWaitMs?: number } = {},
): void {
  const debounceMs = opts.debounceMs ?? RESET_ELIGIBLE_WATCH_DEBOUNCE_MS;
  const maxWaitMs = opts.maxWaitMs ?? RESET_ELIGIBLE_WATCH_MAX_WAIT_MS;
  let timer: NodeJS.Timeout | null = null;
  let disposed = false;
  /** When the oldest change still waiting on the debounce arrived — see {@link RESET_ELIGIBLE_WATCH_MAX_WAIT_MS}. */
  let pendingSince: number | null = null;
  /** True while a recompute is awaiting git. */
  let inFlight = false;
  /** A change that landed during an in-flight recompute, which must not be dropped. */
  let missedWhileInFlight = false;

  const schedule = (delayMs: number): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(recompute, delayMs);
    // Never hold the process open for a signal that only matters to a live viewer.
    timer.unref?.();
  };

  function recompute(): void {
    timer = null;
    if (disposed) return;
    // A recompute already in flight read the tree BEFORE this change landed, so
    // its result may be stale the moment it publishes. Remember the change and
    // re-run once it settles, rather than dropping it and leaving the stale
    // value standing with nothing scheduled to correct it.
    if (inFlight) {
      missedWhileInFlight = true;
      return;
    }
    pendingSince = null;
    // The agent owns the tree while its turn runs and rewrites files
    // continuously; the post-turn recompute is authoritative and fires the
    // moment it ends, so nothing is lost by not shelling out to git here.
    if (runner.running) return;
    inFlight = true;
    void (async () => {
      try {
        await emitResetEligible(deps, {
          sessionId: runner.sessionId,
          sessionDir: runner.sessionDir,
          origin: "file-change",
          emit: (msg) => {
            // A dispose that lands mid-recompute must not resurrect a signal for
            // a session whose runner is gone.
            if (!disposed) runner.emitMessage(msg);
          },
        });
      } catch (err) {
        // `emitResetEligible` is fail-safe, so this is belt-and-braces — but it
        // runs inside a timer callback, where a rejection is an unhandled one.
        console.error(`[pre-turn-reset] file-change eligibility recompute failed for ${runner.sessionId}:`, err);
      } finally {
        inFlight = false;
        if (missedWhileInFlight) {
          missedWhileInFlight = false;
          if (!disposed) {
            pendingSince = Date.now();
            schedule(debounceMs);
          }
        }
      }
    })();
  }

  runner.on("message", (msg: WsServerMessage) => {
    if (disposed || msg.type !== "files_changed") return;
    // Cheap-exit before scheduling anything: for a session with no merged pull
    // request the signal is a constant false, and this is the hot path — every
    // file the agent touches in every session arrives here. (`getSession` is a
    // single indexed SQLite read, not a memory lookup, so it stays in front of
    // the timer rather than inside the recompute.)
    if (!deps.getSession(runner.sessionId)?.mergedAt) return;
    const now = Date.now();
    pendingSince ??= now;
    // Trailing-edge debounce, capped so a continuous writer cannot postpone the
    // recompute forever.
    schedule(Math.max(0, Math.min(debounceMs, pendingSince + maxWaitMs - now)));
  });

  runner.on("disposed", () => {
    disposed = true;
    missedWhileInFlight = false;
    if (timer) clearTimeout(timer);
    timer = null;
  });

  // Node warns at more than 10 listeners on one emitter, and each attached
  // viewer already registers up to two `message` listeners (the transport and
  // the preview-retry hook in `route-registry.ts`). This listener is permanent
  // and there is exactly one of it, so hand back exactly the slot it consumed —
  // otherwise a session with five open viewers starts printing a
  // MaxListenersExceededWarning that reads like a leak. Only when the emitter is
  // still on the default, so a deliberate ceiling set elsewhere is not stomped.
  if (runner.getMaxListeners() === EventEmitter.defaultMaxListeners) {
    runner.setMaxListeners(EventEmitter.defaultMaxListeners + 1);
  }
}
