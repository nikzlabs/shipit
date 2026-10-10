import { describe, it, expect, afterEach } from "vitest";
import { DatabaseManager } from "../../shared/database.js";
import { SessionManager } from "../sessions.js";
import { ChatHistoryManager, type PersistedMessage } from "../chat-history.js";
import { ServiceError } from "./types.js";
import { REDACTION_PLACEHOLDER } from "./redaction.js";
import {
  queryHostSessionTranscript,
  DEFAULT_TRANSCRIPT_MESSAGES,
  MAX_TRANSCRIPT_MESSAGES,
  MAX_TRANSCRIPT_RESPONSE_CHARS,
  MAX_TRANSCRIPT_SCAN_CHARS,
  TRANSCRIPT_BODY_CHARS,
  TRANSCRIPT_FULL_BODY_CHARS,
} from "./host-session-transcript.js";

const SUBJECT = "7bc72326-c1ad-48fd-ac95-12149a000000";
const GITHUB_TOKEN = "ghp_ABCDEFGHIJKLMNOP1234567890abcd";

let open: DatabaseManager | undefined;

afterEach(() => {
  open?.close();
  open = undefined;
});

function setup(): { db: DatabaseManager; sessions: SessionManager; history: ChatHistoryManager } {
  const db = new DatabaseManager(":memory:");
  open = db;
  const sessions = new SessionManager(db);
  sessions.track(SUBJECT, "Merge watch investigation");
  return { db, sessions, history: new ChatHistoryManager(db) };
}

function setWrittenAt(db: DatabaseManager, id: number, sqliteTime: string): void {
  db.db.prepare("UPDATE messages SET created_at = ? WHERE id = ?").run(sqliteTime, id);
}

function expectStatus(fn: () => unknown, status: number): void {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ServiceError);
    expect((err as ServiceError).statusCode).toBe(status);
    return;
  }
  throw new Error(`expected a ServiceError ${status}`);
}

