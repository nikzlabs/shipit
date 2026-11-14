import { describe, it, expect, vi } from "vitest";
import type { AgentEvent } from "../agent-process.js";
import { Opencode2SubagentWork } from "./subagent-work.js";

// CLI 2.2.5 child-session messages (2026-11-11, DeepSeek), newest first, shortened ids.
const USER = { id: "msg_u", type: "user", text: "You are a subagent spawned by another session." };
const echoOne = (status: string) => ({
  type: "tool", id: "call_one", name: "shell",
  state: { status, input: { command: "echo one" }, ...(status === "completed" ? { content: [{ type: "text", text: "one\n" }] } : {}), metadata: {} },
});
const STEP_1 = { id: "msg_1", type: "assistant", time: { completed: 2 }, content: [{ type: "text", text: "Running it." }, echoOne("completed")] };
const STEP_2_OPEN = {
  id: "msg_2", type: "assistant", time: {},
  content: [
    { type: "text", text: "Now the slow o" },
  ],
};
const STEP_2_RUNNING = {
  id: "msg_2", type: "assistant", time: {},
  content: [
    { type: "text", text: "Now the slow one." },
    { type: "tool", id: "call_two", name: "shell", state: { status: "running", input: { command: "sleep 8 && echo two" }, metadata: {} } },
    { type: "tool", id: "call_three", name: "shell", state: { status: "pending", input: {} } },
  ],
};
const STEP_2_DONE = {
  id: "msg_2", type: "assistant", time: { completed: 9 },
  content: [
    { type: "text", text: "Now the slow one." },
    { type: "tool", id: "call_two", name: "shell", state: { status: "completed", input: { command: "sleep 8 && echo two" }, content: [{ type: "text", text: "two\n" }], metadata: {} } },
  ],
};

function harness(shown: (callId: string) => boolean = () => true) {
  let list: unknown[] = [];
  const fetchFn = vi.fn(async () => new Response(JSON.stringify({ data: list, cursor: {} }), { status: 200 })) as unknown as typeof fetch;
  const events: AgentEvent[] = [];
  const work = new Opencode2SubagentWork((e) => events.push(e), fetchFn, () => {}, 1, shown);
  work.begin({ url: "http://127.0.0.1:1", authorization: "Basic x" });
  return { work, events, fetchFn, set: (messages: unknown[]) => { list = messages; } };
}

const summary = (events: AgentEvent[]) => events.map((e) => {
  const block = ((e as { content: unknown[] }).content as { type: string; text?: string; id?: string; tool_use_id?: string }[])[0];
  const parent = (e as { parentToolUseId?: string }).parentToolUseId;
  return `${block.type}:${block.text ?? block.id ?? block.tool_use_id}@${parent ?? "-"}`;
});

