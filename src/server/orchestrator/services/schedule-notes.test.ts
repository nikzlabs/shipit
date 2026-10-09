import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseManager } from "../../shared/database.js";
import type { WsServerMessage } from "../../shared/types.js";
import { ChatHistoryManager } from "../chat-history.js";
import { ScheduleNotes } from "../schedule-notes.js";
import { ScheduleNotesRequestStore } from "../schedule-notes-request-store.js";
import { ScheduleStore } from "../schedule-store.js";
import { SessionManager } from "../sessions.js";
import type { SessionRunnerInterface, SessionRunnerRegistry } from "../session-runner.js";
import { prepareCardOutcomeNotices } from "./card-kinds.js";
import {
  decideNotesAccess,
  NotesAccessNeeded,
  readNotesForAgent,
  readRunNoteFile,
  readRunNotes,
  type ScheduleNotesAccessDeps,
} from "./schedule-notes.js";
import { ServiceError } from "./types.js";

let tmp: string;
let db: DatabaseManager;
let sessions: SessionManager;
let history: ChatHistoryManager;
let store: ScheduleStore;
let requests: ScheduleNotesRequestStore;
let notes: ScheduleNotes;
let deps: ScheduleNotesAccessDeps;
let emitted: WsServerMessage[];
let scheduleA: string;
let scheduleB: string;
let runA: string;

function fakeRunner(): SessionRunnerInterface {
  return {
    emitMessage: (m: WsServerMessage) => { emitted.push(m); },
    running: false,
    chatMessageGroups: [],
    recordedCards: [],
    steeredMessages: [],
    getTurnEventBuffer: () => [],
    lastPersistedBufferIndex: 0,
  } as unknown as SessionRunnerInterface;
}

function newSchedule(name: string): string {
  return store.create({ name, timing: { kind: "daily", hour: 9, minute: 0 }, timeZone: "UTC", spec: {} }).id;
}

function caught(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error("expected a throw");
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "schedule-notes-svc-"));
  db = new DatabaseManager(":memory:");
  sessions = new SessionManager(db);
  history = new ChatHistoryManager(db);
  store = new ScheduleStore(db);
  requests = new ScheduleNotesRequestStore(db);
  notes = new ScheduleNotes(path.join(tmp, "schedules"));
  emitted = [];

  scheduleA = newSchedule("Security PRs");
  scheduleB = newSchedule("Dependency bumps");
  runA = store.insertRun({ scheduleId: scheduleA, slotAt: new Date("2026-10-06T09:00:00Z"), spec: {} })!.id;
  const dir = notes.prepareRun(scheduleA, runA, null);
  fs.writeFileSync(path.join(dir, "notes.md"), "# Yesterday\nMerged #12.\n");

  sessions.track("run-session", "Security PRs · Oct 7, 09:00");
  sessions.setScheduleRun("run-session", scheduleA, "run-today");
  sessions.track("other", "Some session");
  const runner = fakeRunner();
  const registry = { get: () => runner };
  deps = {
    store,
    notes,
    requests,
    chatHistoryManager: history,
    sessionManager: sessions,
    getRunnerRegistry: () => registry as unknown as SessionRunnerRegistry,
  };
});

