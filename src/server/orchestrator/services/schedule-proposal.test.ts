import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseManager } from "../../shared/database.js";
import type { ScheduleRun, WsServerMessage } from "../../shared/types.js";
import { ChatHistoryManager } from "../chat-history.js";
import type { CredentialStore } from "../credential-store.js";
import { ScheduleProposalStore } from "../schedule-proposal-store.js";
import { ScheduleStore } from "../schedule-store.js";
import { SessionManager } from "../sessions.js";
import type { SessionRunnerInterface, SessionRunnerRegistry } from "../session-runner.js";
import { prepareCardOutcomeNotices } from "./card-kinds.js";
import {
  cancelScheduleProposal,
  confirmScheduleProposal,
  listSchedulesForAgent,
  proposeSchedule,
  type ScheduleProposalDeps,
} from "./schedule-proposal.js";
import { createSchedule, pauseSchedule } from "./schedules.js";

const SESSION = "sess-1";
const REPO = "https://github.com/o/r";

const NEW_SCHEDULE = `
name: Security PRs
when: weekdays 09:00
target: { repo: ${REPO} }
params:
  permissionMode: auto
  role: triage
prompt: |
  Check current security PRs.
  Merge the ones that pass.
`;

let db: DatabaseManager;
let history: ChatHistoryManager;
let store: ScheduleStore;
let proposals: ScheduleProposalStore;
let deps: ScheduleProposalDeps;
let emitted: WsServerMessage[];
let queued: string[];
let announced: number;
let roles: string[];
let runnerAttached: boolean;

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

beforeEach(() => {
  db = new DatabaseManager(":memory:");
  const sessions = new SessionManager(db);
  sessions.track(SESSION, "A session");
  sessions.track("sess-2", "Another session");
  history = new ChatHistoryManager(db);
  store = new ScheduleStore(db);
  proposals = new ScheduleProposalStore(db);
  emitted = [];
  queued = [];
  announced = 0;
  roles = ["triage"];
  runnerAttached = true;
  const runner = fakeRunner();
  const registry = { get: (id: string) => (id === SESSION && runnerAttached ? runner : undefined) };
  deps = {
    store,
    proposals,
    chatHistoryManager: history,
    sessionManager: sessions,
    getRunnerRegistry: () => registry as unknown as SessionRunnerRegistry,
    repoStore: { get: (url: string) => (url === REPO ? ({ url } as never) : undefined), isTrusted: () => true },
    credentialStore: {
      getRole: (name: string) => (roles.includes(name) ? { name } : undefined),
      getRoles: () => roles.map((name) => ({ name })),
      listSshHosts: () => [{ id: "host-1", label: "prod" }],
    } as unknown as CredentialStore,
    scheduler: {
      // Deferred, as the real queue is, so two clicks both pass the first check before either runs.
      enqueue: async <T>(key: string, fn: () => T | Promise<T>): Promise<T> => {
        queued.push(key);
        await Promise.resolve();
        return fn();
      },
      runNow: async (id: string) => ({ id: "run-1", scheduleId: id, slotAt: null, outcome: "starting" }) as ScheduleRun,
      stopRun: async () => null,
      unfinishedRuns: async () => [],
      unfinishedRunsNow: () => [],
      announceSchedules: () => { announced += 1; },
      viewRuns: (runs) => runs,
    },
  };
});

afterEach(() => {
  db.close();
});

function existingSchedule(over: Record<string, unknown> = {}) {
  return createSchedule(deps, {
    name: "Security PRs",
    timing: { kind: "daily", hour: 9, minute: 0 },
    timeZone: "Europe/Berlin",
    spec: {
      target: { kind: "sandbox", capabilities: { git: true, docker: false, network: true } },
      params: { permissionMode: "auto", sshHosts: ["host-1"] },
      prompt: "Check the PRs.",
    },
    ...over,
  });
}

