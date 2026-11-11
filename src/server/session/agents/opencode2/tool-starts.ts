// `run --format json` prints a tool call only once it has finished, so a long call stays
// invisible until then. The turn's server announces it as it starts; this reads that.

import type { FetchFn, Opencode2Server } from "./server.js";

export interface Opencode2ToolStart {
  id: string;
  tool: string;
  input: Record<string, unknown>;
}

// Verified on 2.2.5: `input.started` names the tool, `called` carries the parsed input.
const EVENT_TYPES = [
  "session.tool.input.started",
  "session.tool.called",
  "session.text.started",
  "session.text.ended",
  // A subagent call's progress names its child session.
  "session.tool.progress",
] as const;
const CONNECT_TIMEOUT_MS = 2_000;
const MAX_HELD = 100;

interface StreamEvent {
  type?: string;
  data?: {
    sessionID?: string;
    id?: string;
    name?: string;
    input?: unknown;
    assistantMessageID?: string;
    text?: string;
    metadata?: { sessionID?: unknown; status?: unknown };
  };
}

export class Opencode2ToolStarts {
  private controller: AbortController | null = null;
  private sessionId: string | undefined;
  private names = new Map<string, string>();
  // Held until `run`'s first line names the session, so `agent_init` goes first, and while
  // text written before the call is not yet on stdout: 2.2.5 ends that text just after the
  // call starts, and `run` prints text only once it has ended.
  private held: { sessionId: string; start: Opencode2ToolStart }[] = [];
  // Per assistant message: text parts started and not yet printed.
  private unprintedText = new Map<string, { sessionId: string; count: number }>();
  // Prints that beat their `session.text.started` here, so that start holds nothing.
  private printedAhead = new Map<string, number>();
  // Messages whose step end is printed: a text start for one arriving later holds nothing.
  private finishedMessages = new Set<string>();
  private heldSubagents: { sessionId: string; callId: string; childSessionId: string }[] = [];

  constructor(
    private readonly onStart: (start: Opencode2ToolStart) => void,
    private readonly fetchFn: FetchFn,
    private readonly log: (message: string) => void,
    private readonly onSubagent: (callId: string, childSessionId: string) => void = () => {},
  ) {}

  /** Resolves once the server has accepted the stream, or it failed; a failure only loses the early cards. */
  async open(server: Opencode2Server): Promise<void> {
    this.close();
    this.sessionId = undefined;
    this.names = new Map();
    this.held = [];
    this.unprintedText = new Map();
    this.printedAhead = new Map();
    this.finishedMessages = new Set();
    this.heldSubagents = [];
    const controller = new AbortController();
    this.controller = controller;
    const query = EVENT_TYPES.map((type) => `types=${encodeURIComponent(type)}`).join("&");
    let connected = (): void => {};
    const ready = new Promise<void>((resolve) => { connected = resolve; });
    const timer = setTimeout(connected, CONNECT_TIMEOUT_MS);
    void this.read(server, `/api/event?${query}`, controller, connected).finally(() => {
      clearTimeout(timer);
      connected();
    });
    await ready;
    clearTimeout(timer);
  }

  setSession(sessionId: string): void {
    if (this.sessionId) return;
    this.sessionId = sessionId;
    const held = this.heldSubagents;
    this.heldSubagents = [];
    for (const item of held) if (item.sessionId === sessionId) this.onSubagent(item.callId, item.childSessionId);
    this.release();
  }

  /** `run` printed a text part of this assistant message on stdout. */
  textPrinted(messageId: string): void {
    if (this.lessText(messageId)) this.release();
    else this.printedAhead.set(messageId, (this.printedAhead.get(messageId) ?? 0) + 1);
  }

  /** `run` printed the end of this message's step, so it printed all of its text it will print. */
  stepPrinted(messageId: string): void {
    this.finishedMessages.add(messageId);
    this.printedAhead.delete(messageId);
    if (this.unprintedText.delete(messageId)) this.release();
  }

  private lessText(messageId: string): boolean {
    const entry = this.unprintedText.get(messageId);
    if (!entry) return false;
    if (--entry.count <= 0) this.unprintedText.delete(messageId);
    return true;
  }

  private release(): void {
    if (this.sessionId === undefined) return;
    for (const entry of this.unprintedText.values()) if (entry.sessionId === this.sessionId) return;
    const held = this.held;
    this.held = [];
    for (const item of held) if (item.sessionId === this.sessionId) this.onStart(item.start);
  }

  close(): void {
    this.controller?.abort();
    this.controller = null;
  }

  private async read(server: Opencode2Server, path: string, controller: AbortController, connected: () => void): Promise<void> {
    try {
      const res = await this.fetchFn(`${server.url}${path}`, {
        headers: { Authorization: server.authorization, Accept: "text/event-stream" },
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        if (!res.ok) this.log(`the tool-start stream returned HTTP ${String(res.status)}`);
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let data: string[] = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        connected();
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const raw of lines) {
          const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
          if (line === "") {
            if (data.length > 0) this.handle(data.join("\n"));
            data = [];
          } else if (line.startsWith("data:")) {
            data.push(line.slice(line.startsWith("data: ") ? 6 : 5));
          }
        }
      }
    } catch (err) {
      if (!controller.signal.aborted) this.log(`the tool-start stream failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private handle(payload: string): void {
    let event: StreamEvent;
    try {
      event = JSON.parse(payload) as StreamEvent;
    } catch {
      return;
    }
    const data = event.data;
    const sessionId = data?.sessionID;
    const messageId = data?.assistantMessageID;
    if (event.type === "session.text.started" && sessionId && messageId) {
      if (this.finishedMessages.has(messageId)) return;
      const ahead = this.printedAhead.get(messageId) ?? 0;
      if (ahead > 0) {
        this.printedAhead.set(messageId, ahead - 1);
        return;
      }
      const entry = this.unprintedText.get(messageId);
      if (entry) entry.count++;
      else this.unprintedText.set(messageId, { sessionId, count: 1 });
      return;
    }
    // Empty text is never printed, so nothing waits for it.
    if (event.type === "session.text.ended") {
      if (messageId && !data?.text?.trim() && this.lessText(messageId)) this.release();
      return;
    }
    const id = data?.id;
    if (!id || !sessionId) return;
    if (event.type === "session.tool.progress") {
      const child = data.metadata?.sessionID;
      if (typeof child !== "string" || data.metadata?.status !== "running") return;
      if (this.sessionId === undefined) {
        if (this.heldSubagents.length < MAX_HELD) this.heldSubagents.push({ sessionId, callId: id, childSessionId: child });
      } else if (sessionId === this.sessionId) this.onSubagent(id, child);
      return;
    }
    const key = `${sessionId}\0${id}`;
    if (event.type === "session.tool.input.started") {
      if (typeof data.name === "string") this.names.set(key, data.name);
      return;
    }
    if (event.type !== "session.tool.called") return;
    const tool = this.names.get(key);
    this.names.delete(key);
    if (!tool) return;
    const input = typeof data.input === "object" && data.input !== null ? (data.input as Record<string, unknown>) : {};
    const start = { id, tool, input };
    if (this.held.length < MAX_HELD) this.held.push({ sessionId, start });
    this.release();
  }
}
