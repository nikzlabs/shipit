// Live steering through the turn's private server (planning#707, docs/269-opencode-v2 req 6).
// A steer goes into the session's inbox and the running turn reads it at its next step
// boundary. Each steer ends, before `agent_result`, as exactly one `agent_steer_rejected`
// when it is known not to be in OpenCode (the orchestrator re-queues it), else as one
// `agent_user_replay`: the inbox is durable and the next turn reads a waiting item first,
// so a steer whose state is unknown is never lost, and re-queuing it could run it twice.

import type { AgentEvent } from "../agent-process.js";
import {
  cancelOpencode2InboxItem,
  readOpencode2Inbox,
  steerOpencode2Session,
  type FetchFn,
  type Opencode2Server,
} from "./server.js";

interface Steer {
  text: string;
  inboxId?: string;
  settled: boolean;
}

export class Opencode2Steering {
  private steers: Steer[] = [];
  private target: { server: Opencode2Server; sessionId: string } | null = null;
  private open = false;
  private check: Promise<void> = Promise.resolve();
  // One admission at a time, so steers reach the inbox in the order they were sent.
  private admitting: Promise<void> = Promise.resolve();

  constructor(
    private readonly emit: (event: AgentEvent) => void,
    private readonly fetchFn: FetchFn,
    private readonly log: (message: string) => void,
  ) {}

  /** A new turn. A compaction takes no steer. */
  begin(takesSteers: boolean): void {
    this.steers = [];
    this.target = null;
    this.open = takesSteers;
    this.check = Promise.resolve();
    this.admitting = Promise.resolve();
  }

  /** The turn has its prompt: steers held until now go in, in order. */
  ready(server: Opencode2Server, sessionId: string): void {
    if (!this.open || this.target) return;
    this.target = { server, sessionId };
    for (const steer of this.steers) this.post(steer);
  }

  send(text: string): void {
    if (!this.open) {
      this.emit({ type: "agent_steer_rejected", text });
      return;
    }
    const steer: Steer = { text, settled: false };
    this.steers.push(steer);
    if (this.target) this.post(steer);
  }

  /** At a step boundary a steer that left the inbox has been read. */
  noteStep(): void {
    if (!this.target) return;
    this.check = this.ackAfter(this.check);
  }

  /** Steers this turn read; they are user messages inside the turn. */
  readIds(): Set<string> {
    return new Set(this.steers.filter((s) => s.settled && s.inboxId).map((s) => s.inboxId ?? ""));
  }

  /** The turn's client is gone: settle every steer while the server still runs. */
  async close(): Promise<void> {
    this.open = false;
    await this.posted();
    await this.check;
    const target = this.target;
    const unsettled = this.steers.filter((s) => !s.settled);
    if (unsettled.length === 0) return;
    let inbox: Set<string> | null = null;
    if (target) {
      try {
        inbox = await readOpencode2Inbox(target.server, target.sessionId, this.fetchFn);
      } catch (err) {
        this.log(`could not read the inbox at the turn's end: ${describe(err)}`);
      }
    }
    for (const steer of unsettled) {
      if (!target || !steer.inboxId) {
        this.settle(steer, false);
        continue;
      }
      if (!inbox?.has(steer.inboxId)) {
        this.settle(steer, true);
        continue;
      }
      try {
        await cancelOpencode2InboxItem(target.server, target.sessionId, steer.inboxId, this.fetchFn);
        this.settle(steer, false);
      } catch (err) {
        this.log(`could not take a steer back: ${describe(err)}`);
        this.settle(steer, await this.stillWaiting(target, steer.inboxId));
      }
    }
  }

  // After a failed cancel: still in the inbox means the next turn reads it. Gone, or
  // unknown, re-queues it: running it twice is better than losing it.
  private async stillWaiting(target: { server: Opencode2Server; sessionId: string }, inboxId: string): Promise<boolean> {
    try {
      return (await readOpencode2Inbox(target.server, target.sessionId, this.fetchFn)).has(inboxId);
    } catch {
      return false;
    }
  }

  private post(steer: Steer): void {
    const target = this.target;
    if (target) this.admitting = this.admit(this.admitting, steer, target.server, target.sessionId);
  }

  private async admit(previous: Promise<void>, steer: Steer, server: Opencode2Server, sessionId: string): Promise<void> {
    await previous;
    try {
      steer.inboxId = await steerOpencode2Session(server, sessionId, steer.text, this.fetchFn);
    } catch (err) {
      this.log(`the server refused a steer: ${describe(err)}`);
      this.settle(steer, false);
    }
  }

  private async posted(): Promise<void> {
    await this.admitting;
  }

  private async ackAfter(previous: Promise<void>): Promise<void> {
    await previous;
    try {
      await this.ackRead();
    } catch (err) {
      this.log(`could not read the inbox: ${describe(err)}`);
    }
  }

  private async ackRead(): Promise<void> {
    await this.posted();
    const target = this.target;
    const posted = this.steers.filter((s) => !s.settled && s.inboxId);
    if (!target || posted.length === 0) return;
    const inbox = await readOpencode2Inbox(target.server, target.sessionId, this.fetchFn);
    for (const steer of posted) {
      if (!steer.settled && steer.inboxId && !inbox.has(steer.inboxId)) this.settle(steer, true);
    }
  }

  private settle(steer: Steer, read: boolean): void {
    if (steer.settled) return;
    steer.settled = true;
    if (!read) steer.inboxId = undefined;
    this.emit({ type: read ? "agent_user_replay" : "agent_steer_rejected", text: steer.text });
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
