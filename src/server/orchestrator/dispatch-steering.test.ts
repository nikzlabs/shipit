import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentId } from "../shared/types.js";
import { SessionRunner, type QueuedMessage, type SystemTurnDeps } from "./session-runner.js";
import { deliverWaitingMessages, prepareSteer, userMessageWaits } from "./dispatch-steering.js";
import {
  beginTurnSetup,
  noteCompactionTurn,
  noteTurnReady,
  setSteerRefused,
  steerRefused,
} from "./turn-stop-request.js";
import type { TurnOutcome } from "./turn-settlement.js";
import { testDispatch } from "./integration_tests/dispatch-test-helpers.js";
import { takeSessionHold } from "./session-hold.js";
import { requeueInSendOrder } from "./queue-identity.js";
import { steerToQueuedMessage } from "./ws-handlers/agent-message-builder.js";

// docs/329-user-steers-every-turn req 2 — what the user sent while no agent could read it
// goes into the turn that starts.
describe("deliverWaitingMessages", () => {
  let dir: string;
  let runner: SessionRunner;
  let sent: string[];
  let liveSteering: boolean;
  let received: { type: string; [key: string]: unknown }[];
  let afterWrite: () => void;
  let setPermissionMode: ReturnType<typeof vi.fn>;

  const deps = (): SystemTurnDeps => ({
    listenerDeps: { chatHistoryManager: { replaceInProgress: vi.fn(), finalizeInProgress: vi.fn(), append: vi.fn() } },
    steerInputs: () => ({ liveSteering, steeringCapable: true }),
  }) as unknown as SystemTurnDeps;

  const typed = (text: string, extra: Partial<QueuedMessage> = {}): QueuedMessage =>
    ({ text, execution: "interactive", ...extra });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-deliver-"));
    liveSteering = true;
    sent = [];
    received = [];
    runner = new SessionRunner({ sessionId: "s1", sessionDir: dir, defaultAgentId: "claude" as AgentId });
    runner.on("message", (m) => received.push(m as { type: string }));
    afterWrite = () => {};
    setPermissionMode = vi.fn();
    runner.setAgent({
      sendUserMessage: (t: string) => { sent.push(t); afterWrite(); },
      setPermissionMode,
      emit: () => true,
      kill: () => {},
    } as never);
    runner.running = true;
    runner.isStreamingActive = true;
    noteTurnReady(runner);
  });

  afterEach(() => {
    runner.dispose({ force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("writes the user's waiting messages to the agent in the order they were sent", async () => {
    runner.enqueue(typed("first"));
    runner.enqueue(typed("second"));

    await deliverWaitingMessages(runner, deps());

    expect(sent).toEqual(["first", "second"]);
    expect(runner.queueLength).toBe(0);
    expect(runner.steeredMessages.map((s) => s.text)).toEqual(["first", "second"]);
    expect(received.filter((m) => m.type === "message_steered").map((m) => m.text)).toEqual(["first", "second"]);
  });

  // planning#691 — the steer event is the bubble on every viewer, so the queue update that
  // goes before it adds none, and both name the session and the message.
  it("names the session, and gives the steer the id of the queue row it came from", async () => {
    runner.enqueue(typed("first", { clientRequestId: "r1" }));
    runner.enqueue(typed("second"));
    const secondId = runner.getQueueSnapshot()[1]?.id;

    await deliverWaitingMessages(runner, deps());

    const events = received.filter((m) => m.type === "queue_updated" || m.type === "message_steered");
    expect(events.map((m) => [m.type, m.sessionId, m.dequeued ?? m.clientRequestId])).toEqual([
      ["queue_updated", "s1", undefined],
      ["message_steered", "s1", "r1"],
      ["queue_updated", "s1", undefined],
      ["message_steered", "s1", secondId],
    ]);
    expect(runner.steeredMessages.map((s) => s.clientRequestId)).toEqual(["r1", secondId]);
  });

  it("puts the attachment on the steer event, for a viewer that has no bubble of its own", async () => {
    fs.writeFileSync(path.join(dir, "note.txt"), "words\n");
    runner.enqueue(typed("read this note", { files: [{ path: "note.txt" }] }));

    await deliverWaitingMessages(runner, deps());

    const steered = received.find((m) => m.type === "message_steered") as { files?: { path: string }[] } | undefined;
    expect(steered?.files?.map((f) => f.path)).toEqual(["note.txt"]);
  });

  it.each(["/compact", "/compact keep the API notes", "/goal ship the release"])(
    "leaves the harness command %s to a turn of its own",
    async (command) => {
      runner.enqueue(typed(command));
      runner.enqueue(typed("plain"));

      await deliverWaitingMessages(runner, deps());

      expect(sent).toEqual(["plain"]);
      expect(runner.messageQueue.map((m) => m.text)).toEqual([command]);
      expect(userMessageWaits(runner)).toBe(false);
    },
  );

  it("writes nothing after a Stop, though the turn still holds the runner", async () => {
    runner.enqueue(typed("waits"));

    const delivery = deliverWaitingMessages(runner, deps());
    runner.wasInterrupted = true;
    await delivery;

    expect(sent).toEqual([]);
    expect(runner.messageQueue.map((m) => m.text)).toEqual(["waits"]);
  });

  it("stops when the agent refuses a message, and does not send for that turn again", async () => {
    let refuse = true;
    runner.setAgent({
      sendUserMessage: (t: string) => { sent.push(t); },
      submissionSettled: () => (refuse ? Promise.reject(new Error("No agent running")) : Promise.resolve()),
      emit: () => true,
      kill: () => {},
    } as never);
    runner.enqueue(typed("first"));
    runner.enqueue(typed("second"));

    await deliverWaitingMessages(runner, deps());
    expect(sent).toEqual(["first"]);
    expect(runner.messageQueue.map((m) => m.text)).toEqual(["second"]);

    // The refused message comes back to the queue by its own path; nothing sends it again.
    requeueInSendOrder(runner, steerToQueuedMessage(runner.steeredMessages[0]!));
    refuse = false;
    await deliverWaitingMessages(runner, deps());
    expect(sent).toEqual(["first"]);

    // The next turn starts with a clean record, and the user's order (planning#691).
    runner.running = false;
    runner.running = true;
    noteTurnReady(runner);
    await deliverWaitingMessages(runner, deps());
    expect(sent).toEqual(["first", "first", "second"]);
  });

  it("keeps a message whose write throws, at its place in the queue", async () => {
    afterWrite = () => { throw new Error("the process is gone"); };
    const outcomes: TurnOutcome[] = [];
    runner.enqueue(typed("first", { onTurnComplete: (o) => outcomes.push(o) }));
    runner.enqueue(typed("second"));

    await expect(deliverWaitingMessages(runner, deps())).rejects.toThrow("the process is gone");

    expect(runner.messageQueue.map((m) => m.text)).toEqual(["first", "second"]);
    expect(runner.steeredMessages).toEqual([]);
    expect(outcomes).toEqual([]);
  });

  it("settles the handle of a written message even when the transcript cannot be saved", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = deps();
    (failing.listenerDeps.chatHistoryManager as unknown as { replaceInProgress: () => void }).replaceInProgress =
      () => { throw new Error("database connection is not open"); };
    const outcomes: TurnOutcome[] = [];
    runner.enqueue(typed("first", { onTurnComplete: (o) => outcomes.push(o) }));
    runner.enqueue(typed("second"));

    await deliverWaitingMessages(runner, failing);

    expect(sent).toEqual(["first", "second"]);
    expect(outcomes.map((o) => o.status)).toEqual(["steered"]);
    vi.restoreAllMocks();
  });

  it("waits for the agent's answer to one message before it writes the next, also when called again", async () => {
    let accept: () => void = () => {};
    const answered = new Promise<void>((resolve) => { accept = resolve; });
    runner.setAgent({
      sendUserMessage: (t: string) => { sent.push(t); },
      submissionSettled: () => answered,
      emit: () => true,
      kill: () => {},
    } as never);
    runner.enqueue(typed("first"));
    runner.enqueue(typed("second"));

    const delivery = deliverWaitingMessages(runner, deps());
    await vi.waitFor(() => expect(sent).toEqual(["first"]));
    // A second call, as an event of the agent makes, must not write past the open answer.
    await deliverWaitingMessages(runner, deps());
    expect(sent).toEqual(["first"]);

    accept();
    await delivery;
    expect(sent).toEqual(["first", "second"]);
  });

  it("stops when the harness refuses a message that the worker accepted", async () => {
    const first = typed("first");
    runner.enqueue(first);
    runner.enqueue(typed("second"));
    // What the listener of `agent_steer_rejected` does: the message is back in the queue,
    // ahead of the one the user sent after it (planning#691). Its steer keeps the entry's
    // send order.
    afterWrite = () => {
      setSteerRefused(runner, true);
      requeueInSendOrder(runner, { ...first });
    };

    await deliverWaitingMessages(runner, deps());

    expect(sent).toEqual(["first"]);
    expect(runner.messageQueue.map((m) => m.text)).toEqual(["first", "second"]);
  });

  it("leaves a turn of another source in the queue, and takes the user's message from behind it", async () => {
    runner.enqueue({ text: "a wake", execution: "dispatched", automatic: true });
    runner.enqueue({ text: "a child's first prompt", execution: "dispatched" });
    runner.enqueue(typed("from the user"));

    await deliverWaitingMessages(runner, deps());

    expect(sent).toEqual(["from the user"]);
    expect(runner.messageQueue.map((m) => m.text)).toEqual(["a wake", "a child's first prompt"]);
  });

  it("settles the handle of a delivered message as steered", async () => {
    const outcomes: TurnOutcome[] = [];
    runner.enqueue(typed("with a handle", { onTurnComplete: (o) => outcomes.push(o) }));

    await deliverWaitingMessages(runner, deps());

    expect(outcomes.map((o) => o.status)).toEqual(["steered"]);
  });

  it("delivers a message with its attachment", async () => {
    fs.writeFileSync(path.join(dir, "note.txt"), "the note's own words\n");
    runner.enqueue(typed("read this note", { files: [{ path: "note.txt" }] }));

    await deliverWaitingMessages(runner, deps());

    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("read this note");
    expect(sent[0]).toContain("the note's own words");
    expect(runner.steeredMessages[0]?.files?.[0]?.path).toBe("note.txt");
  });

  it("leaves a message that cannot be prepared in the queue, and delivers the next", async () => {
    runner.enqueue(typed("a missing file", { files: [{ path: "no-such-file.txt" }] }));
    runner.enqueue(typed("plain"));

    await deliverWaitingMessages(runner, deps());

    expect(sent).toEqual(["plain"]);
    expect(runner.messageQueue.map((m) => m.text)).toEqual(["a missing file"]);
  });

  it.each([
    ["the turn still sets up", () => { beginTurnSetup(runner); }],
    ["the turn is a compaction", () => { noteCompactionTurn(runner, true); }],
    ["no turn runs", () => { runner.running = false; }],
    ["Live steering is off", () => { liveSteering = false; }],
    ["the process takes no input", () => { runner.isStreamingActive = false; }],
    ["a merge is held", () => { runner.mergeHold = true; }],
  ])("delivers nothing when %s", async (_label, arrange) => {
    runner.enqueue(typed("waits"));
    arrange();

    await deliverWaitingMessages(runner, deps());

    expect(sent).toEqual([]);
    expect(runner.messageQueue.map((m) => m.text)).toEqual(["waits"]);
  });

  it("delivers into a turn that runs while ShipIt holds the session", async () => {
    takeSessionHold(runner);
    runner.enqueue(typed("waits"));

    await deliverWaitingMessages(runner, deps());

    expect(sent).toEqual(["waits"]);
  });

  it("writes nothing when the turn ends while the message is prepared", async () => {
    runner.enqueue(typed("waits"));

    // The delivery is past its first check and awaits the preparation.
    const delivery = deliverWaitingMessages(runner, deps());
    runner.running = false;
    await delivery;

    expect(sent).toEqual([]);
    expect(runner.messageQueue.map((m) => m.text)).toEqual(["waits"]);
  });

  it("stops when the turn ends while a message is prepared, and keeps that message", async () => {
    fs.writeFileSync(path.join(dir, "note.txt"), "words\n");
    runner.enqueue(typed("first"));
    runner.enqueue(typed("second", { files: [{ path: "note.txt" }] }));
    // The first write is the moment the turn ends: the second is prepared after it.
    afterWrite = () => { runner.running = false; };

    await deliverWaitingMessages(runner, deps());

    expect(sent).toEqual(["first"]);
    expect(runner.messageQueue.map((m) => m.text)).toEqual(["second"]);
  });

  it("does not write into the turn that replaced the one it started for", async () => {
    fs.writeFileSync(path.join(dir, "note.txt"), "words\n");
    runner.enqueue(typed("first"));
    runner.enqueue(typed("second", { files: [{ path: "note.txt" }] }));
    // A new turn claims the runner and is ready before the second message is prepared.
    afterWrite = () => {
      runner.running = false;
      runner.running = true;
      noteTurnReady(runner);
    };

    await deliverWaitingMessages(runner, deps());

    expect(sent).toEqual(["first"]);
    expect(runner.messageQueue.map((m) => m.text)).toEqual(["second"]);
  });

  it("applies the permission mode of the message", async () => {
    runner.enqueue(typed("in plan mode", { permissionMode: "plan" }));

    await deliverWaitingMessages(runner, deps());

    expect(setPermissionMode).toHaveBeenCalledWith("plan");
    expect(runner.appliedPermissionMode).toBe("plan");
  });
});

// The order of the user's own messages, when one of them still waits.
describe("a message of the user's behind one that waits", () => {
  let dir: string;
  let runner: SessionRunner;
  let sent: string[];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-deliver-order-"));
    sent = [];
    runner = new SessionRunner({ sessionId: "s1", sessionDir: dir, defaultAgentId: "claude" as AgentId });
    runner.setSystemTurnDeps({
      listenerDeps: { chatHistoryManager: { replaceInProgress: vi.fn(), finalizeInProgress: vi.fn(), append: vi.fn() } },
      steerInputs: () => ({ liveSteering: true, steeringCapable: true }),
    } as unknown as SystemTurnDeps);
    runner.setAgent({ sendUserMessage: (t: string) => { sent.push(t); }, emit: () => true, kill: () => {} } as never);
    runner.running = true;
    runner.isStreamingActive = true;
    noteTurnReady(runner);
    fs.writeFileSync(path.join(dir, "note.txt"), "words\n");
    runner.enqueue({ text: "the earlier request", execution: "interactive", files: [{ path: "note.txt" }] });
  });

  afterEach(() => {
    runner.dispose({ force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("joins the queue, and both reach the agent in the order they were sent", async () => {
    const handle = runner.dispatch(testDispatch({ text: "a newer correction", execution: "interactive" }));

    expect(handle.admitted).toBe("queued");
    expect(sent).toEqual([]);

    await vi.waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[0]).toContain("the earlier request");
    expect(sent[1]).toBe("a newer correction");
    expect((await handle.settled).status).toBe("steered");
    expect(runner.queueLength).toBe(0);
  });

  it("tries one time more after a refusal, when the user sends a new message", async () => {
    setSteerRefused(runner, true);

    runner.dispatch(testDispatch({ text: "a newer correction", execution: "interactive" }));

    await vi.waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[0]).toContain("the earlier request");
    expect(sent[1]).toBe("a newer correction");
    expect(steerRefused(runner)).toBe(false);
  });

  it("does not hold back a message from another source", () => {
    const handle = runner.dispatch(testDispatch({ text: "from a page", execution: "dispatched" }));

    expect(handle.admitted).toBe("steered");
    expect(sent).toEqual(["from a page"]);
  });
});

describe("prepareSteer", () => {
  it("reports a file that cannot be read, and writes nothing", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-steer-prep-"));
    try {
      const prepared = await prepareSteer(dir, { text: "look", files: [{ path: "absent.txt" }] });
      expect(prepared).toEqual({ error: expect.any(String) });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
