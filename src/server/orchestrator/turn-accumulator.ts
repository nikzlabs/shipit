/**
 * TurnAccumulator — owns per-turn runner state for ContainerSessionRunner.
 *
 * Holds the message queue, accumulated assistant text / tool-use blocks,
 * turn summary, chat-message-group log, and the turn-event WS buffer used
 * by reconnecting viewers to replay post-turn messages.
 *
 * Extracted from container-session-runner.ts so the runner class can focus
 * on lifecycle and worker plumbing. Behavior is unchanged — every public
 * method preserves the same observable semantics as the inlined version.
 *
 * The accumulator deliberately does NOT broadcast: WS-message emission is
 * still owned by the runner (which keeps the `EventEmitter` "message" event
 * contract intact). Callers use `pushTurnEvent` to add a message to the
 * replay buffer, then perform their own emit.
 */
import type { WsServerMessage, ClaudeContentBlockToolUse } from "../shared/types.js";
import type { QueuedMessage, ChatMessageGroup, SteeredMessage, RecordedVoiceNote } from "./session-runner.js";

const MAX_QUEUE_SIZE = 50;
const MAX_TURN_BUFFER = 1000;

export class TurnAccumulator {
  // Per-turn assistant accumulation
  accumulatedText = "";
  accumulatedToolUse: ClaudeContentBlockToolUse[] = [];
  turnSummary = "";
  chatMessageGroups: ChatMessageGroup[] = [];
  needsNewMessageGroup = true;
  steeredMessages: SteeredMessage[] = [];
  voiceNotes: RecordedVoiceNote[] = [];

  // Message queue
  private _messageQueue: QueuedMessage[] = [];

  // Turn-event replay buffer
  private _turnEventBuffer: WsServerMessage[] = [];
  lastPersistedBufferIndex = 0;

  // ---- Queue ----

  get messageQueue(): QueuedMessage[] { return this._messageQueue; }
  get queueLength(): number { return this._messageQueue.length; }

  enqueue(msg: QueuedMessage): number {
    if (this._messageQueue.length >= MAX_QUEUE_SIZE) {
      throw new Error(`Message queue is full (max ${MAX_QUEUE_SIZE})`);
    }
    this._messageQueue.push(msg);
    return this._messageQueue.length;
  }

  dequeue(): QueuedMessage | undefined {
    return this._messageQueue.shift();
  }

  clearQueue(): void {
    this._messageQueue.length = 0;
  }

  getQueueSnapshot(): { text: string; position: number }[] {
    return this._messageQueue.map((item, idx) => ({ text: item.text, position: idx + 1 }));
  }

  // ---- Turn event buffer ----

  getTurnEventBuffer(): WsServerMessage[] { return [...this._turnEventBuffer]; }

  clearTurnEventBuffer(): void {
    this._turnEventBuffer = [];
    this.lastPersistedBufferIndex = 0;
  }

  /**
   * Add a message to the replay buffer. Mirrors the eviction rules from
   * the original ContainerSessionRunner.emitMessage: under the cap, append;
   * exactly at the cap, evict the middle (keep first 10 init events +
   * recent tail) then append; over the cap, drop silently.
   *
   * Returns true if the message was buffered. The caller is responsible
   * for actually emitting the WS message to viewers.
   */
  pushTurnEvent(msg: WsServerMessage): boolean {
    if (this._turnEventBuffer.length < MAX_TURN_BUFFER) {
      this._turnEventBuffer.push(msg);
      return true;
    }
    if (this._turnEventBuffer.length === MAX_TURN_BUFFER) {
      const keep = 10;
      const recent = this._turnEventBuffer.length - keep;
      this._turnEventBuffer = [
        ...this._turnEventBuffer.slice(0, keep),
        ...this._turnEventBuffer.slice(recent),
        msg,
      ];
      return true;
    }
    return false;
  }

  /**
   * Drop the queue and turn-event buffer — used by dispose().
   *
   * Matches the original ContainerSessionRunner.dispose behavior: only the
   * queue and event buffer are explicitly cleared. The per-turn
   * accumulators (`accumulatedText`, `turnSummary`, etc.) are left as-is
   * — the runner is about to be discarded, so retaining their final values
   * for any in-flight consumer is intentional.
   */
  reset(): void {
    this._messageQueue.length = 0;
    this._turnEventBuffer = [];
  }
}
