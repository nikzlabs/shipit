import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseManager } from "../src/server/shared/database.js";
import { ChatHistoryManager } from "../src/server/orchestrator/chat-history.js";
import { SessionManager } from "../src/server/orchestrator/sessions.js";
import {
  SAMPLE_TURNS, buildTranscript, seedTranscript,
  TRANSCRIPT_SESSION_ID, TRANSCRIPT_SESSION_TITLE,
} from "./seed-inner-transcript.js";

let stateDir: string;

function makeDatabase(): void {
  const manager = new DatabaseManager(path.join(stateDir, ".shipit.db"));
  manager.db.close();
}

function read(): { sessions: SessionManager; history: ChatHistoryManager; close: () => void } {
  const manager = new DatabaseManager(path.join(stateDir, ".shipit.db"));
  return {
    sessions: new SessionManager(manager),
    history: new ChatHistoryManager(manager),
    close: () => { manager.db.close(); },
  };
}

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "seed-transcript-"));
});

afterEach(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
});

describe("the sample turns", () => {
  it("covers a turn that ends in an agent reply and one with no agent text", () => {
    const hasText = (turn: (typeof SAMPLE_TURNS)[number]): boolean =>
      turn.assistant.some((m) => m.text.trim().length > 0);
    expect(SAMPLE_TURNS.some(hasText)).toBe(true);
    expect(SAMPLE_TURNS.some((turn) => !hasText(turn))).toBe(true);
  });

  it("covers a turn that has both hidden work and an action card", () => {
    expect(SAMPLE_TURNS.some((turn) =>
      turn.assistant.some((m) => m.actionChecklist) && turn.assistant.some((m) => m.toolUse?.length),
    )).toBe(true);
  });

  it("alternates user and assistant rows, one user row per turn", () => {
    const messages = buildTranscript();
    expect(messages.filter((m) => m.role === "user")).toHaveLength(SAMPLE_TURNS.length);
    expect(messages[0].role).toBe("user");
  });

  it("gives every tool call a result under a unique id", () => {
    const ids = buildTranscript().flatMap((m) => m.toolUse?.map((t) => t.id) ?? []);
    const results = new Set(buildTranscript().flatMap((m) => m.toolResults?.map((r) => r.toolUseId) ?? []));
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(results.has(id)).toBe(true);
  });

  it("builds the same transcript every time, so two renderings are comparable", () => {
    expect(buildTranscript()).toEqual(buildTranscript());
  });
});

describe("seedTranscript", () => {
  it("writes the session and its transcript", async () => {
    makeDatabase();
    const result = await seedTranscript({ env: {}, stateDir });
    expect(result.outcome).toBe("seeded");

    const db = read();
    expect(db.sessions.get(TRANSCRIPT_SESSION_ID)?.title).toBe(TRANSCRIPT_SESSION_TITLE);
    expect(db.history.load(TRANSCRIPT_SESSION_ID)).toHaveLength(buildTranscript().length);
    db.close();
  });

  it("leaves a transcript that is already there alone", async () => {
    makeDatabase();
    await seedTranscript({ env: {}, stateDir });
    const edited = read();
    edited.history.append(TRANSCRIPT_SESSION_ID, { role: "user", text: "a real turn, typed later" });
    edited.close();

    const again = await seedTranscript({ env: {}, stateDir });
    expect(again).toEqual({ outcome: "skipped", reason: "already-present" });

    const db = read();
    const last = db.history.load(TRANSCRIPT_SESSION_ID).at(-1);
    expect(last?.text).toBe("a real turn, typed later");
    db.close();
  });

  it("rewrites the transcript when forced", async () => {
    makeDatabase();
    await seedTranscript({ env: {}, stateDir });
    const result = await seedTranscript({ env: {}, stateDir }, { force: true });
    expect(result.outcome).toBe("rewritten");

    const db = read();
    expect(db.history.load(TRANSCRIPT_SESSION_ID)).toHaveLength(buildTranscript().length);
    db.close();
  });

  it("skips when seeding is turned off", async () => {
    makeDatabase();
    const result = await seedTranscript({ env: { DOGFOOD_SEED_TRANSCRIPT: "0" }, stateDir });
    expect(result).toEqual({ outcome: "skipped", reason: "disabled" });

    const db = read();
    expect(db.sessions.get(TRANSCRIPT_SESSION_ID)).toBeUndefined();
    db.close();
  });

  it("skips rather than creating a database the orchestrator has not made yet", async () => {
    const result = await seedTranscript({ env: {}, stateDir });
    expect(result).toEqual({ outcome: "skipped", reason: "no-database" });
    expect(fs.existsSync(path.join(stateDir, ".shipit.db"))).toBe(false);
  });
});
