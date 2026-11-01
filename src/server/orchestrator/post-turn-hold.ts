export const POST_TURN_HOLD_MAX_MS = 120_000;

// Protect post-turn work after running clears. Count overlapping retry sequences;
// expire leaked holds so a hung sequence cannot prevent container cleanup forever.
export class PostTurnHold {
  private depth = 0;
  private deadline = 0;
  private generation = 0;

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** Returns the hold's generation, for a holder that can outlive the deadline (see `end`). */
  begin(): number {
    // Do not revive expired depth when a new sequence extends the deadline.
    if (this.depth > 0 && this.now() >= this.deadline) {
      this.depth = 0;
      this.generation++;
    }
    this.depth++;
    this.deadline = this.now() + POST_TURN_HOLD_MAX_MS;
    return this.generation;
  }

  /**
   * With a generation, ends nothing when that holder's depth was already written off as
   * expired: the count then belongs to whoever began afterwards.
   */
  end(generation?: number): void {
    if (generation !== undefined && generation !== this.generation) return;
    if (this.depth === 0) return;
    this.depth--;
    if (this.depth === 0) this.deadline = 0;
  }

  get active(): boolean {
    return this.depth > 0 && this.now() < this.deadline;
  }

  reset(): void {
    this.depth = 0;
    this.deadline = 0;
    this.generation++;
  }
}