describe("queryHostSessionTranscript (docs/326)", () => {
  it("returns the two things the incident needed: the failed tool result and the armed card", () => {
    const { sessions, history } = setup();
    history.append(SUBJECT, { role: "user", text: "Tell me when the PR merges." });
    history.append(SUBJECT, {
      role: "assistant",
      text: "I will arm the merge watch.",
      toolUse: [{
        type: "tool_use",
        id: "toolu_1",
        name: "Bash",
        input: { command: "shipit session notify-on-merge --self" },
        startedAt: "2026-10-10T08:01:30.000Z",
      }],
      toolResults: [{ toolUseId: "toolu_1", content: "409: a merge watch is already armed", isError: true }],
    });
    history.append(SUBJECT, {
      role: "assistant",
      text: "",
      selfMergeWatch: {
        cardId: "c1",
        watchId: "w1",
        prNumber: 3120,
        prUrl: "https://github.com/acme/app/pull/3120",
        createdAt: "2026-10-10T08:01:31.000Z",
      },
    });

    const result = queryHostSessionTranscript(sessions, history, SUBJECT);

    expect(result.sessionId).toBe(SUBJECT);
    expect(result.stored).toBe(3);
    expect(result.entries.map((e) => e.position)).toEqual([1, 2, 3]);
    expect(result.entries[0].message).toMatchObject({ role: "user", text: "Tell me when the PR merges." });
    expect(result.entries[1].message.toolUse?.[0].input).toEqual({ command: "shipit session notify-on-merge --self" });
    expect(result.entries[1].message.toolResults?.[0]).toMatchObject({
      content: "409: a merge watch is already armed",
      isError: true,
    });
    expect(result.entries[2].message.selfMergeWatch).toMatchObject({
      watchId: "w1",
      prNumber: 3120,
      prUrl: "https://github.com/acme/app/pull/3120",
    });
    expect(result.truncated).toBe(false);
    expect(result.everStored).toBe(true);
  });

  it("redacts a credential in every place a message can hold text, and counts it", () => {
    const { sessions, history } = setup();
    sessions.track("aaaa0000-0000-0000-0000-000000000000", `Rotate ${GITHUB_TOKEN}`);
    const message: PersistedMessage = {
      role: "assistant",
      text: `text ${GITHUB_TOKEN}`,
      toolUse: [{
        type: "tool_use",
        id: "toolu_1",
        name: "Bash",
        input: { command: `curl -H "Authorization: Bearer abcdef1234567890XYZ" x`, [GITHUB_TOKEN]: "v" },
      }],
      toolResults: [{ toolUseId: "toolu_1", content: `GITHUB_TOKEN=${GITHUB_TOKEN}\nSTRIPE_SECRET_KEY=whsec_plainvalue` }],
      files: [{ path: "a.env", contentPreview: `key sk-ant-abcdefghijklmnop` }],
      sessionReport: {
        cardId: "c",
        fromSessionId: "x",
        fromTitle: "child",
        relation: "child",
        severity: "warn",
        body: `remote https://deploy:hunter2secret@git.example.com/acme/app.git`, // gitleaks:allow
        createdAt: "2026-10-10T08:00:00.000Z",
      },
      subagentEvents: [
        { kind: "assistant", parentToolUseId: "toolu_1", text: `sub ${GITHUB_TOKEN}`, toolUse: [] },
        { kind: "tool_result", parentToolUseId: "toolu_1", toolResults: [{ toolUseId: "n1", content: `nested ${GITHUB_TOKEN}` }] },
      ],
    };
    history.append("aaaa0000-0000-0000-0000-000000000000", message);

    const result = queryHostSessionTranscript(sessions, history, "aaaa0000");
    const wire = JSON.stringify(result);

    for (const secret of [GITHUB_TOKEN, "abcdef1234567890XYZ", "whsec_plainvalue", "sk-ant-abcdefghijklmnop", "hunter2secret"]) {
      expect(wire, secret).not.toContain(secret);
    }
    expect(wire).toContain(REDACTION_PLACEHOLDER);
    expect(result.title).toBe(`Rotate ${REDACTION_PLACEHOLDER}`);
    // text, bearer, key, two assignments, file preview, URL password, two subagent texts, title
    expect(result.redactions).toBe(10);
    // The user name and the host of a credentialed URL stay: only the password goes.
    expect(wire).toContain(`https://deploy:${REDACTION_PLACEHOLDER}@git.example.com/acme/app.git`); // gitleaks:allow
  });

  it("keeps URLs, paths, e-mail addresses and commit hashes readable", () => {
    const { sessions, history } = setup();
    const text = [
      "see https://github.com/acme/app/pull/3120",
      "edited /workspace/src/server/index.ts",
      "ask jane.doe@example.com",
      "commit a090492df34eda2d2896d7ade860d166507d113a",
    ].join("\n");
    history.append(SUBJECT, { role: "assistant", text });

    const result = queryHostSessionTranscript(sessions, history, SUBJECT);

    expect(result.entries[0].message.text).toBe(text);
    expect(result.redactions).toBe(0);
  });

  it("cuts a long body, says so, and keeps its start and its end", () => {
    const { sessions, history } = setup();
    const body = `HEAD-MARKER ${"x".repeat(TRANSCRIPT_BODY_CHARS * 3)} TAIL-MARKER`;
    history.append(SUBJECT, {
      role: "assistant",
      text: "",
      toolUse: [{ type: "tool_use", id: "t", name: "Bash", input: { command: "cat big.log" } }],
      toolResults: [{ toolUseId: "t", content: body }],
    });

    const cut = queryHostSessionTranscript(sessions, history, SUBJECT);
    const content = cut.entries[0].message.toolResults?.[0].content ?? "";
    expect(cut.cutBodies).toBe(1);
    expect(cut.bodyChars).toBe(TRANSCRIPT_BODY_CHARS);
    expect(content).toContain("HEAD-MARKER");
    expect(content).toContain("TAIL-MARKER");
    expect(content).toMatch(/\[… ShipIt cut \d+ characters …\]/);
    expect(content.length).toBeLessThan(TRANSCRIPT_BODY_CHARS + 100);

    const full = queryHostSessionTranscript(sessions, history, SUBJECT, { full: true });
    expect(full.cutBodies).toBe(0);
    expect(full.bodyChars).toBe(TRANSCRIPT_FULL_BODY_CHARS);
    expect(full.entries[0].message.toolResults?.[0].content).toBe(body);
  });

  it("redacts before it cuts, so a cut cannot leave part of a credential", () => {
    const { sessions, history } = setup();
    const head = Math.floor(TRANSCRIPT_BODY_CHARS * 0.75);
    // The token starts 10 characters before the place where the head ends.
    const text = `${"a ".repeat((head - 10) / 2)}${GITHUB_TOKEN} ${"b".repeat(TRANSCRIPT_BODY_CHARS * 2)}`;
    history.append(SUBJECT, { role: "assistant", text });

    const result = queryHostSessionTranscript(sessions, history, SUBJECT);

    expect(result.cutBodies).toBe(1);
    expect(result.entries[0].message.text).not.toContain("ghp_");
  });

  it("leaves no part of a credential that is longer than the text it keeps", () => {
    const { sessions, history } = setup();
    // Built from parts: the commit secret scan reads this file, and this is not a key.
    const edge = (word: string): string => `-----${word} PRIVATE KEY-----`;
    const key = `${edge("BEGIN")}\n${"A".repeat(40_000)}SECRETKEYTAIL\n${edge("END")}`;
    const token = `ghp_${"a".repeat(50_000)}TOKENTAIL`;
    history.append(SUBJECT, { role: "assistant", text: `START ${key} between ${token} END` });
    history.append(SUBJECT, { role: "assistant", text: `${"m".repeat(300_000)} ${token}` });

    const result = queryHostSessionTranscript(sessions, history, SUBJECT);
    const wire = JSON.stringify(result);

    for (const part of ["SECRETKEYTAIL", "TOKENTAIL", "ghp_", "AAAAAAAA"]) expect(wire, part).not.toContain(part);
    expect(result.entries[0].message.text).toBe(`START ${REDACTION_PLACEHOLDER} between ${REDACTION_PLACEHOLDER} END`);
    expect(result.entries[1].message.text.endsWith(REDACTION_PLACEHOLDER)).toBe(true);
    expect(result.cutBodies).toBe(1);
  });

  it("keeps every value when keys come out as the same text", () => {
    const { sessions, history } = setup();
    history.append(SUBJECT, {
      role: "assistant",
      text: "",
      toolUse: [{
        type: "tool_use",
        id: "t",
        name: "Write",
        input: {
          [GITHUB_TOKEN]: "first",
          [`${GITHUB_TOKEN}XYZ`]: "second",
          [`${REDACTION_PLACEHOLDER} (2)`]: "third",
          [`${GITHUB_TOKEN}ABC`]: "fourth",
        },
      }],
    });

    const input = queryHostSessionTranscript(sessions, history, SUBJECT).entries[0].message.toolUse?.[0].input ?? {};

    expect(Object.values(input)).toEqual(["first", "second", "third", "fourth"]);
    expect(new Set(Object.keys(input)).size).toBe(4);
    expect(JSON.stringify(input)).not.toContain("ghp_");
  });

  it("withholds a stored row that cannot be decoded or has the wrong shape, and passes on none of its text", () => {
    const { db, sessions, history } = setup();
    history.append(SUBJECT, { role: "user", text: "before" });
    const notJson = history.append(SUBJECT, { role: "assistant", text: "BROKEN-ROW-TEXT" });
    const wrongImages = history.append(SUBJECT, { role: "user", text: "WRONG-SHAPE-TEXT" });
    history.append(SUBJECT, {
      role: "assistant",
      text: "kept",
      toolUse: [{ type: "tool_use", id: "t", name: "Bash", input: {} }],
      toolResults: [{ toolUseId: "t", content: "x" }],
    });
    db.db.prepare("UPDATE messages SET tool_use = ? WHERE id = ?").run(`${GITHUB_TOKEN} is not JSON`, notJson);
    db.db.prepare("UPDATE messages SET images = ? WHERE id = ?").run('[null, 5]', wrongImages);
    db.db.prepare("UPDATE messages SET tool_results = ? WHERE session_id = ? AND tool_results IS NOT NULL")
      .run('[{"toolUseId":"t","content":null}]', SUBJECT);

    const result = queryHostSessionTranscript(sessions, history, SUBJECT);
    const wire = JSON.stringify(result);

    expect(result.entries.map((e) => e.withheld ?? "ok")).toEqual(["ok", "unreadable", "unreadable", "ok"]);
    expect(result.entries.map((e) => e.message.text)).toEqual(["before", "", "", "kept"]);
    // A result with no text is not a reason to lose the message around it.
    expect(result.entries[3].message.toolResults).toEqual([{ toolUseId: "t", content: null }]);
    for (const part of ["ghp_", "BROKEN-ROW-TEXT", "WRONG-SHAPE-TEXT"]) expect(wire, part).not.toContain(part);
  });

  it("holds one message to both limits: the texts past a limit are withheld and marked", () => {
    const { sessions, history } = setup();
    history.append(SUBJECT, {
      role: "assistant",
      text: "",
      toolUse: [{
        type: "tool_use",
        id: "t",
        name: "Write",
        input: { parts: Array.from({ length: 600 }, () => "x".repeat(TRANSCRIPT_BODY_CHARS)) },
      }],
    });
    history.append(SUBJECT, {
      role: "assistant",
      text: "y".repeat(MAX_TRANSCRIPT_SCAN_CHARS + 1),
      toolUse: [{ type: "tool_use", id: "u", name: "Bash", input: { command: "echo small" } }],
    });

    const big = queryHostSessionTranscript(sessions, history, SUBJECT, { last: 1 });
    expect(big.entries[0].message.text).toMatch(/^\[… ShipIt withheld \d+ characters: /);
    expect(big.entries[0].message.toolUse?.[0].input).toEqual({ command: "echo small" });
    expect(big.cutBodies).toBe(1);

    const many = queryHostSessionTranscript(sessions, history, SUBJECT, { last: 1, before: 2 });
    const parts = (many.entries[0].message.toolUse?.[0].input as { parts: string[] }).parts;
    expect(parts).toHaveLength(600);
    expect(parts[0]).toBe("x".repeat(TRANSCRIPT_BODY_CHARS));
    expect(parts[599]).toMatch(/^\[… ShipIt withheld 4000 characters: /);
    expect(JSON.stringify(many.entries).length).toBeLessThan(MAX_TRANSCRIPT_RESPONSE_CHARS + 100_000);
    expect(many.cutBodies).toBeGreaterThan(0);
  });

  it("withholds a message of very many small values, which no text limit counts", () => {
    const { sessions, history } = setup();
    history.append(SUBJECT, {
      role: "assistant",
      text: "",
      toolUse: [{
        type: "tool_use",
        id: "t",
        name: "Write",
        input: { numbers: Array.from({ length: 900_000 }, (_, i) => i) },
      }],
    });

    const result = queryHostSessionTranscript(sessions, history, SUBJECT);

    expect(result.entries[0]).toMatchObject({ position: 1, withheld: "too-large", message: { text: "" } });
  });

  it("stops at the scan limit and names the cursor for the rest", () => {
    const { sessions, history } = setup();
    const row = "s".repeat(1_000_000);
    const count = MAX_TRANSCRIPT_SCAN_CHARS / row.length + 4;
    for (let i = 0; i < count; i++) history.append(SUBJECT, { role: "assistant", text: row });

    const result = queryHostSessionTranscript(sessions, history, SUBJECT, { last: count });

    expect(result.entries.length).toBeGreaterThan(0);
    expect(result.entries.length).toBeLessThanOrEqual(MAX_TRANSCRIPT_SCAN_CHARS / row.length + 1);
    expect(result.entries[result.entries.length - 1].position).toBe(count);
    expect(result).toMatchObject({ truncated: true, olderBefore: result.entries[0].position });
  });

  it("removes image bytes from a user message and from a tool result", () => {
    const { sessions, history } = setup();
    const png = "iVBORw0KGgo".repeat(50);
    history.append(SUBJECT, { role: "user", text: "look", images: [{ data: png, mediaType: "image/png" }] });
    history.append(SUBJECT, {
      role: "assistant",
      text: "",
      toolUse: [{ type: "tool_use", id: "t", name: "Read", input: { file_path: "shot.png" } }],
      toolResults: [{
        toolUseId: "t",
        content: JSON.stringify([
          { type: "text", text: "a screenshot" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: png } },
        ]),
      }],
    });

    const result = queryHostSessionTranscript(sessions, history, SUBJECT);
    const wire = JSON.stringify(result);

    expect(wire).not.toContain(png);
    expect(result.entries[0].message.images).toEqual([{ mediaType: "image/png" }]);
    expect(result.entries[1].message.toolResults?.[0].content).toBe("a screenshot\n[image image/png]");
  });

  it("returns a result stored as content blocks as its text, and leaves other JSON as it is", () => {
    const { sessions, history } = setup();
    const unchanged = [
      // Not only text and image blocks.
      JSON.stringify([{ type: "text", text: "line one" }, { type: "resource", uri: "x" }]),
      // Data that a tool printed, which only looks like blocks.
      JSON.stringify([{ type: "text", text: "hello", amount: 900 }]),
      JSON.stringify([{ type: "image", path: "/workspace/result.png", status: "failed" }]),
      JSON.stringify([{ name: "a" }, { name: "b" }]),
      "[INFO] not JSON",
    ];
    const results = [JSON.stringify([{ type: "text", text: "line one\nA_TOKEN=abc" }, { type: "text", text: "line three" }]), ...unchanged];
    history.append(SUBJECT, {
      role: "assistant",
      text: "",
      toolUse: results.map((_, i) => ({ type: "tool_use" as const, id: `t${i}`, name: "Bash", input: {} })),
      toolResults: results.map((content, i) => ({ toolUseId: `t${i}`, content })),
    });

    const out = queryHostSessionTranscript(sessions, history, SUBJECT).entries[0].message.toolResults ?? [];

    expect(out[0].content).toBe(`line one\nA_TOKEN=${REDACTION_PLACEHOLDER}\nline three`);
    expect(out.slice(1).map((r) => r.content)).toEqual(unchanged);
  });

  it("returns the newest messages and names the cursor for the older ones", () => {
    const { sessions, history } = setup();
    for (let i = 1; i <= 7; i++) history.append(SUBJECT, { role: "user", text: `m${i}` });

    const newest = queryHostSessionTranscript(sessions, history, SUBJECT, { last: 3 });
    expect(newest.entries.map((e) => e.message.text)).toEqual(["m5", "m6", "m7"]);
    expect(newest).toMatchObject({ stored: 7, total: 7, truncated: true, olderBefore: 5 });

    const older = queryHostSessionTranscript(sessions, history, SUBJECT, { last: 3, before: newest.olderBefore });
    expect(older.entries.map((e) => e.message.text)).toEqual(["m2", "m3", "m4"]);
    expect(older).toMatchObject({ total: 4, truncated: true, olderBefore: 2 });

    const oldest = queryHostSessionTranscript(sessions, history, SUBJECT, { last: 3, before: older.olderBefore });
    expect(oldest.entries.map((e) => e.message.text)).toEqual(["m1"]);
    expect(oldest.truncated).toBe(false);
    expect(oldest.olderBefore).toBeUndefined();
  });

  it("defaults the page size, clamps it, and REJECTS a value that is not a positive integer", () => {
    const { sessions, history } = setup();
    for (let i = 0; i < MAX_TRANSCRIPT_MESSAGES + 5; i++) history.append(SUBJECT, { role: "user", text: `m${i}` });

    expect(queryHostSessionTranscript(sessions, history, SUBJECT).entries).toHaveLength(DEFAULT_TRANSCRIPT_MESSAGES);
    expect(queryHostSessionTranscript(sessions, history, SUBJECT, { last: 100_000 }).entries)
      .toHaveLength(MAX_TRANSCRIPT_MESSAGES);
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expectStatus(() => queryHostSessionTranscript(sessions, history, SUBJECT, { last: bad }), 400);
      expectStatus(() => queryHostSessionTranscript(sessions, history, SUBJECT, { before: bad }), 400);
    }
  });

  it("filters to a --since / --until window on the time the row was written", () => {
    const { db, sessions, history } = setup();
    const early = history.append(SUBJECT, { role: "user", text: "early" });
    const inside = history.append(SUBJECT, { role: "user", text: "inside" });
    const late = history.append(SUBJECT, { role: "user", text: "late" });
    setWrittenAt(db, early, "2026-10-10 07:00:00");
    setWrittenAt(db, inside, "2026-10-10 08:00:00");
    setWrittenAt(db, late, "2026-10-10 09:00:00");

    const result = queryHostSessionTranscript(sessions, history, SUBJECT, {
      since: "2026-10-10T07:30:00Z",
      until: "2026-10-10T08:30:00Z",
    });

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({ position: 2, storedAt: "2026-10-10T08:00:00Z" });
    expect(result).toMatchObject({ stored: 3, total: 1, truncated: false });

    const relative = queryHostSessionTranscript(sessions, history, SUBJECT, {
      since: "90m",
      nowMs: Date.parse("2026-10-10T09:30:00Z"),
    });
    expect(relative.entries.map((e) => e.message.text)).toEqual(["inside", "late"]);
  });

  it("rejects an unparseable or inverted window instead of returning the whole transcript", () => {
    const { sessions, history } = setup();
    history.append(SUBJECT, { role: "user", text: "m" });

    expectStatus(() => queryHostSessionTranscript(sessions, history, SUBJECT, { since: "1 hour ago" }), 400);
    expectStatus(
      () => queryHostSessionTranscript(sessions, history, SUBJECT, {
        since: "2026-10-10T09:00:00Z",
        until: "2026-10-10T08:00:00Z",
      }),
      400,
    );
  });

  it("tells a transcript that never existed from one that was removed", () => {
    const { sessions, history } = setup();

    const never = queryHostSessionTranscript(sessions, history, SUBJECT);
    expect(never).toMatchObject({ stored: 0, entries: [], everStored: false });

    history.append(SUBJECT, { role: "user", text: "m" });
    history.saveMessages(SUBJECT, []);

    const removed = queryHostSessionTranscript(sessions, history, SUBJECT);
    expect(removed).toMatchObject({ stored: 0, entries: [], everStored: true });
  });

  it("reads an archived session whose container and checkout are gone", () => {
    const { sessions, history } = setup();
    history.append(SUBJECT, { role: "user", text: "before the archive" });
    sessions.setDiskTier(SUBJECT, "evicted");
    sessions.archive(SUBJECT);

    const result = queryHostSessionTranscript(sessions, history, SUBJECT);

    expect(result).toMatchObject({ archived: true, diskTier: "evicted" });
    expect(result.entries[0].message.text).toBe("before the archive");
  });

  it("keeps the marks of a turn in progress and of a rolled-back message", () => {
    const { sessions, history } = setup();
    history.append(SUBJECT, { role: "assistant", text: "undone", rolledBack: true });
    history.append(SUBJECT, { role: "assistant", text: "working", inProgress: true });

    const result = queryHostSessionTranscript(sessions, history, SUBJECT);

    expect(result.entries[0].message.rolledBack).toBe(true);
    expect(result.entries[1].message.inProgress).toBe(true);
  });

  it("drops the oldest messages of a page that is over the size budget, and always returns the newest", () => {
    const { sessions, history } = setup();
    const big = "y".repeat(TRANSCRIPT_FULL_BODY_CHARS);
    const count = Math.ceil(MAX_TRANSCRIPT_RESPONSE_CHARS / TRANSCRIPT_FULL_BODY_CHARS) + 3;
    for (let i = 0; i < count; i++) history.append(SUBJECT, { role: "assistant", text: big });

    const result = queryHostSessionTranscript(sessions, history, SUBJECT, { full: true, last: count });

    expect(result.entries.length).toBeGreaterThan(0);
    expect(result.entries.length).toBeLessThan(count);
    expect(result.entries[result.entries.length - 1].position).toBe(count);
    expect(result.truncated).toBe(true);
    expect(result.olderBefore).toBe(result.entries[0].position);
    expect(JSON.stringify(result.entries).length).toBeLessThanOrEqual(MAX_TRANSCRIPT_RESPONSE_CHARS + 10_000);
  });

  it("keeps a tool input key that would be dropped as a prototype assignment", () => {
    const { sessions, history } = setup();
    history.append(SUBJECT, {
      role: "assistant",
      text: "",
      toolUse: [{
        type: "tool_use",
        id: "t",
        name: "Write",
        input: JSON.parse('{"__proto__": "kept", "path": "a"}') as Record<string, unknown>,
      }],
    });

    const result = queryHostSessionTranscript(sessions, history, SUBJECT);

    expect(JSON.stringify(result.entries[0].message.toolUse?.[0].input)).toBe('{"__proto__":"kept","path":"a"}');
  });

  it("resolves a truncated id, refuses an ambiguous one, and 404s an unknown one", () => {
    const { sessions, history } = setup();
    sessions.track("7bc7ffff-0000-0000-0000-000000000000", "Neighbour");
    history.append(SUBJECT, { role: "user", text: "m" });

    expect(queryHostSessionTranscript(sessions, history, "7bc72326").sessionId).toBe(SUBJECT);
    expectStatus(() => queryHostSessionTranscript(sessions, history, "7bc7"), 400);
    expectStatus(() => queryHostSessionTranscript(sessions, history, "deadbeef"), 404);
    expectStatus(() => queryHostSessionTranscript(sessions, history, "  "), 400);
  });
});
