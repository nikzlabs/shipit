import { describe, it, expect, vi } from "vitest";
import type { AgentEvent } from "../agent-process.js";
import { Opencode2Steering } from "./steering.js";
import type { Opencode2Server } from "./server.js";

const SERVER: Opencode2Server = { url: "http://127.0.0.1:1", authorization: "Basic x" };
const SESSION = "ses_1";

/** A server with a real inbox: a step boundary takes every item in it. */
function fakeServer(opts: {
  refusePrompt?: boolean;
  failInbox?: boolean;
  failDelete?: "kept" | "deleted";
  holdFirstPrompt?: Promise<void>;
} = {}) {
  const inbox = new Map<string, string>();
  const requests: { method: string; path: string; body?: unknown }[] = [];
  let next = 0;
  const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as { text: string } : undefined;
    requests.push({ method, path: url.pathname, ...(body ? { body } : {}) });
    if (url.pathname.endsWith("/prompt")) {
      if (opts.refusePrompt) return new Response("busy", { status: 500 });
      if (next === 0 && opts.holdFirstPrompt) await opts.holdFirstPrompt;
      const id = `msg_s${String(++next)}`;
      inbox.set(id, body?.text ?? "");
      return new Response(JSON.stringify({ data: { id, type: "user", delivery: "steer" } }), { status: 200 });
    }
    if (url.pathname.endsWith("/inbox") && method === "GET") {
      if (opts.failInbox) return new Response("down", { status: 503 });
      return new Response(JSON.stringify({ data: [...inbox.keys()].map((id) => ({ id })) }), { status: 200 });
    }
    if (method === "DELETE") {
      if (opts.failDelete === "kept") return new Response("down", { status: 503 });
      inbox.delete(decodeURIComponent(url.pathname.split("/").pop() ?? ""));
      if (opts.failDelete === "deleted") return new Response("lost", { status: 502 });
      return new Response(null, { status: 204 });
    }
    return new Response("", { status: 404 });
  }) as unknown as typeof fetch;
  return { fetchFn, inbox, requests, step: () => inbox.clear() };
}

function makeSteering(server: ReturnType<typeof fakeServer>) {
  const events: AgentEvent[] = [];
  const steering = new Opencode2Steering((e) => events.push(e), server.fetchFn, () => {});
  return { steering, events };
}

const settled = (events: AgentEvent[]) =>
  events.map((e) => ("text" in e ? `${e.type}:${e.text}` : e.type));