describe("proposeSchedule — a new schedule", () => {
  it("posts a card with every value in ShipIt's words, and saves nothing", () => {
    const card = proposeSchedule(deps, SESSION, { text: NEW_SCHEDULE });

    expect(card).toMatchObject({
      kind: "create",
      name: "Security PRs",
      phase: "pending",
      timeZone: null,
      enabled: true,
      timing: { kind: "weekdays", hour: 9, minute: 0 },
      prompt: { after: "Check current security PRs.\nMerge the ones that pass." },
    });
    expect(card.values).toEqual([
      { label: "When", after: "Weekdays at 09:00" },
      { label: "Target", after: `Repository ${REPO}` },
      { label: "Role", after: "triage" },
      { label: "Permission mode", after: "Auto" },
      { label: "State", after: "Active" },
    ]);
    expect(store.list()).toEqual([]);
    expect(proposals.get(card.cardId)?.proposal).toMatchObject({ kind: "create", timeZone: null, enabled: true });
    expect(history.getDecisionCard("scheduleProposal", SESSION, card.cardId)).toEqual(card);
    expect(emitted).toEqual([{ type: "schedule_proposal_card", sessionId: SESSION, card }]);
  });

  it("names the zone when the proposal does, and describes a sandbox's grants", () => {
    const card = proposeSchedule(deps, SESSION, {
      text: "name: Nightly\nwhen: daily 02:30\ntimeZone: america/new_york\ntarget: { sandbox: { docker: true } }\n"
        + "params: { sshHosts: [host-1] }\nprompt: Tidy up.\nenabled: false\n",
    });
    expect(card.timeZone).toBe("America/New_York");
    expect(card.values).toEqual([
      { label: "When", after: "Every day at 02:30" },
      { label: "Time zone", after: "America/New_York" },
      { label: "Target", after: "Sandbox" },
      {
        label: "Sandbox grants",
        after: "GitHub access: off · Allow merging PRs: off · Docker access: on · Network access: on",
      },
      { label: "SSH destinations", after: "prod" },
      { label: "State", after: "Paused" },
    ]);
  });

  it("refuses what create would refuse, by name, and posts nothing", () => {
    const refusal = (text: string) => () => proposeSchedule(deps, SESSION, { text });
    expect(refusal("name: X\nwhen: daily 09:00\nprompt: P\n")).toThrow(/this proposal has no target/);
    expect(refusal(NEW_SCHEDULE.replace("triage", "nobody"))).toThrow('There is no role named "nobody".');
    expect(refusal(NEW_SCHEDULE.replace(REPO, "https://github.com/o/other"))).toThrow(/is not added to ShipIt/);
    expect(refusal(NEW_SCHEDULE.replace("weekdays 09:00", "{ cron: \"*/30 * * * *\" }")))
      .toThrow(/at least an hour apart/);
    expect(refusal(NEW_SCHEDULE.replace("weekdays 09:00", "every morning"))).toThrow(/when must be a preset/);
    expect(refusal(`${NEW_SCHEDULE}timeZone: Mars/Olympus\n`)).toThrow(/Unknown time zone/);
    expect(refusal(`${NEW_SCHEDULE}colour: blue\n`)).toThrow('Unknown field "colour".');
    expect(refusal("name: [unclosed")).toThrow(/not valid YAML/);
    expect(refusal(NEW_SCHEDULE.replace("permissionMode: auto", "permissionMode: yolo")))
      .toThrow(/"permissionMode" has a value it cannot take/);
    expect(emitted).toEqual([]);
    expect(db.db.prepare("SELECT COUNT(*) AS n FROM schedule_proposals").get()).toEqual({ n: 0 });
  });

  it("cannot post a card to a session with no runner", () => {
    runnerAttached = false;
    expect(() => proposeSchedule(deps, SESSION, { text: NEW_SCHEDULE })).toThrow(/not running/);
  });
});

describe("proposeSchedule — a change", () => {
  it("changes only the fields the YAML gives, each shown before → after", () => {
    const schedule = existingSchedule();
    const card = proposeSchedule(deps, SESSION, {
      id: schedule.id,
      text: "when: weekdays 10:00\ntarget: { sandbox: { docker: true } }\nparams: { sshHosts: null, model: null }\n",
    });

    expect(card).toMatchObject({
      kind: "update",
      scheduleId: schedule.id,
      name: "Security PRs",
      timing: { kind: "weekdays", hour: 10, minute: 0 },
      timeZone: "Europe/Berlin",
      enabled: true,
    });
    expect(card.prompt).toBeUndefined();
    expect(card.values).toEqual([
      { label: "When", before: "Every day at 09:00", after: "Weekdays at 10:00" },
      {
        label: "Sandbox grants",
        before: "GitHub access: on · Allow merging PRs: off · Docker access: off · Network access: on",
        after: "GitHub access: on · Allow merging PRs: off · Docker access: on · Network access: on",
      },
      { label: "SSH destinations", before: "prod", after: "Not set" },
    ]);
    const record = proposals.get(card.cardId);
    expect(record).toMatchObject({ scheduleId: schedule.id, baseUpdatedAt: schedule.updatedAt });
    expect(record?.proposal).toEqual({
      kind: "update",
      changes: {
        timing: { kind: "weekdays", hour: 10, minute: 0 },
        spec: {
          target: { kind: "sandbox", capabilities: { git: true, docker: true, network: true, dangerousGitHubOps: false } },
          params: { permissionMode: "auto" },
          prompt: "Check the PRs.",
        },
      },
    });
  });

  it("shows a new prompt against the old one", () => {
    const schedule = existingSchedule();
    const card = proposeSchedule(deps, SESSION, { id: schedule.id, text: "prompt: Check and merge.\nenabled: false\n" });
    expect(card.prompt).toEqual({ before: "Check the PRs.", after: "Check and merge." });
    expect(card.values).toEqual([{ label: "State", before: "Active", after: "Paused" }]);
    expect(card.enabled).toBe(false);
  });

  it("refuses an empty prompt and an unknown parameter, also when they are null", () => {
    const schedule = existingSchedule();
    expect(() => proposeSchedule(deps, SESSION, { id: schedule.id, text: "name: Other\nprompt: null\n" }))
      .toThrow("The prompt is empty.");
    expect(() => proposeSchedule(deps, SESSION, { id: schedule.id, text: "name: Other\nparams: { madeUp: null }\n" }))
      .toThrow('Unknown session-start parameter "madeUp".');
  });

  it("refuses a change that changes nothing, and an id that names no schedule", () => {
    const schedule = existingSchedule();
    expect(() => proposeSchedule(deps, SESSION, { id: schedule.id, text: "name: Security PRs\nwhen: daily 09:00\n" }))
      .toThrow("This proposal changes nothing");
    expect(() => proposeSchedule(deps, SESSION, { id: "nope", text: "name: X\n" }))
      .toThrow(/No schedule has the id "nope"/);
  });
});

