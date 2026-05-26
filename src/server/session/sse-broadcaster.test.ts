/**
 * Tests for the worker's SseBroadcaster ring-buffer + replay behaviour.
 *
 * These cover the bug class fixed in the "spawned-child sessions stall
 * until opened" change: agent events MUST not be dropped when no SSE
 * client is attached, and a late-connecting client MUST be able to ask
 * for everything-since-seq-N so reconnects (and first-ever connects
 * after /agent/start) are lossless.
 */

import { describe, it, expect } from "vitest";
import { PassThrough } from "node:stream";
import type { ServerResponse } from "node:http";
import { SseBroadcaster, serializeSSEEvent } from "./sse-broadcaster.js";
import type { SseClient, WorkerSSEEvent } from "./sse-broadcaster.js";

// A PassThrough is enough — we just need `.write()` and the event
// surface that ServerResponse exposes. Casting once at the boundary
// keeps the tests honest about what the broadcaster actually uses.
function makeClient(): { client: SseClient; sink: PassThrough } {
  const sink = new PassThrough();
  const client: SseClient = { raw: sink as unknown as ServerResponse };
  return { client, sink };
}

function read(sink: PassThrough): string {
  return (sink.read() ?? Buffer.alloc(0)).toString("utf-8");
}

describe("SseBroadcaster ring buffer", () => {
  it("buffers events with no clients attached and replays them on attach", () => {
    const bc = new SseBroadcaster();

    // Emit BEFORE anyone attaches — this is the spawned-child scenario.
    bc.broadcast({ type: "agent_event", data: { phase: "init" } });
    bc.broadcast({ type: "agent_done", data: { exitCode: 0 } });

    expect(bc.bufferSize).toBe(2);
    expect(bc.latestSeq).toBe(2);

    // Late client attaches. `replaySince(0)` is the orchestrator-on-first-
    // connect call — give me everything you've got.
    const { client, sink } = makeClient();
    bc.attach(client);
    bc.replaySince(client, 0);

    const wire = read(sink);
    expect(wire).toContain("id: 1");
    expect(wire).toContain("event: agent_event");
    expect(wire).toContain("id: 2");
    expect(wire).toContain("event: agent_done");
  });

  it("replaySince(N) sends only events with seq > N", () => {
    const bc = new SseBroadcaster();
    bc.broadcast({ type: "agent_event", data: { i: 1 } });
    bc.broadcast({ type: "agent_event", data: { i: 2 } });
    bc.broadcast({ type: "agent_event", data: { i: 3 } });

    const { client, sink } = makeClient();
    bc.attach(client);
    bc.replaySince(client, 2);

    const wire = read(sink);
    expect(wire).not.toContain('"i":1');
    expect(wire).not.toContain('"i":2');
    expect(wire).toContain('"i":3');
    expect(wire).toContain("id: 3");
  });

  it("does NOT buffer terminal_data (high-volume, has its own replay)", () => {
    const bc = new SseBroadcaster();
    bc.broadcast({ type: "terminal_data", data: { data: "hi" } });
    bc.broadcast({ type: "terminal_data", data: { data: "there" } });
    bc.broadcast({ type: "agent_event", data: { phase: "go" } });

    expect(bc.bufferSize).toBe(1);
    expect(bc.latestSeq).toBe(1);

    const { client, sink } = makeClient();
    bc.attach(client);
    bc.replaySince(client, 0);

    const wire = read(sink);
    expect(wire).not.toContain("terminal_data");
    expect(wire).toContain("agent_event");
  });

  it("includes id: header in live broadcasts so reconnects can resume", () => {
    const bc = new SseBroadcaster();
    const { client, sink } = makeClient();
    bc.attach(client);

    bc.broadcast({ type: "agent_event", data: { ok: true } });
    const wire = read(sink);
    expect(wire.startsWith("id: 1\n")).toBe(true);
  });

  it("evicts oldest entries past capacity", () => {
    const bc = new SseBroadcaster({ bufferCapacity: 3 });
    for (let i = 1; i <= 5; i++) {
      bc.broadcast({ type: "agent_event", data: { i } });
    }
    expect(bc.bufferSize).toBe(3);
    expect(bc.latestSeq).toBe(5);

    const { client, sink } = makeClient();
    bc.attach(client);
    bc.replaySince(client, 0);

    const wire = read(sink);
    // Oldest 2 evicted; 3..5 remain.
    expect(wire).not.toContain('"i":1');
    expect(wire).not.toContain('"i":2');
    expect(wire).toContain('"i":3');
    expect(wire).toContain('"i":5');
  });

  it("serializeSSEEvent emits id: only when seq is provided", () => {
    const event: WorkerSSEEvent = { type: "agent_event", data: { a: 1 } };
    expect(serializeSSEEvent(event)).toBe('event: agent_event\ndata: {"a":1}\n\n');
    expect(serializeSSEEvent(event, 7)).toBe('id: 7\nevent: agent_event\ndata: {"a":1}\n\n');
  });
});
