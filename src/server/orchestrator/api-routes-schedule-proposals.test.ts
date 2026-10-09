import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { DatabaseManager } from "../shared/database.js";
import type { ScheduleProposalCard, ScheduleRun } from "../shared/types.js";
import { ChatHistoryManager } from "./chat-history.js";
import type { CredentialStore } from "./credential-store.js";
import { ScheduleProposalStore } from "./schedule-proposal-store.js";
import { ScheduleStore } from "./schedule-store.js";
import { SessionManager } from "./sessions.js";
import type { SessionRunnerInterface, SessionRunnerRegistry } from "./session-runner.js";
import { registerScheduleProposalRoutes } from "./api-routes-schedule-proposals.js";

const SESSION = "sess-1";
const PROPOSAL = "name: Nightly\nwhen: daily 02:00\ntarget: sandbox\nprompt: Tidy up.\n";

let app: FastifyInstance;
let db: DatabaseManager;
let store: ScheduleStore;

beforeEach(async () => {
  db = new DatabaseManager(":memory:");
  const sessions = new SessionManager(db);
  sessions.track(SESSION, "A session");
  store = new ScheduleStore(db);
  const runner = {
    emitMessage: () => undefined,
    running: false,
    chatMessageGroups: [],
    recordedCards: [],
    steeredMessages: [],
    getTurnEventBuffer: () => [],
    lastPersistedBufferIndex: 0,
  } as unknown as SessionRunnerInterface;
  const registry = { get: (id: string) => (id === SESSION ? runner : undefined) } as unknown as SessionRunnerRegistry;
  app = Fastify();
  registerScheduleProposalRoutes(app, {
    store,
    proposals: new ScheduleProposalStore(db),
    chatHistoryManager: new ChatHistoryManager(db),
    sessionManager: sessions,
    getRunnerRegistry: () => registry,
    repoStore: { get: () => undefined, isTrusted: () => true },
    credentialStore: { getRole: () => undefined, listSshHosts: () => [] } as unknown as CredentialStore,
    scheduler: {
      enqueue: async <T>(_key: string, fn: () => T | Promise<T>) => fn(),
      runNow: async () => ({}) as ScheduleRun,
      stopRun: async () => null,
      unfinishedRuns: async () => [],
      unfinishedRunsNow: () => [],
      announceSchedules: () => undefined,
      viewRuns: (runs) => runs,
    },
  });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  db.close();
});

async function propose(text = PROPOSAL): Promise<ScheduleProposalCard> {
  const res = await app.inject({ method: "POST", url: `/api/sessions/${SESSION}/schedules/propose`, payload: { text } });
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as { card: ScheduleProposalCard }).card;
}

describe("the schedule proposal routes", () => {
  it("posts a card, and Confirm saves the schedule in the zone the browser sends", async () => {
    const card = await propose();
    expect(store.list()).toEqual([]);

    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${SESSION}/schedule-proposals/${card.cardId}/confirm`,
      payload: { timeZone: "Europe/Berlin" },
    });

    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ acted: true, card: { phase: "confirmed", timeZone: "Europe/Berlin" } });
    expect(store.list()).toMatchObject([{ name: "Nightly", timeZone: "Europe/Berlin" }]);

    const list = await app.inject({ method: "GET", url: `/api/sessions/${SESSION}/schedules` });
    expect(list.json()).toMatchObject({ schedules: [{ name: "Nightly", when: "daily 02:00", target: "Sandbox" }] });
  });

  it("refuses a proposal by name, and an empty one", async () => {
    const refused = await app.inject({
      method: "POST",
      url: `/api/sessions/${SESSION}/schedules/propose`,
      payload: { text: "name: Nightly\n" },
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toEqual({ error: expect.stringContaining("this proposal has no when, target, prompt") });

    const empty = await app.inject({ method: "POST", url: `/api/sessions/${SESSION}/schedules/propose`, payload: {} });
    expect(empty.statusCode).toBe(400);
  });

  it("cancels, and answers 404 for a card that is not in the session", async () => {
    const card = await propose();
    const cancel = await app.inject({ method: "POST", url: `/api/sessions/${SESSION}/schedule-proposals/${card.cardId}/cancel` });
    expect(cancel.json()).toMatchObject({ acted: true, card: { phase: "cancelled" } });

    const missing = await app.inject({ method: "POST", url: `/api/sessions/${SESSION}/schedule-proposals/sch-nope/confirm` });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: "That schedule proposal is not in this session." });
  });

  it("answers 404 for a session that does not exist", async () => {
    const res = await app.inject({ method: "GET", url: "/api/sessions/nope/schedules" });
    expect(res.statusCode).toBe(404);
  });
});
