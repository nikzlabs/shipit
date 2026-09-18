export const POST_TURN_HOLD_MAX_MS = 120_000;

// Protect post-turn work after running clears. Count overlapping retry sequences;
// expire leaked holds so a hung sequence cannot prevent container cleanup forever.
export class PostTurnHold {
  private depth = 0;
  private deadline = 0;

  constructor(private readonly now: () => number = () => Date.now()) {}

  begin(): void {
    // Do not revive expired depth when a new sequence extends the deadline.
    if (this.depth > 0 && this.now() >= this.deadline) this.depth = 0;
    this.depth++;
    this.deadline = this.now() + POST_TURN_HOLD_MAX_MS;
  }

  end(): void {
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
  }
}