describe("Opencode2Steering", () => {
  it("holds a steer until the turn has its prompt, then admits it as a steer that starts no run", async () => {
    const server = fakeServer();
    const { steering } = makeSteering(server);
    steering.begin(true);
    steering.send("first");
    expect(server.requests).toHaveLength(0);

    steering.ready(SERVER, SESSION);
    await vi.waitFor(() => expect(server.inbox.size).toBe(1));
    expect(server.requests[0]).toEqual({
      method: "POST",
      path: `/api/session/${SESSION}/prompt`,
      body: { text: "first", delivery: "steer", resume: false },
    });
  });

  it("acknowledges a steer once a step boundary has taken it from the inbox, and only once", async () => {
    const server = fakeServer();
    const { steering, events } = makeSteering(server);
    steering.begin(true);
    steering.ready(SERVER, SESSION);
    steering.send("look at the tests too");
    await vi.waitFor(() => expect(server.inbox.size).toBe(1));

    steering.noteStep();
    await vi.waitFor(() => expect(server.requests.filter((r) => r.path.endsWith("/inbox"))).toHaveLength(1));
    expect(events).toEqual([]);

    server.step();
    steering.noteStep();
    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(settled(events)).toEqual(["agent_user_replay:look at the tests too"]);

    await steering.close();
    expect(events).toHaveLength(1);
    expect(server.requests.filter((r) => r.method === "DELETE")).toHaveLength(0);
  });

  it("at the turn's end acknowledges what was read and takes back what was not, so the next turn does not read it", async () => {
    const server = fakeServer();
    const { steering, events } = makeSteering(server);
    steering.begin(true);
    steering.ready(SERVER, SESSION);
    steering.send("read");
    await vi.waitFor(() => expect(server.inbox.size).toBe(1));
    server.step();
    steering.send("late");
    await vi.waitFor(() => expect(server.inbox.size).toBe(1));

    await steering.close();
    expect(settled(events)).toEqual(["agent_user_replay:read", "agent_steer_rejected:late"]);
    expect(server.inbox.size).toBe(0);
    expect(server.requests.filter((r) => r.method === "DELETE")).toHaveLength(1);
    expect(steering.readIds()).toEqual(new Set(["msg_s1"]));
  });

  it("refuses at once when the turn takes no steer, or has ended", async () => {
    const server = fakeServer();
    const { steering, events } = makeSteering(server);
    steering.begin(false);
    steering.send("into a compaction");
    expect(settled(events)).toEqual(["agent_steer_rejected:into a compaction"]);

    steering.begin(true);
    steering.ready(SERVER, SESSION);
    await steering.close();
    steering.send("after the end");
    expect(settled(events)).toEqual(["agent_steer_rejected:into a compaction", "agent_steer_rejected:after the end"]);
    expect(server.requests).toHaveLength(0);
  });

  it("refuses a steer the server did not admit, once", async () => {
    const server = fakeServer({ refusePrompt: true });
    const { steering, events } = makeSteering(server);
    steering.begin(true);
    steering.ready(SERVER, SESSION);
    steering.send("refused");
    await steering.close();
    expect(settled(events)).toEqual(["agent_steer_rejected:refused"]);
  });

  it("does not re-queue a steer whose state is unknown: the inbox keeps it for the next turn", async () => {
    const server = fakeServer({ failInbox: true });
    const { steering, events } = makeSteering(server);
    steering.begin(true);
    steering.ready(SERVER, SESSION);
    steering.send("unknown");
    await vi.waitFor(() => expect(server.inbox.size).toBe(1));
    await steering.close();
    expect(settled(events)).toEqual(["agent_user_replay:unknown"]);
    expect(server.requests.filter((r) => r.method === "DELETE")).toHaveLength(0);
  });

  it("does not re-queue a steer it could not take back, which the next turn reads", async () => {
    const server = fakeServer({ failDelete: "kept" });
    const { steering, events } = makeSteering(server);
    steering.begin(true);
    steering.ready(SERVER, SESSION);
    steering.send("stuck");
    await vi.waitFor(() => expect(server.inbox.size).toBe(1));
    await steering.close();
    expect(settled(events)).toEqual(["agent_user_replay:stuck"]);
  });

  it("re-queues a steer whose take-back went through though its answer failed", async () => {
    const server = fakeServer({ failDelete: "deleted" });
    const { steering, events } = makeSteering(server);
    steering.begin(true);
    steering.ready(SERVER, SESSION);
    steering.send("gone");
    await vi.waitFor(() => expect(server.inbox.size).toBe(1));
    await steering.close();
    expect(settled(events)).toEqual(["agent_steer_rejected:gone"]);
  });

  it("admits steers one at a time, in the order they were sent", async () => {
    let release = (): void => {};
    const server = fakeServer({ holdFirstPrompt: new Promise<void>((r) => { release = r; }) });
    const { steering } = makeSteering(server);
    steering.begin(true);
    steering.send("one");
    steering.send("two");
    steering.ready(SERVER, SESSION);
    await vi.waitFor(() => expect(server.requests).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(server.requests).toHaveLength(1);

    release();
    await vi.waitFor(() => expect(server.inbox.size).toBe(2));
    expect([...server.inbox.values()]).toEqual(["one", "two"]);
  });

  it("refuses a held steer when the turn never got going", async () => {
    const server = fakeServer();
    const { steering, events } = makeSteering(server);
    steering.begin(true);
    steering.send("held");
    await steering.close();
    expect(settled(events)).toEqual(["agent_steer_rejected:held"]);
    expect(server.requests).toHaveLength(0);
  });
});
