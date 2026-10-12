import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentId } from "../shared/types.js";
import { SessionRunner, type QueuedMessage, type SystemTurnDeps } from "./session-runner.js";
import { deliverWaitingMessages, prepareSteer } from "./dispatch-steering.js";
import { beginTurnSetup, noteCompactionTurn, noteTurnReady } from "./turn-stop-request.js";
import type { TurnOutcome } from "./turn-settlement.js";

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
    // `dequeued` is what puts the bubble back in the transcript on the client.
    expect(received.filter((m) => m.type === "queue_updated").map((m) => m.dequeued)).toEqual(["first", "second"]);
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
    ["ShipIt's own operation holds the session", () => { runner.systemTurnInProgress = true; }],
    ["a merge is held", () => { runner.mergeHold = true; }],
  ])("delivers nothing when %s", async (_label, arrange) => {
    runner.enqueue(typed("waits"));
    arrange();

    await deliverWaitingMessages(runner, deps());

    expect(sent).toEqual([]);
    expect(runner.messageQueue.map((m) => m.text)).toEqual(["waits"]);
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
