import type { WsServerMessage, WsQueueRow, ClaudeContentBlockToolUse } from "../shared/types.js";
import type { QueuedMessage, ChatMessageGroup, SteeredMessage, RecordedChatCard } from "./session-runner.js";
import { nextSendOrder, queueSnapshot } from "./queue-identity.js";
import { settleDroppedQueueEntries } from "./turn-settlement.js";
import { withoutHeldEntries } from "./held-turns.js";
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
  /**
   * docs/303 req 11 — the agent wrote or confirmed the status card this turn.
   * Sticky within the turn and reset with the rest of it, so a turn that writes
   * the card and then keeps working still counts as updated.
   */
  statusUpdated = false;
  /**
   * docs/303 req 13, 38 — this turn ended by asking the user something: a question card
   * or a plan to approve. Narrower than `wasInterrupted`, which a user stop also sets.
   */
  awaitingUserAnswer = false;

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
    msg.sendOrder ??= nextSendOrder();
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

  getQueueSnapshot(): WsQueueRow[] {
    return queueSnapshot(this._messageQueue);
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
    // Held turns are saved and come back with the next runner
    // (docs/322-question-holds-automatic-turns req 8).
    settleDroppedQueueEntries(withoutHeldEntries(this._messageQueue), "runner disposed");
    this._messageQueue.length = 0;
    this._turnEventBuffer = [];
  }
}