describe("Opencode2SubagentWork", () => {
  it("posts a child's work under the launching call as it happens, each part once", async () => {
    const h = harness();
    h.set([STEP_2_OPEN, STEP_1, USER]);
    h.work.track("ses_child", "call_parent");
    await vi.waitFor(() => expect(h.events).toHaveLength(3));
    // The open message's only text may still be growing, so it waits.
    expect(summary(h.events)).toEqual(["text:Running it.@call_parent", "tool_use:call_one@call_parent", "tool_result:call_one@call_parent"]);

    h.set([STEP_2_RUNNING, STEP_1, USER]);
    await vi.waitFor(() => expect(h.events).toHaveLength(5));
    expect(summary(h.events).slice(3)).toEqual(["text:Now the slow one.@call_parent", "tool_use:call_two@call_parent"]);
    expect(h.events[4]).toMatchObject({ content: [{ name: "Bash", input: { command: "sleep 8 && echo two" } }] });

    h.set([{ id: "msg_idle", type: "idle" }, STEP_2_DONE, STEP_1, USER]);
    h.work.finish("ses_child", "call_parent");
    await h.work.close();
    expect(summary(h.events).slice(5)).toEqual(["tool_result:call_two@call_parent"]);
    expect(h.events[5]).toMatchObject({ content: [{ content: "two\n" }] });
  });

  it("reads a finished child once more on close, then stops reading", async () => {
    const h = harness();
    h.set([STEP_1, USER]);
    h.work.track("ses_child", "call_parent");
    h.work.finish("ses_child", "call_parent");
    await h.work.close();
    expect(h.events).toHaveLength(3);
    const reads = vi.mocked(h.fetchFn).mock.calls.length;
    h.work.track("ses_other", "call_other");
    await new Promise((r) => setTimeout(r, 10));
    expect(vi.mocked(h.fetchFn).mock.calls.length).toBe(reads);
  });

  it("waits for the launching call to be shown, and never hangs on one that is not", async () => {
    let shown = false;
    const h = harness(() => shown);
    h.set([STEP_1, USER]);
    h.work.track("ses_child", "call_parent");
    await new Promise((r) => setTimeout(r, 10));
    expect(h.events).toEqual([]);
    shown = true;
    await vi.waitFor(() => expect(h.events).toHaveLength(3));

    h.work.track("ses_hidden", "call_hidden");
    shown = false;
    await h.work.close();
  });

  it("keeps a call's work after a later user message in the child", async () => {
    const h = harness();
    h.set([STEP_1, USER]);
    h.work.track("ses_child", "call_parent");
    await vi.waitFor(() => expect(h.events).toHaveLength(3));
    h.set([STEP_2_DONE, { id: "msg_u2", type: "user", text: "A follow-up." }, STEP_1, USER]);
    await h.work.close();
    expect(summary(h.events).slice(3)).toEqual(["text:Now the slow one.@call_parent", "tool_use:call_two@call_parent", "tool_result:call_two@call_parent"]);
  });

  it("posts nothing from a read that returns after a stop, even once a new turn began", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const fetchFn = vi.fn(async () => {
      await gate;
      return new Response(JSON.stringify({ data: [STEP_1, USER], cursor: {} }), { status: 200 });
    }) as unknown as typeof fetch;
    const events: AgentEvent[] = [];
    const work = new Opencode2SubagentWork((e) => events.push(e), fetchFn, () => {}, 1, () => true);
    work.begin({ url: "http://127.0.0.1:1", authorization: "Basic x" });
    work.track("ses_child", "call_parent");
    await vi.waitFor(() => expect(vi.mocked(fetchFn)).toHaveBeenCalled());
    work.stop();
    work.begin({ url: "http://127.0.0.1:1", authorization: "Basic x" });
    // The new turn follows the same child; the old read must not drop it.
    work.track("ses_child", "call_next");
    release();
    await vi.waitFor(() => expect(events.length).toBeGreaterThan(0));
    expect(events.every((e) => (e as { parentToolUseId?: string }).parentToolUseId === "call_next")).toBe(true);
  });

  it.each([
    ["still followed", false],
    ["already read to the end", true],
  ])("posts a resumed child's new work under the resuming call when the first call is %s", async (_label, retired) => {
    const h = harness();
    h.set([STEP_1, USER]);
    h.work.track("ses_child", "call_parent");
    if (retired) h.work.finish("ses_child", "call_parent");
    await vi.waitFor(() => expect(h.events).toHaveLength(3));
    if (retired) await new Promise((r) => setTimeout(r, 10));
    h.set([STEP_2_DONE, { id: "msg_u2", type: "user", text: "Resume." }, STEP_1, USER]);
    h.work.track("ses_child", "call_resume");
    // The first launch's late progress and retirement must not take the resumed one over.
    h.work.track("ses_child", "call_parent");
    h.work.finish("ses_child", "call_parent");
    await new Promise((r) => setTimeout(r, 10));
    await h.work.close();
    expect(summary(h.events).slice(3)).toEqual(["text:Now the slow one.@call_resume", "tool_use:call_two@call_resume", "tool_result:call_two@call_resume"]);
  });

  it("posts each run's work under its own call when a read sees both", async () => {
    const h = harness();
    h.set([STEP_1, USER]);
    h.work.track("ses_child", "call_parent");
    await vi.waitFor(() => expect(h.events).toHaveLength(3));
    // The first run's last step was not read yet when the resume came.
    const TAIL = { id: "msg_1b", type: "assistant", time: { completed: 3 }, content: [{ type: "text", text: "First run tail." }] };
    h.work.track("ses_child", "call_resume");
    h.set([STEP_2_DONE, { id: "msg_u2", type: "user", text: "Resume." }, TAIL, STEP_1, USER]);
    await h.work.close();
    expect(summary(h.events).slice(3)).toEqual([
      "text:First run tail.@call_parent",
      "text:Now the slow one.@call_resume", "tool_use:call_two@call_resume", "tool_result:call_two@call_resume",
    ]);
  });

  it("posts a resumed run's work under the resuming call when the child is first read after the resume", async () => {
    let shown = false;
    const h = harness((callId) => shown || callId !== "call_resume");
    h.work.track("ses_child", "call_parent");
    h.work.track("ses_child", "call_resume");
    h.set([STEP_2_DONE, { id: "msg_u2", type: "user", text: "Resume." }, STEP_1, USER]);
    shown = true;
    await h.work.close();
    expect(summary(h.events)).toEqual(["text:Now the slow one.@call_resume", "tool_use:call_two@call_resume", "tool_result:call_two@call_resume"]);
  });

  it("does not post a finished child's work again when a late progress event names it", async () => {
    const h = harness();
    h.set([STEP_1, USER]);
    h.work.track("ses_child", "call_parent");
    h.work.finish("ses_child", "call_parent");
    await vi.waitFor(() => expect(h.events).toHaveLength(3));
    await new Promise((r) => setTimeout(r, 10));
    h.work.track("ses_child", "call_parent");
    await h.work.close();
    expect(h.events).toHaveLength(3);
  });
});