afterEach(() => {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("the user's reads (req 27)", () => {
  it("lists a run's files with the schedule's name and the run's time, and reads one", () => {
    expect(readRunNotes(deps, scheduleA, runA)).toMatchObject({
      scheduleId: scheduleA,
      scheduleName: "Security PRs",
      runId: runA,
      runAt: "2026-10-06T09:00:00.000Z",
      files: [{ path: "notes.md", size: 24 }],
    });
    expect(readRunNoteFile(deps, scheduleA, runA, "notes.md").text).toBe("# Yesterday\nMerged #12.\n");
  });

  it("finds no run under another schedule, and no folder for a run that has none", () => {
    expect((caught(() => readRunNotes(deps, scheduleB, runA)) as ServiceError).statusCode).toBe(404);
    const bare = store.insertRun({ scheduleId: scheduleA, slotAt: null, spec: {} })!.id;
    expect((caught(() => readRunNotes(deps, scheduleA, bare)) as ServiceError).message).toBe("This run has no notes folder.");
  });
});

describe("the agent's read — readNotesForAgent", () => {
  it("lets a run of the schedule read every run's notes without asking (req 13)", () => {
    expect(readNotesForAgent(deps, "run-session", { schedule: scheduleA })).toEqual({
      schedule: { id: scheduleA, name: "Security PRs" },
      runs: [{ runId: runA, runAt: "2026-10-06T09:00:00.000Z", outcome: "starting" }],
      olderRuns: 0,
    });
    expect(readNotesForAgent(deps, "run-session", { schedule: scheduleA, run: runA, file: "notes.md" }))
      .toMatchObject({ file: { text: "# Yesterday\nMerged #12.\n" }, scheduleName: "Security PRs" });
    expect(emitted).toEqual([]);
  });

  it("asks the user once on a card, and returns at once, before any other session reads (req 28)", () => {
    const first = caught(() => readNotesForAgent(deps, "other", { schedule: scheduleA })) as NotesAccessNeeded;
    expect(first).toBeInstanceOf(NotesAccessNeeded);
    expect([first.statusCode, first.approval]).toEqual([403, "requested"]);
    expect(emitted).toEqual([{
      type: "schedule_notes_access_card",
      sessionId: "other",
      card: { cardId: first.cardId, scheduleId: scheduleA, scheduleName: "Security PRs", phase: "pending", createdAt: expect.any(String) },
    }]);
    expect(history.getDecisionCard("scheduleNotesAccess", "other", first.cardId)?.phase).toBe("pending");

    const again = caught(() => readNotesForAgent(deps, "other", { schedule: scheduleA, run: runA })) as NotesAccessNeeded;
    expect([again.approval, again.cardId]).toEqual(["pending", first.cardId]);
    expect(emitted).toHaveLength(1);
  });

  it("reads after Allow, and one approval covers only that schedule (req 30)", () => {
    const asked = caught(() => readNotesForAgent(deps, "other", { schedule: scheduleA })) as NotesAccessNeeded;
    const decided = decideNotesAccess(deps, "other", asked.cardId, "allow");
    expect(decided).toMatchObject({ acted: true, card: { phase: "allowed", resolvedAt: expect.any(String) } });
    expect(sessions.get("other")?.scheduleNotesGrants).toEqual([scheduleA]);
    expect(readNotesForAgent(deps, "other", { schedule: scheduleA, run: runA })).toMatchObject({
      notes: { files: [{ path: "notes.md" }] },
    });

    const otherSchedule = caught(() => readNotesForAgent(deps, "other", { schedule: scheduleB })) as NotesAccessNeeded;
    expect(otherSchedule.approval).toBe("requested");
    // A run of A is not a run of B either.
    expect((caught(() => readNotesForAgent(deps, "run-session", { schedule: scheduleB })) as NotesAccessNeeded).approval)
      .toBe("requested");
  });

  it("grants nothing on Deny, and a later ask posts a new card", () => {
    const asked = caught(() => readNotesForAgent(deps, "other", { schedule: scheduleA })) as NotesAccessNeeded;
    expect(decideNotesAccess(deps, "other", asked.cardId, "deny").card.phase).toBe("denied");
    expect(sessions.get("other")?.scheduleNotesGrants).toBeUndefined();
    const next = caught(() => readNotesForAgent(deps, "other", { schedule: scheduleA })) as NotesAccessNeeded;
    expect([next.approval, next.cardId === asked.cardId]).toEqual(["requested", false]);
  });

  it("acts on the first click only, and refuses a card from another session", () => {
    const asked = caught(() => readNotesForAgent(deps, "other", { schedule: scheduleA })) as NotesAccessNeeded;
    expect(decideNotesAccess(deps, "other", asked.cardId, "deny").acted).toBe(true);
    expect(decideNotesAccess(deps, "other", asked.cardId, "allow")).toMatchObject({ acted: false, card: { phase: "denied" } });
    expect(sessions.get("other")?.scheduleNotesGrants).toBeUndefined();
    expect((caught(() => decideNotesAccess(deps, "run-session", asked.cardId, "allow")) as ServiceError).statusCode).toBe(404);
  });

  it("lists the runs that have notes, newest first, however many runs were skipped since", () => {
    for (let i = 0; i < 120; i++) {
      store.insertRun({ scheduleId: scheduleA, slotAt: new Date(Date.UTC(2026, 9, 7, i % 24, i)), spec: {}, outcome: "skipped" });
    }
    const later = store.insertRun({ scheduleId: scheduleA, slotAt: new Date("2026-10-09T09:00:00Z"), spec: {} })!.id;
    notes.prepareRun(scheduleA, later, null);
    const read = readNotesForAgent(deps, "run-session", { schedule: scheduleA });
    expect("runs" in read && read.runs.map((r) => r.runId)).toEqual([later, runA]);
  });

  it("asks again when the pending card has left the transcript, as after a rewind past it", () => {
    const asked = caught(() => readNotesForAgent(deps, "other", { schedule: scheduleA })) as NotesAccessNeeded;
    history.saveMessages("other", []);
    const again = caught(() => readNotesForAgent(deps, "other", { schedule: scheduleA })) as NotesAccessNeeded;
    expect(again.approval).toBe("requested");
    expect(again.cardId).not.toBe(asked.cardId);
    expect(requests.get(asked.cardId)).toBeNull();
    expect(decideNotesAccess(deps, "other", again.cardId, "allow").card.phase).toBe("allowed");
  });

  it("refuses an unnamed or unknown schedule before asking anyone", () => {
    expect((caught(() => readNotesForAgent(deps, "other", {})) as ServiceError).statusCode).toBe(400);
    expect((caught(() => readNotesForAgent(deps, "other", { schedule: "gone" })) as ServiceError).statusCode).toBe(404);
    expect(emitted).toEqual([]);
  });

  it("tells the agent on its next turn what the user decided, once acknowledged", () => {
    const asked = caught(() => readNotesForAgent(deps, "other", { schedule: scheduleA })) as NotesAccessNeeded;
    decideNotesAccess(deps, "other", asked.cardId, "allow");
    const [notice] = prepareCardOutcomeNotices({ chatHistoryManager: history, scheduleNotesRequests: requests }, "other");
    expect(notice?.cardIds).toEqual([asked.cardId]);
    expect(notice?.notice).toContain(`shipit schedule notes ${scheduleA}`);
    notice!.delivered();
    expect(prepareCardOutcomeNotices({ chatHistoryManager: history, scheduleNotesRequests: requests }, "other")).toEqual([]);
  });
});
