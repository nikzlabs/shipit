// `run --format json` prints a tool call only once it has finished, so a long call stays
// invisible until then. The turn's server announces it as it starts; this reads that.

import type { FetchFn, Opencode2Server } from "./server.js";

export interface Opencode2ToolStart {
  id: string;
  tool: string;
  input: Record<string, unknown>;
}

// Verified on 2.2.5: `input.started` names the tool, `called` carries the parsed input.
const EVENT_TYPES = ["session.tool.input.started", "session.tool.called"] as const;
const CONNECT_TIMEOUT_MS = 2_000;
const MAX_HELD = 100;

interface StreamEvent {
  type?: string;
  data?: { sessionID?: string; id?: string; name?: string; input?: unknown };
}

export class Opencode2ToolStarts {
  private controller: AbortController | null = null;
  private sessionId: string | undefined;
  private names = new Map<string, string>();
  // Starts that arrive before `run`'s first line names the session, so `agent_init` goes first.
  private held: { sessionId: string; start: Opencode2ToolStart }[] = [];

  constructor(
    private readonly onStart: (start: Opencode2ToolStart) => void,
    private readonly fetchFn: FetchFn,
    private readonly log: (message: string) => void,
  ) {}

  /** Resolves once the server has accepted the stream, or it failed; a failure only loses the early cards. */
  async open(server: Opencode2Server): Promise<void> {
    this.close();
    this.sessionId = undefined;
    this.names = new Map();
    this.held = [];
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
    const held = this.held;
    this.held = [];
    for (const item of held) if (item.sessionId === sessionId) this.onStart(item.start);
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
    const id = data?.id;
    const sessionId = data?.sessionID;
    if (!id || !sessionId) return;
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
    if (this.sessionId === undefined) {
      if (this.held.length < MAX_HELD) this.held.push({ sessionId, start });
    } else if (sessionId === this.sessionId) {
      this.onStart(start);
    }
  }
}
