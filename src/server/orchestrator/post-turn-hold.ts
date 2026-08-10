/**
 * The post-turn liveness hold (planning#121 follow-up — the 2026-08-10 duplicate
 * CI-fix incident).
 *
 * A turn's terminal sequence runs AFTER `running` goes false. `tryDrain` clears
 * the flag so a queued turn can start, and only then does the executor run the
 * auto-commit, the PR flow, the release flow and the settlement. For the whole
 * of that window the runner reports `agentBusy === false`, so the idle enforcer
 * (a 30 s tick that consults exactly `agentBusy` + `viewerCount`) is free to
 * dispose the runner and destroy the container.
 *
 * In production that window is not theoretical: session 1cfb9c2c lost its
 * auto-push 31 ms after the commit landed, because `dispose()` clears the
 * debounced push timer, and its already-completed CI-fix turn was then settled
 * as `dropped` — "the turn never ran" — which re-fired the identical fix prompt
 * a minute later.
 *
 * This is the counter that closes it. It is deliberately NOT a bare boolean:
 *
 *   - **A counter**, because a turn handing off to a retry (a 401 heal, a quota
 *     failover) briefly has two live `executeAgentTurn` closures over one
 *     runner, and the outgoing one must not release the incoming one's hold.
 *   - **With a deadline**, because a hold that leaks is strictly worse than the
 *     bug it fixes: a session that can never be reclaimed pins a container for
 *     the lifetime of the orchestrator. Every `begin()` re-arms the deadline, so
 *     a sequence that hangs (a wedged PR round-trip) stops being counted as live
 *     work after {@link POST_TURN_HOLD_MAX_MS} instead of pinning the box.
 *
 * The executor pairs `begin`/`end` in a `finally`, so the deadline is a backstop
 * and never the ordinary exit.
 */

/**
 * How long a single post-turn sequence may hold the runner before the hold is
 * ignored. The sequence is a local `git add -A` + commit, one GitHub PR-status
 * round-trip, and the re-arm / release hooks — comfortably sub-second in the
 * normal case and a few seconds on a slow network. Two minutes is far above any
 * healthy value and far below "forever", which is the only property that
 * matters here.
 */
export const POST_TURN_HOLD_MAX_MS = 120_000;

export class PostTurnHold {
  private depth = 0;
  private deadline = 0;

  constructor(private readonly now: () => number = () => Date.now()) {}

  /**
   * Enter a terminal sequence. Re-arms the deadline.
   *
   * An EXPIRED depth is forfeited first. The deadline makes a leaked hold stop
   * *counting*, but the leaked depth itself survives, so without this the next
   * `begin()` would re-arm the deadline over it and the matching `end()` would
   * unwind only to the stale depth — leaving the hold active again and handing
   * every later turn the job of extending a lease nobody owns. Once a sequence
   * has outlived its deadline we have already decided not to trust it; the
   * honest move is to drop it rather than let it accumulate.
   */
  begin(): void {
    if (this.depth > 0 && this.now() >= this.deadline) this.depth = 0;
    this.depth++;
    this.deadline = this.now() + POST_TURN_HOLD_MAX_MS;
  }

  /** Leave a terminal sequence. Never underflows — an unbalanced end is a no-op. */
  end(): void {
    if (this.depth === 0) return;
    this.depth--;
    if (this.depth === 0) this.deadline = 0;
  }

  /** True while a terminal sequence is running and has not outlived its deadline. */
  get active(): boolean {
    return this.depth > 0 && this.now() < this.deadline;
  }

  /** Drop every hold (runner teardown). */
  reset(): void {
    this.depth = 0;
    this.deadline = 0;
  }
}
