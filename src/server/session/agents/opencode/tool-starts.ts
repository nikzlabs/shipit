// `run --format json` prints a tool call only once it has finished, so a long call stays
// invisible until then. A server's `/event` stream reports the call as it starts running.

import type { FetchFn } from "../opencode2/server.js";

export interface OpencodeToolStart {
  id: string;
  tool: string;
  input: Record<string, unknown>;
}

export interface OpencodeEventServer {
  url: string;
  authorization: string;
}

const CONNECT_TIMEOUT_MS = 2_000;
const MAX_HELD = 100;

interface StreamEvent {
  type?: string;
  properties?: {
    sessionID?: string;
    part?: {
      type?: string;
      id?: string;
      callID?: string;
      sessionID?: string;
      messageID?: string;
      tool?: string;
      text?: string;
      time?: { start?: number; end?: number };
      state?: { status?: string; input?: unknown };
    };
  };
}

export class OpencodeToolStarts {
  private controller: AbortController | null = null;
  private sessionId: string | undefined;
  // Verified on 1.19.5: `running` repeats while the call runs, so each call is reported once.
  private seen = new Set<string>();
  // Held until `run`'s first line names the session, so `agent_init` goes first, and while
  // text written before the call is not yet on stdout: 1.19.5 closes that text just after
  // the call starts, and `run` prints text only once it is closed.
  private held: { sessionId: string; start: OpencodeToolStart }[] = [];
  private unprintedText = new Map<string, { sessionId: string; messageId: string | undefined }>();
  private printedText = new Set<string>();
  // Messages whose step end is printed: a text event for one arriving later holds nothing.
  private finishedMessages = new Set<string>();

  constructor(
    private readonly onStart: (start: OpencodeToolStart) => void,
    private readonly fetchFn: FetchFn,
    private readonly log: (message: string) => void,
  ) {}

  /** Resolves once the server has accepted the stream, or it failed; a failure only loses the early cards. */
  async open(server: OpencodeEventServer): Promise<void> {
    this.close();
    this.sessionId = undefined;
    this.seen = new Set();
    this.held = [];
    this.unprintedText = new Map();
    this.printedText = new Set();
    this.finishedMessages = new Set();
    const controller = new AbortController();
    this.controller = controller;
    let connected = (): void => {};
    const ready = new Promise<void>((resolve) => { connected = resolve; });
    const timer = setTimeout(connected, CONNECT_TIMEOUT_MS);
    void this.read(server, controller, connected).finally(() => {
      clearTimeout(timer);
      connected();
    });
    await ready;
    clearTimeout(timer);
  }

  setSession(sessionId: string): void {
    if (this.sessionId) return;
    this.sessionId = sessionId;
    this.release();
  }

  /** `run` printed this text part on stdout. */
  textPrinted(partId: string): void {
    this.printedText.add(partId);
    if (this.unprintedText.delete(partId)) this.release();
  }

  /** `run` printed the end of this message's step, so it printed all of its text it will print. */
  stepPrinted(messageId: string): void {
    this.finishedMessages.add(messageId);
    let changed = false;
    for (const [partId, text] of this.unprintedText) {
      if (text.messageId !== messageId) continue;
      this.unprintedText.delete(partId);
      changed = true;
    }
    if (changed) this.release();
  }

  private release(): void {
    if (this.sessionId === undefined) return;
    for (const text of this.unprintedText.values()) if (text.sessionId === this.sessionId) return;
    const held = this.held;
    this.held = [];
    for (const item of held) if (item.sessionId === this.sessionId) this.onStart(item.start);
  }

  close(): void {
    this.controller?.abort();
    this.controller = null;
  }

  private async read(server: OpencodeEventServer, controller: AbortController, connected: () => void): Promise<void> {
    try {
      const res = await this.fetchFn(`${server.url}/event`, {
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
    if (event.type !== "message.part.updated") return;
    const part = event.properties?.part;
    if (part?.type === "text") {
      this.noteText(part, event.properties?.sessionID);
      return;
    }
    if (part?.type !== "tool" || part.state?.status !== "running" || typeof part.tool !== "string") return;
    // Stdout's `tool_use` names the call by `callID`, falling back to `id`.
    const id = part.callID ?? part.id;
    const sessionId = part.sessionID ?? event.properties?.sessionID;
    if (!id || !sessionId) return;
    const key = `${sessionId}\0${id}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    const raw = part.state.input;
    const input = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
    const start = { id, tool: part.tool, input };
    if (this.held.length < MAX_HELD) this.held.push({ sessionId, start });
    this.release();
  }

  private noteText(part: NonNullable<NonNullable<StreamEvent["properties"]>["part"]>, eventSession?: string): void {
    const sessionId = part.sessionID ?? eventSession;
    // A prompt part has no time; empty text is never shown, so nothing waits for it.
    if (!part.id || !sessionId || part.time?.start === undefined || this.printedText.has(part.id)) return;
    if (part.messageID !== undefined && this.finishedMessages.has(part.messageID)) return;
    if (part.time.end !== undefined && !part.text?.trim()) {
      if (this.unprintedText.delete(part.id)) this.release();
    } else {
      this.unprintedText.set(part.id, { sessionId, messageId: part.messageID });
    }
  }
}
