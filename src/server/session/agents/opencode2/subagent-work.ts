// A subagent's own work, for its Work tab. Each subagent runs in a child session on the
// turn's server, which `run` does not print; its messages are read while it works and
// posted with `parentToolUseId` set to the call that launched it (verified on 2.2.5).

import type { AgentEvent } from "../agent-process.js";
import { listedToolPart } from "./background-subagents.js";
import { opencode2ToolResultEvent, opencode2ToolUseEvent } from "./opencode2-tool-normalizer.js";
import { readMessagesAfter, type FetchFn, type Opencode2Server } from "./server.js";

interface Child {
  callId: string;
  shownText: Set<string>;
  startedCalls: Set<string>;
  finishedCalls: Set<string>;
  /** The subagent finished: one more read, then it is dropped. */
  finished: boolean;
  /** The user message this call's work follows, fixed at the first read. */
  boundaryId?: string;
}

export class Opencode2SubagentWork {
  private server: Opencode2Server | null = null;
  private children = new Map<string, Child>();
  // Read to the end: a late progress event for one must not post its work again.
  private done = new Set<string>();
  private loop: Promise<void> | null = null;
  private stopped = false;
  private failureLogged = false;
  // A loop of an earlier turn may still be awaiting a read; it posts nothing.
  private generation = 0;

  constructor(
    private readonly emit: (event: AgentEvent) => void,
    private readonly fetchFn: FetchFn,
    private readonly log: (message: string) => void,
    private readonly pollMs: number,
    // The orchestrator drops nested work whose launching call it has not seen yet.
    private readonly callShown: (callId: string) => boolean,
  ) {}

  begin(server: Opencode2Server): void {
    this.generation++;
    this.server = server;
    this.children = new Map();
    this.done = new Set();
    this.loop = null;
    this.stopped = false;
    this.failureLogged = false;
  }

  track(childSessionId: string, callId: string): void {
    if (this.stopped || !this.server || this.children.has(childSessionId) || this.done.has(`${childSessionId}\0${callId}`)) return;
    this.children.set(childSessionId, {
      callId, shownText: new Set(), startedCalls: new Set(), finishedCalls: new Set(), finished: false,
    });
    this.loop ??= this.run(this.generation);
  }

  finish(childSessionId: string): void {
    const child = this.children.get(childSessionId);
    if (child) child.finished = true;
  }

  /** Reads every child once more while the server is up, then stops. */
  async close(): Promise<void> {
    for (const child of this.children.values()) child.finished = true;
    await this.loop;
    this.stop();
  }

  stop(): void {
    this.stopped = true;
    this.children = new Map();
    this.loop = null;
  }

  private live(generation: number): boolean {
    return !this.stopped && generation === this.generation;
  }

  private async run(generation: number): Promise<void> {
    while (this.live(generation) && this.children.size > 0) {
      for (const [sessionId, child] of [...this.children]) {
        const wasFinished = child.finished;
        if (this.callShown(child.callId)) await this.read(sessionId, child, generation);
        if (!this.live(generation)) return;
        if (wasFinished) {
          this.children.delete(sessionId);
          this.done.add(`${sessionId}\0${child.callId}`);
        }
      }
      if (this.children.size === 0 || !this.live(generation)) break;
      await new Promise((resolve) => setTimeout(resolve, this.pollMs));
    }
    if (generation === this.generation) this.loop = null;
  }

  private async read(sessionId: string, child: Child, generation: number): Promise<void> {
    const server = this.server;
    if (!server) return;
    let messages;
    try {
      const read = await readMessagesAfter(server, sessionId, this.fetchFn, child.boundaryId);
      messages = read.messages;
      child.boundaryId ??= read.boundaryId;
    } catch (err) {
      if (!this.failureLogged && this.live(generation)) {
        this.failureLogged = true;
        this.log(`could not read a subagent's work: ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }
    if (!this.live(generation)) return;
    for (const message of messages) {
      if (message.type !== "assistant" || !message.id) continue;
      const parts = message.content ?? [];
      const done = message.time?.completed !== undefined;
      parts.forEach((part, index) => {
        if (part.type === "text") {
          const key = `${message.id}:${String(index)}`;
          // Text is whole once its message is done or another part follows it.
          if (!part.text?.trim() || child.shownText.has(key) || (!done && index === parts.length - 1)) return;
          child.shownText.add(key);
          this.emit({ type: "agent_assistant", content: [{ type: "text", text: part.text }], parentToolUseId: child.callId });
          return;
        }
        const tool = listedToolPart(part);
        const status = tool?.state?.status;
        // Before `running` the input may still be arriving.
        if (!tool || child.finishedCalls.has(tool.id) || (status !== "running" && status !== "completed" && status !== "error")) return;
        if (!child.startedCalls.has(tool.id)) {
          child.startedCalls.add(tool.id);
          const input = typeof tool.state?.input === "object" && tool.state.input !== null
            ? (tool.state.input as Record<string, unknown>)
            : {};
          this.emit(opencode2ToolUseEvent(tool.id, tool.tool ?? "unknown", input, child.callId));
        }
        if (status === "completed" || status === "error") {
          child.finishedCalls.add(tool.id);
          this.emit(opencode2ToolResultEvent(tool.id, tool, child.callId));
        }
      });
    }
  }
}