describe("confirmScheduleProposal", () => {
  it("creates a new schedule in the browser's zone when the proposal names none", async () => {
    const card = proposeSchedule(deps, SESSION, { text: NEW_SCHEDULE });
    announced = 0;

    const result = await confirmScheduleProposal(deps, SESSION, card.cardId, "asia/tokyo");

    const [schedule] = store.list();
    expect(schedule).toMatchObject({ name: "Security PRs", timeZone: "Asia/Tokyo", enabled: true });
    expect(result).toMatchObject({ acted: true, card: { phase: "confirmed", scheduleId: schedule.id, timeZone: "Asia/Tokyo" } });
    expect(history.getDecisionCard("scheduleProposal", SESSION, card.cardId)).toEqual(result.card);
    expect(proposals.get(card.cardId)).toMatchObject({ phase: "confirmed", scheduleId: schedule.id });
    expect(queued).toEqual([`proposal:${card.cardId}`]);
    expect(announced).toBe(1);
    expect(emitted.at(-1)).toEqual({
      type: "schedule_proposal_update",
      sessionId: SESSION,
      cardId: card.cardId,
      card: result.card,
    });
  });

  it("keeps the zone the proposal names, and needs the browser's only when it names none", async () => {
    const named = proposeSchedule(deps, SESSION, { text: `${NEW_SCHEDULE}timeZone: Europe/Berlin\n` });
    await confirmScheduleProposal(deps, SESSION, named.cardId, "Asia/Tokyo");
    expect(store.list()[0]?.timeZone).toBe("Europe/Berlin");

    const unnamed = proposeSchedule(deps, SESSION, { text: NEW_SCHEDULE });
    await expect(confirmScheduleProposal(deps, SESSION, unnamed.cardId)).rejects.toThrow(/needs the browser's/);
    expect(proposals.get(unnamed.cardId)?.phase).toBe("pending");
  });

  it("applies a change through the schedule's queue, pausing it when the change says so", async () => {
    const schedule = existingSchedule();
    const card = proposeSchedule(deps, SESSION, { id: schedule.id, text: "when: weekdays 10:00\nenabled: false\n" });

    const result = await confirmScheduleProposal(deps, SESSION, card.cardId, "Asia/Tokyo");

    expect(result.card.phase).toBe("confirmed");
    expect(store.get(schedule.id)).toMatchObject({
      timing: { kind: "weekdays", hour: 10, minute: 0 },
      timeZone: "Europe/Berlin",
      enabled: false,
    });
    expect(queued).toEqual([schedule.id]);
  });

  it("refuses a change card whose schedule changed since it was written", async () => {
    const schedule = existingSchedule();
    const card = proposeSchedule(deps, SESSION, { id: schedule.id, text: "when: weekdays 10:00\n" });
    await pauseSchedule(deps, schedule.id);

    const result = await confirmScheduleProposal(deps, SESSION, card.cardId);

    expect(result.card.phase).toBe("stale");
    expect(store.get(schedule.id)?.timing).toEqual({ kind: "daily", hour: 9, minute: 0 });
  });

  it("refuses a change to a deleted schedule", async () => {
    const schedule = existingSchedule();
    const card = proposeSchedule(deps, SESSION, { id: schedule.id, text: "when: weekdays 10:00\n" });
    store.delete(schedule.id);

    const result = await confirmScheduleProposal(deps, SESSION, card.cardId);
    expect(result.card).toMatchObject({ phase: "refused", outcome: "The schedule was deleted after this card was written." });
  });

  it("checks again on Confirm, and a refusal saves nothing", async () => {
    const card = proposeSchedule(deps, SESSION, { text: NEW_SCHEDULE });
    roles = [];

    const result = await confirmScheduleProposal(deps, SESSION, card.cardId, "Europe/Berlin");

    expect(result.card).toMatchObject({ phase: "refused", outcome: 'There is no role named "triage".' });
    expect(store.list()).toEqual([]);
    expect(proposals.get(card.cardId)?.scheduleId).toBeUndefined();
  });

  it("acts once on two clicks", async () => {
    const card = proposeSchedule(deps, SESSION, { text: NEW_SCHEDULE });
    const [first, second] = await Promise.all([
      confirmScheduleProposal(deps, SESSION, card.cardId, "Europe/Berlin"),
      confirmScheduleProposal(deps, SESSION, card.cardId, "Europe/Berlin"),
    ]);
    expect([first.acted, second.acted].sort()).toEqual([false, true]);
    expect(store.list()).toHaveLength(1);
  });

  it("refuses a card of another session before anything is written", async () => {
    const card = proposeSchedule(deps, SESSION, { text: NEW_SCHEDULE });
    await expect(confirmScheduleProposal(deps, "sess-2", card.cardId, "Europe/Berlin"))
      .rejects.toThrow("That schedule proposal is not in this session.");
    expect(store.list()).toEqual([]);
  });
});

describe("cancelScheduleProposal", () => {
  it("ends the card, and a later Confirm saves nothing", async () => {
    const card = proposeSchedule(deps, SESSION, { text: NEW_SCHEDULE });
    expect(cancelScheduleProposal(deps, SESSION, card.cardId)).toMatchObject({ acted: true, card: { phase: "cancelled" } });

    const confirm = await confirmScheduleProposal(deps, SESSION, card.cardId, "Europe/Berlin");
    expect(confirm).toMatchObject({ acted: false, card: { phase: "cancelled" } });
    expect(store.list()).toEqual([]);
  });
});

describe("the outcome notice", () => {
  it("tells the agent the schedule id, and marks only what it carried", async () => {
    const created = proposeSchedule(deps, SESSION, { text: NEW_SCHEDULE });
    const cancelled = proposeSchedule(deps, SESSION, { text: NEW_SCHEDULE });
    proposeSchedule(deps, SESSION, { text: NEW_SCHEDULE });
    await confirmScheduleProposal(deps, SESSION, created.cardId, "Europe/Berlin");
    cancelScheduleProposal(deps, SESSION, cancelled.cardId);
    const scheduleId = store.list()[0]?.id;

    const notices = prepareCardOutcomeNotices({ chatHistoryManager: history, scheduleProposals: proposals }, SESSION);

    expect(notices).toHaveLength(1);
    expect(notices[0]?.cardIds).toEqual([created.cardId, cancelled.cardId]);
    expect(notices[0]?.notice).toContain("resolved schedule proposals you posted");
    expect(notices[0]?.notice).toContain(`confirmed; ShipIt created schedule \`${scheduleId}\`.`);
    expect(notices[0]?.notice).toContain("cancelled by the user. Nothing was saved.");
    expect(notices[0]?.notice).not.toContain("Security PRs");
    notices[0]?.delivered();
    expect(prepareCardOutcomeNotices({ chatHistoryManager: history, scheduleProposals: proposals }, SESSION)).toEqual([]);
  });
});

describe("listSchedulesForAgent", () => {
  it("lists each schedule in the YAML's words, with SSH destinations by id and not by label", () => {
    const schedule = existingSchedule();
    const [entry] = listSchedulesForAgent(deps);
    expect(entry).toMatchObject({
      id: schedule.id,
      name: "Security PRs",
      enabled: true,
      when: "daily 09:00",
      timeZone: "Europe/Berlin",
      target: "Sandbox",
      grants: "GitHub access: on · Allow merging PRs: off · Docker access: off · Network access: on",
      params: [
        { key: "permissionMode", label: "Permission mode", value: "Auto" },
        { key: "sshHosts", label: "SSH destinations", value: "host-1" },
      ],
      prompt: "Check the PRs.",
    });
    expect(entry?.nextRuns).toHaveLength(3);
  });
});
