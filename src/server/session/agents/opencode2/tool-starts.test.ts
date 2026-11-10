import { describe, it, expect, vi } from "vitest";
import { Opencode2ToolStarts, type Opencode2ToolStart } from "./tool-starts.js";

const SERVER = { url: "http://127.0.0.1:1", authorization: "Basic x" };

function streamOf(chunks: string[]): typeof fetch {
  return vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  }), { status: 200 })) as unknown as typeof fetch;
}

describe("Opencode2ToolStarts", () => {
  it("reads an event split across chunks and CRLF line ends", async () => {
    const started = `data: {"type":"session.tool.input.started","data":{"sessionID":"s","id":"c1","name":"shell"}}\r\n\r\n`;
    const called = `data: {"type":"session.tool.called","data":{"sessionID":"s","id":"c1","input":{"command":"ls"}}}\n\n`;
    const starts: Opencode2ToolStart[] = [];
    const subject = new Opencode2ToolStarts((s) => starts.push(s), streamOf([started.slice(0, 30), started.slice(30) + called.slice(0, 50), called.slice(50)]), () => {});
    await subject.open(SERVER);
    await new Promise((resolve) => setTimeout(resolve, 10));
    subject.setSession("s");
    expect(starts).toEqual([{ id: "c1", tool: "shell", input: { command: "ls" } }]);
  });

  it("reports a refused stream and goes on without starts", async () => {
    const log = vi.fn();
    const fetchFn = vi.fn(async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    const subject = new Opencode2ToolStarts(() => {}, fetchFn, log);
    await subject.open(SERVER);
    expect(log).toHaveBeenCalledWith("the tool-start stream returned HTTP 500");
  });
});
