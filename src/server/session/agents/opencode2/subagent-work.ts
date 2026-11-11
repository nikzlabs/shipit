// A subagent's own work, for its Work tab. Each subagent runs in a child session on the
// turn's server, which `run` does not print; its messages are read while it works and
// posted with `parentToolUseId` set to the call that launched it (verified on 2.2.5).

import type { AgentEvent } from "../agent-process.js";
import { listedToolPart } from "./background-subagents.js";
import { opencode2ToolResultEvent, opencode2ToolUseEvent } from "./opencode2-tool-normalizer.js";
import { readTurnMessages, type FetchFn, type Opencode2Server } from "./server.js";

interface Child {
  callId: string;
  shownText: Set<string>;
  startedCalls: Set<string>;
  finishedCalls: Set<string>;
  /** The subagent finished: one more read, then it is dropped. */
  finished: boolean;
}

export class Opencode2SubagentWork {
  private server: Opencode2Server | null = null;
  private children = new Map<string, Child>();
  private loop: Promise<void> | null = null;
  private stopped = false;
  private failureLogged = false;

  constructor(
    private readonly emit: (event: AgentEvent) => void,
    private readonly fetchFn: FetchFn,
    private readonly log: (message: string) => void,
    private readonly pollMs: number,
  ) {}

  begin(server: Opencode2Server): void {
    this.server = server;
    this.children = new Map();
    this.loop = null;
    this.stopped = false;
    this.failureLogged = false;
  }

  track(childSessionId: string, callId: string): void {
    if (this.stopped || !this.server || this.children.has(childSessionId)) return;
    this.children.set(childSessionId, {
      callId, shownText: new Set(), startedCalls: new Set(), finishedCalls: new Set(), finished: false,
    });
    this.loop ??= this.run();
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
  }

  private async run(): Promise<void> {
    while (!this.stopped && this.children.size > 0) {
      for (const [sessionId, child] of [...this.children]) {
        const wasFinished = child.finished;
        await this.read(sessionId, child);
        if (wasFinished) this.children.delete(sessionId);
      }
      if (this.children.size === 0 || this.stopped) break;
      await new Promise((resolve) => setTimeout(resolve, this.pollMs));
    }
    this.loop = null;
  }

  private async read(sessionId: string, child: Child): Promise<void> {
    const server = this.server;
    if (!server) return;
    let messages;
    try {
      messages = await readTurnMessages(server, sessionId, this.fetchFn);
    } catch (err) {
      if (!this.failureLogged && !this.stopped) {
        this.failureLogged = true;
        this.log(`could not read a subagent's work: ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }
    if (this.stopped) return;
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
