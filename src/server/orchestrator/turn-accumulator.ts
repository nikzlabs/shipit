import type { WsServerMessage, ClaudeContentBlockToolUse } from "../shared/types.js";
import type { QueuedMessage, ChatMessageGroup, SteeredMessage, RecordedChatCard } from "./session-runner.js";
import { settleDroppedQueueEntries } from "./turn-settlement.js";
import { createCommittedBodyIds } from "./transcript-projection.js";

const MAX_QUEUE_SIZE = 50;
const MAX_TURN_BUFFER = 1000;

export class TurnAccumulator {
  accumulatedText = "";
  accumulatedToolUse: ClaudeContentBlockToolUse[] = [];
  turnSummary = "";
  chatMessageGroups: ChatMessageGroup[] = [];
  needsNewMessageGroup = true;
  steeredMessages: SteeredMessage[] = [];
  recordedCards: RecordedChatCard[] = [];

  private _messageQueue: QueuedMessage[] = [];
  private _turnEventBuffer: WsServerMessage[] = [];
  lastPersistedBufferIndex = 0;
  readonly committedBodyIds = createCommittedBodyIds();

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
    // Settle discarded turns so their callers do not wait forever.
    settleDroppedQueueEntries(this._messageQueue, "queue cleared");
    this._messageQueue.length = 0;
  }

  getQueueSnapshot(): { text: string; position: number }[] {
    return this._messageQueue.map((item, idx) => ({ text: item.text, position: idx + 1 }));
  }

  getTurnEventBuffer(): WsServerMessage[] { return [...this._turnEventBuffer]; }

  clearTurnEventBuffer(): void {
    this._turnEventBuffer = [];
    this.lastPersistedBufferIndex = 0;
  }

  /** Buffer only; the caller must emit the message. */
  pushTurnEvent(msg: WsServerMessage): boolean {
    if (this._turnEventBuffer.length < MAX_TURN_BUFFER) {
      this._turnEventBuffer.push(msg);
      return true;
    }
    if (this._turnEventBuffer.length === MAX_TURN_BUFFER) {
      // Retain initialization events and the recent tail.
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

  reset(): void {
    settleDroppedQueueEntries(this._messageQueue, "runner disposed");
    this._messageQueue.length = 0;
    this._turnEventBuffer = [];
  }
}
