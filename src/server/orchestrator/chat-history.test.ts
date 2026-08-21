import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { DatabaseManager } from "../shared/database.js";
import { ChatHistoryManager, type PersistedMessage } from "./chat-history.js";
import type { SubAgentConsultCard } from "../shared/types.js";
import { CARD_MESSAGE_FIELDS } from "../../client/components/visual-elements.js";
import { buildRetiredSubagentResult } from "./subagent-completion.js";

/**
 * Serialization contract: a `PersistedMessage` carrying every optional field.
 * If you add a field to `PersistedMessage`, wire it through `toRow`/`fromRow`
 * (and a migration) AND add it here — a field that serializes one way but not
 * the other (the recurring "card renders live but vanishes on reload" bug class,
 * docs/188) fails the round-trip deep-equal below, and any inline-card field
 * fails the CARD_MESSAGE_FIELDS guard test if it's missing here.
 */
const EVERY_OPTIONAL_FIELD_MESSAGE: PersistedMessage = {
  role: "assistant",
  text: "everything",
  agentInterface: { source: "agent_interface_sdk", surface: "preview" },
  messageOrigin: { sessionId: "parent", sessionTitle: "Parent", relation: "parent" },
  toolUse: [{ type: "tool_use", id: "t1", name: "Edit", input: { path: "a.ts" } }],
  images: [{ data: "abc", mediaType: "image/png" }],
  files: [{ path: "a.ts", contentPreview: "x", startLine: 1, endLine: 2 }],
  isError: true,
  toolResults: [{ toolUseId: "t1", content: "ok", isError: false, durationMs: 1234 }],
  commitHash: "abc123",
  parentCommitHash: "def456",
  uploadPaths: ["/uploads/x.png"],
  notice: true,
  noticeLevel: "warn",
  rolledBack: true,
  forkChild: { childSessionId: "child", title: "T", branch: "b" },
  codeRollbackHash: "c0ffee",
  voiceNote: { id: "v1", headline: "h", kind: "authored", createdAt: "t" },
  bugReport: { cardId: "b1", phase: "filed", title: "T", body: "B", stage2Ran: true, producer: "ops", issueNumber: 5, issueUrl: "u" },
  permissionPrompt: { requestId: "p1", phase: "approved", toolName: "Write", path: ".npmrc", summary: "Write .npmrc", details: "{\n  \"file_path\": \".npmrc\"\n}", agentId: "claude", createdAt: "2026-06-05T00:00:00.000Z", remembered: true },
  egressPrompt: { cardId: "eg1", host: "evil.example.com", phase: "denied", createdAt: "2026-06-05T00:00:00.000Z" },
  compaction: { id: "c1", trigger: "manual", preTokens: 100, postTokens: 20, durationMs: 9, createdAt: "t" },
  // docs/261 phase 4 — `runOn` rides the same json column as the rest of the
  // card, so it needs no migration; what it DOES need is to be here, or the
  // round-trip below cannot tell "attribution survives a reload" from
  // "attribution was never stored", which is the exact bug class docs/188 names.
  subAgentConsult: { cardId: "sac1", spawnId: "spawn-1", subAgentId: "codex", runOn: { serviceId: "openai", billingMode: "sub", modelId: "gpt-5.6-sol", reasoningEffort: "high" }, status: "success", durationMs: 47000, costUsd: 0.03, truncated: false, outputMarkdown: "## Findings\n\n- `foo.ts:42` — bug\n", createdAt: "2026-06-05T00:00:00.000Z" },
  nonTurnFailure: {
    cardId: "ntf1",
    purpose: "session-naming",
    serviceId: "anthropic",
    serviceName: "Anthropic",
    billingMode: "sub",
    modelId: "claude-haiku-4-5-20251001",
    pinned: true,
    fallback: "The session kept its placeholder title.",
    detail: "401 Unauthorized",
    createdAt: "2026-08-09T00:00:00.000Z",
    dismissedAt: "2026-08-09T00:01:00.000Z",
  },
  actionChecklist: {
    cardId: "ac1",
    title: "Optional follow-ups",
    actions: [
      { id: "a1", label: "Open a PR", description: "From the current branch", defaultChecked: true, payload: "Open a PR for this change." },
      { id: "a2", label: "File an issue", payload: "File a follow-up issue for the rate-limit edge case." },
    ],
    branch: "shipit/apobab",
    headSha: "abc12345",
    createdAt: "2026-06-05T00:00:00.000Z",
  },
  branchAutoReset: {
    cardId: "bar1",
    base: "main",
    prNumber: 482,
    prUrl: "https://github.com/o/r/pull/482",
    fromSha: "a1f3c9d0000000000000000000000000000000aa",
    toSha: "7e02b480000000000000000000000000000000bb",
    createdAt: "2026-06-05T00:00:00.000Z",
  },
  branchSynced: {
    cardId: "bsync1",
    base: "main",
    headFromSha: "1111111000000000000000000000000000000aaa",
    headToSha: "2222222000000000000000000000000000000bbb",
    baseFromSha: "3333333000000000000000000000000000000ccc",
    baseToSha: "4444444000000000000000000000000000000ddd",
    forcePushed: true,
    createdAt: "2026-06-05T00:00:00.000Z",
  },
  sessionRenamed: {
    cardId: "srn1",
    from: "Add the session rename API",
    to: "Agent session rename",
    createdAt: "2026-06-05T00:00:00.000Z",
  },
  issueWrite: {
    cardId: "iw1",
    tracker: "linear",
    issueId: "SHI-28",
    identifier: "SHI-28",
    title: "Some issue",
    url: "https://linear.app/x/issue/SHI-28",
    verb: "status",
    summary: "set SHI-28 → In Review",
    content: { status: { from: "Todo", to: "In Review" } },
    attribution: "workspace",
    undo: { kind: "status", previousStatus: "Todo" },
    undoState: "available",
    createdAt: "2026-06-05T00:00:00.000Z",
  },
  issueRef: {
    cardId: "ir1",
    tracker: "linear",
    identifier: "SHI-28",
    title: "Some issue",
    url: "https://linear.app/x/issue/SHI-28",
    status: "In Review",
    statusType: "started",
    createdAt: "2026-06-05T00:00:00.000Z",
  },
  spawnedSession: {
    childSessionId: "child-1",
    title: "Child",
    branch: "shipit/child-1",
    spawnedAt: "2026-06-05T00:00:00.000Z",
    shipitFix: { sourceRef: "abc123def456", sourceExact: true, refSource: "build-id", targetRepo: "o/r", diagnosis: "boom" },
  },
  spawnFailed: {
    id: "spawn-failed-1",
    title: "Failed child",
    reason: "quota_per_turn",
    message: "Per-turn spawn limit reached",
    statusCode: 429,
    promptPreview: "do the thing",
    shipitSource: true,
    failedAt: "2026-06-05T00:00:00.000Z",
  },
  childMerged: {
    cardId: "child-merged-1",
    childSessionId: "child-1",
    childTitle: "Child",
    branch: "shipit/child-1",
    outcome: "merged",
    prNumber: 42,
    prUrl: "https://github.com/o/r/pull/42",
    prTitle: "Foundation work",
    mergeSha: "abc123def456",
    createdAt: "2026-06-05T00:00:00.000Z",
  },
  selfMergeWatch: {
    cardId: "self-merge-watch-1",
    watchId: "watch-1",
    prNumber: 43,
    prUrl: "https://github.com/o/r/pull/43",
    prTitle: "Step one",
    branch: "shipit/abc",
    createdAt: "2026-06-05T00:00:00.000Z",
  },
  sessionReport: {
    cardId: "session-report-1-0",
    fromSessionId: "child-1",
    fromTitle: "Elementalist catalog",
    fromBranch: "shipit/child-1",
    relation: "child",
    severity: "blocker",
    subject: "regen deletes every catalog",
    body: "`npm run regen` clears data/catalogs/ before writing.",
    createdAt: "2026-06-05T00:00:00.000Z",
  },
  aiReview: {
    reviewId: "r1",
    filePath: "a.ts",
    markdown: "1. `a.ts:5` — off-by-one\n   Fix: use `<=`.",
    reviewerLabel: "Reviewed by Codex",
    reReviewed: true,
    createdAt: "2026-06-05T00:00:00.000Z",
  },
  releaseCard: {
    sessionId: "sess-1",
    cardId: "release:sess-1:v0.3.0",
    phase: "released",
    version: "0.3.0",
    tag: "v0.3.0",
    prerelease: false,
    bumpType: "minor",
    versionSource: "package.json",
    notes: "## Features\n- x",
    commitSha: "abc123",
    checks: { state: "success", total: 2, passed: 2, failed: 0, pending: 0 },
    release: {
      name: "v0.3.0",
      body: "## Features\n- x",
      htmlUrl: "https://github.com/o/r/releases/tag/v0.3.0",
      prerelease: false,
      publishedAt: "2026-06-05T00:00:00.000Z",
      tagName: "v0.3.0",
    },
  },
  userReview: { filePaths: ["a.ts", "b.ts"], commentCount: 3 },
  noticeId: "notice-1",
  subagentEvents: [],
};

describe("ChatHistoryManager", () => {
  let dbManager: DatabaseManager;

  beforeEach(() => {
    dbManager = new DatabaseManager(":memory:");
  });

  afterEach(() => {
    dbManager.close();
  });

  it("returns an empty array for a session with no history", () => {
    const mgr = new ChatHistoryManager(dbManager);
    expect(mgr.load("nonexistent")).toEqual([]);
  });

  it("appends and loads messages for a session", () => {
    const mgr = new ChatHistoryManager(dbManager);
    const userMsg: PersistedMessage = { role: "user", text: "Hello" };
    const assistantMsg: PersistedMessage = { role: "assistant", text: "Hi there!" };

    mgr.append("sess-1", userMsg);
    mgr.append("sess-1", assistantMsg);

    const messages = mgr.load("sess-1");
    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual(userMsg);
    expect(messages[1]).toEqual(assistantMsg);
  });

  it("persists messages across manager instances", () => {
    const mgr = new ChatHistoryManager(dbManager);
    mgr.append("sess-1", { role: "user", text: "Test" });

    const mgr2 = new ChatHistoryManager(dbManager);
    const loaded = mgr2.load("sess-1");
    expect(loaded).toHaveLength(1);
    expect(loaded[0].text).toBe("Test");
  });

  it("keeps sessions isolated from each other", () => {
    const mgr = new ChatHistoryManager(dbManager);
    mgr.append("sess-1", { role: "user", text: "Session 1" });
    mgr.append("sess-2", { role: "user", text: "Session 2" });

    expect(mgr.load("sess-1")).toHaveLength(1);
    expect(mgr.load("sess-1")[0].text).toBe("Session 1");
    expect(mgr.load("sess-2")).toHaveLength(1);
    expect(mgr.load("sess-2")[0].text).toBe("Session 2");
  });

  it("persists tool use blocks", () => {
    const mgr = new ChatHistoryManager(dbManager);
    const msg: PersistedMessage = {
      role: "assistant",
      text: "I'll edit that file.",
      toolUse: [
        {
          type: "tool_use",
          id: "tool-1",
          name: "Edit",
          input: { file_path: "/workspace/app.ts", old_string: "x", new_string: "y" },
        },
      ],
    };

    mgr.append("sess-1", msg);
    const loaded = mgr.load("sess-1");
    expect(loaded[0].toolUse).toHaveLength(1);
    expect(loaded[0].toolUse![0].name).toBe("Edit");
  });

  it("persists a compaction card so it survives a reload (docs/178)", () => {
    const mgr = new ChatHistoryManager(dbManager);
    const msg: PersistedMessage = {
      role: "assistant",
      text: "",
      compaction: {
        id: "compaction-1",
        trigger: "manual",
        preTokens: 180_000,
        postTokens: 42_000,
        durationMs: 3200,
        createdAt: "2026-06-06T00:00:00.000Z",
      },
    };

    mgr.append("sess-1", msg);
    const loaded = mgr.load("sess-1");
    expect(loaded[0].compaction).toEqual(msg.compaction);
  });

  it("persists a bare compaction card (Codex supplies no detail fields)", () => {
    const mgr = new ChatHistoryManager(dbManager);
    const msg: PersistedMessage = {
      role: "assistant",
      text: "",
      compaction: { id: "compaction-2", createdAt: "2026-06-06T00:00:00.000Z" },
    };
    mgr.append("sess-1", msg);
    expect(mgr.load("sess-1")[0].compaction).toEqual(msg.compaction);
  });

  it("persists a voice-note card so it survives a reload (docs/163)", () => {
    const mgr = new ChatHistoryManager(dbManager);
    const msg: PersistedMessage = {
      role: "assistant",
      text: "",
      voiceNote: {
        id: "voice-1",
        headline: "Done — want me to open a PR?",
        kind: "authored",
        createdAt: "2026-06-02T00:00:00.000Z",
      },
    };

    mgr.append("sess-1", msg);
    const loaded = mgr.load("sess-1");
    expect(loaded[0].voiceNote).toEqual(msg.voiceNote);
  });

  // The `needsAttention` gate was removed (docs/163). Rows written before that
  // carry the extra key in their stored JSON; they must still rehydrate so the
  // card keeps rendering — no migration, nothing reads the dead flag.
  it("rehydrates a pre-removal voice-note row carrying a legacy needsAttention flag", () => {
    const mgr = new ChatHistoryManager(dbManager);
    const legacy = {
      id: "voice-legacy",
      headline: "Work is done, nothing to decide.",
      needsAttention: false,
      kind: "authored",
      createdAt: "2026-06-02T00:00:00.000Z",
    };
    // Written the way the old code wrote it — the extra key is not in the type.
    mgr.append("sess-1", {
      role: "assistant",
      text: "",
      voiceNote: legacy as unknown as PersistedMessage["voiceNote"],
    });

    const card = mgr.load("sess-1")[0].voiceNote;
    expect(card).toMatchObject({
      id: "voice-legacy",
      headline: "Work is done, nothing to decide.",
      kind: "authored",
    });
  });

  describe("bug-report card persistence (docs/164)", () => {
    const draftCard = (cardId: string): PersistedMessage => ({
      role: "assistant",
      text: "",
      bugReport: {
        cardId,
        phase: "draft",
        title: "Preview won't reload",
        body: "redacted body",
        stage2Ran: false,
        producer: "session",
        filedAs: "octocat",
        createdAt: "2026-06-03T00:00:00.000Z",
      },
    });

    it("(a) persists a bug-report card so it replays on session attach", () => {
      const mgr = new ChatHistoryManager(dbManager);
      const msg = draftCard("bug-card-1");
      mgr.append("sess-1", msg);

      // A fresh manager (mirrors a reload rebuilding from the DB) sees the card.
      const loaded = new ChatHistoryManager(dbManager).load("sess-1");
      expect(loaded[0].bugReport).toEqual(msg.bugReport);
    });

    it("(b) updateBugReportCard flips a card to filed with its issue link", () => {
      const mgr = new ChatHistoryManager(dbManager);
      mgr.append("sess-1", { role: "user", text: "report this" });
      mgr.append("sess-1", draftCard("bug-card-1"));

      const found = mgr.updateBugReportCard("sess-1", "bug-card-1", {
        phase: "filed",
        issueNumber: 1234,
        issueUrl: "https://github.com/nikzlabs/shipit/issues/1234",
      });
      expect(found).toBe(true);

      const card = mgr.load("sess-1")[1].bugReport;
      expect(card?.phase).toBe("filed");
      expect(card?.issueNumber).toBe(1234);
      expect(card?.issueUrl).toContain("issues/1234");
      // Original draft fields are preserved through the merge.
      expect(card?.title).toBe("Preview won't reload");
    });

    it("(d) updateBugReportCard records a failure as an editable draft", () => {
      const mgr = new ChatHistoryManager(dbManager);
      mgr.append("sess-1", draftCard("bug-card-1"));

      mgr.updateBugReportCard("sess-1", "bug-card-1", {
        phase: "draft",
        errorMessage: "Your GitHub token can't file issues. Reconnect GitHub.",
        scopeError: true,
      });

      const card = mgr.load("sess-1")[0].bugReport;
      expect(card?.phase).toBe("draft");
      expect(card?.scopeError).toBe(true);
      expect(card?.errorMessage).toContain("Reconnect GitHub");
    });

    it("returns false when no card matches the given id", () => {
      const mgr = new ChatHistoryManager(dbManager);
      mgr.append("sess-1", draftCard("bug-card-1"));
      expect(mgr.updateBugReportCard("sess-1", "missing", { phase: "filed" })).toBe(false);
    });
  });

  describe("listSubAgentConsultCards (planning#247)", () => {
    const consult = (spawnId: string, outputMarkdown: string): PersistedMessage => ({
      role: "assistant",
      text: "",
      subAgentConsult: {
        cardId: `card-${spawnId}`,
        spawnId,
        subAgentId: "codex",
        status: "success",
        outputMarkdown,
        createdAt: "2026-07-28T00:00:00.000Z",
      },
    });

    it("returns the session's consult cards oldest-first, output included", () => {
      const mgr = new ChatHistoryManager(dbManager);
      mgr.append("sess-1", { role: "user", text: "review this with codex" });
      mgr.append("sess-1", consult("spawn-a", "first report"));
      mgr.append("sess-1", { role: "assistant", text: "acting on it" });
      mgr.append("sess-1", consult("spawn-b", "second report"));

      // A fresh manager — this is the read `shipit agent result` makes, and the
      // reason a run whose caller died is still recoverable.
      const cards = new ChatHistoryManager(dbManager).listSubAgentConsultCards("sess-1");
      expect(cards.map((c) => c.spawnId)).toEqual(["spawn-a", "spawn-b"]);
      expect(cards[1].outputMarkdown).toBe("second report");
    });

    it("is scoped to the session and empty when it has no runs", () => {
      const mgr = new ChatHistoryManager(dbManager);
      mgr.append("sess-1", consult("spawn-a", "mine"));
      expect(mgr.listSubAgentConsultCards("sess-2")).toEqual([]);
    });
  });

  describe("updateSubAgentConsultCard (planning#280)", () => {
    const pending = (spawnId: string): PersistedMessage => ({
      role: "assistant",
      text: "",
      subAgentConsult: {
        cardId: `card-${spawnId}`,
        spawnId,
        subAgentId: "codex",
        // docs/261 phase 4 — written at SPAWN time, so it has to survive the
        // terminal patch that lands minutes later on an already-finalized row.
        runOn: { serviceId: "openai", billingMode: "sub", modelId: "gpt-5.6-sol", reasoningEffort: "high" },
        status: "pending",
        createdAt: "2026-08-03T00:00:00.000Z",
      },
    });

    it("flips a pending card to its terminal state on a FINALIZED row", () => {
      // The common shape after docs/236: the consult was backgrounded, so its
      // originating turn finalized long before the run ended. There is no
      // in-progress turn to re-record into — the row patch is the only path.
      const mgr = new ChatHistoryManager(dbManager);
      mgr.append("sess-1", { role: "user", text: "review the PR with codex" });
      mgr.append("sess-1", pending("spawn-a"));
      mgr.append("sess-1", { role: "assistant", text: "a later, unrelated turn" });

      expect(mgr.updateSubAgentConsultCard("sess-1", "card-spawn-a", {
        status: "success",
        durationMs: 900_000,
        outputMarkdown: "## Findings",
      })).toBe(true);

      // Read back through a fresh manager — this is the reload path.
      const cards = new ChatHistoryManager(dbManager).listSubAgentConsultCards("sess-1");
      expect(cards).toHaveLength(1);
      expect(cards[0]).toMatchObject({
        cardId: "card-spawn-a",
        spawnId: "spawn-a",
        status: "success",
        durationMs: 900_000,
        outputMarkdown: "## Findings",
        // untouched fields survive the merge
        createdAt: "2026-08-03T00:00:00.000Z",
        // docs/261 req 9 — including the attribution. The patch that finalizes a
        // card carries no `runOn`, so a merge that replaced rather than merged
        // would leave the permanent record unable to say what reviewed the work.
        runOn: { serviceId: "openai", billingMode: "sub", modelId: "gpt-5.6-sol", reasoningEffort: "high" },
      });
      // patched in place — one card, not a second row appended
      const all = new ChatHistoryManager(dbManager).load("sess-1");
      expect(all.filter((m) => m.subAgentConsult)).toHaveLength(1);
    });

    it("returns false when no card matches the given id", () => {
      const mgr = new ChatHistoryManager(dbManager);
      mgr.append("sess-1", pending("spawn-a"));
      expect(mgr.updateSubAgentConsultCard("sess-1", "missing", { status: "error" })).toBe(false);
    });

    it("is scoped to the session", () => {
      const mgr = new ChatHistoryManager(dbManager);
      mgr.append("sess-1", pending("spawn-a"));
      expect(mgr.updateSubAgentConsultCard("sess-2", "card-spawn-a", { status: "error" })).toBe(false);
      expect(mgr.listSubAgentConsultCards("sess-1")[0].status).toBe("pending");
    });

    // planning#309 — the boot reconcile's write. `finalize` clears in_progress so the
    // reconciled card cannot be deleted by a docs/240-adopted turn's
    // `replaceInProgress`, which drops every in_progress=1 row in the session.
    it("finalize clears in_progress, so an adopted turn's replaceInProgress can't delete the card", () => {
      const mgr = new ChatHistoryManager(dbManager);
      // The foreground-consult shape: the card is still inside its own turn's
      // in-progress row set when the orchestrator dies.
      mgr.replaceInProgress("sess-1", [
        { role: "assistant", text: "consulting codex", inProgress: true },
        { ...pending("spawn-a"), inProgress: true },
      ]);

      expect(mgr.updateSubAgentConsultCard(
        "sess-1",
        "card-spawn-a",
        { status: "cancelled", statusDetail: "ShipIt restarted" },
        { finalize: true },
      )).toBe(true);

      // The adopted turn now rebuilds its own rows, wiping every in-progress row.
      mgr.replaceInProgress("sess-1", [{ role: "assistant", text: "the adopted turn", inProgress: true }]);

      const cards = new ChatHistoryManager(dbManager).listSubAgentConsultCards("sess-1");
      expect(cards).toHaveLength(1);
      expect(cards[0]).toMatchObject({ status: "cancelled", statusDetail: "ShipIt restarted" });
    });

    // planning#402 — `finalize` used to be the ONLY thing standing between a card
    // and the next turn's delete, and only the boot reconcile passed it. The
    // storage chokepoint in `replaceInProgress` now finalizes an orphaned
    // consult row on its own, so a card patched WITHOUT `finalize` survives too.
    // `finalize` is still correct and still what the reconcile wants — it just
    // stopped being load-bearing for durability.
    it("survives the next replaceInProgress even when the patch omits finalize", () => {
      const mgr = new ChatHistoryManager(dbManager);
      mgr.replaceInProgress("sess-1", [{ ...pending("spawn-a"), inProgress: true }]);
      expect(mgr.updateSubAgentConsultCard("sess-1", "card-spawn-a", { status: "cancelled" })).toBe(true);
      mgr.replaceInProgress("sess-1", [{ role: "assistant", text: "the adopted turn", inProgress: true }]);
      const cards = new ChatHistoryManager(dbManager).listSubAgentConsultCards("sess-1");
      expect(cards).toHaveLength(1);
      expect(cards[0]).toMatchObject({ cardId: "card-spawn-a", status: "cancelled" });
    });
  });

  /**
   * planning#402 — the incident: a foreground `shipit agent run` finished
   * successfully, its 16,529-character review was written into the turn's
   * `in_progress=1` rows, an auto-fix turn preempted that turn 330 ms later, and
   * its first `replaceInProgress` deleted the row. `shipit agent result` read
   * `pending` for hours and the output was unrecoverable.
   *
   * The invariant these pin: **no delete of turn scratch takes a row carrying a
   * sub-agent consult card** — and preserving it must not disturb the card's
   * position inside a turn that is still alive.
   */
  describe("consult cards are not turn scratch (planning#402)", () => {
    const card = (
      spawnId: string,
      over: Partial<SubAgentConsultCard> = {},
    ): PersistedMessage => ({
      role: "assistant",
      text: "",
      subAgentConsult: {
        cardId: `card-${spawnId}`,
        spawnId,
        subAgentId: "codex",
        status: "pending",
        createdAt: "2026-08-16T08:14:20.000Z",
        ...over,
      },
    });

    /** The turn's rows as `emitChatCard` / `persistTurnInProgress` build them. */
    const turnRows = (...msgs: PersistedMessage[]): PersistedMessage[] =>
      msgs.map((m) => ({ ...m, inProgress: true }));

    it("keeps a terminal card whose turn is preempted before it finalizes", () => {
      const mgr = new ChatHistoryManager(dbManager);
      // Turn T: the agent blocks on its own foreground `shipit agent run`, so
      // the pending card lands in T's in-progress rows and T stays open.
      const spawned = turnRows(
        { role: "assistant", text: "running the review" },
        card("spawn-a"),
      );
      mgr.replaceInProgress("sess-1", spawned);

      // 12 minutes later the consult returns. `persistCardTransition` takes the
      // in-flight branch (T is still running), patching the recorded card and
      // re-flushing the turn.
      mgr.replaceInProgress("sess-1", turnRows(
        { role: "assistant", text: "running the review" },
        card("spawn-a", { status: "success", outputMarkdown: "## Findings", durationMs: 761_642 }),
      ));

      // 330 ms later an auto-fix turn preempts T and rebuilds from ITS OWN
      // (empty) recorded cards. Before the fix this deleted the success row.
      mgr.replaceInProgress("sess-1", turnRows({ role: "assistant", text: "fixing the failing test" }));

      const cards = new ChatHistoryManager(dbManager).listSubAgentConsultCards("sess-1");
      expect(cards).toHaveLength(1);
      expect(cards[0]).toMatchObject({
        cardId: "card-spawn-a",
        status: "success",
        outputMarkdown: "## Findings",
      });
    });

    it("keeps a card that is still pending when its turn is preempted", () => {
      // The same delete, one beat earlier: lose the pending row and the terminal
      // patch that arrives minutes later has no row to land on at all.
      const mgr = new ChatHistoryManager(dbManager);
      mgr.replaceInProgress("sess-1", turnRows(card("spawn-a")));
      mgr.replaceInProgress("sess-1", turnRows({ role: "assistant", text: "a different turn" }));

      expect(mgr.updateSubAgentConsultCard("sess-1", "card-spawn-a", {
        status: "success",
        outputMarkdown: "## Findings",
      })).toBe(true);
      expect(new ChatHistoryManager(dbManager).listSubAgentConsultCards("sess-1")[0]).toMatchObject({
        status: "success",
        outputMarkdown: "## Findings",
      });
    });

    it("keeps a consult row through clearInProgress", () => {
      const mgr = new ChatHistoryManager(dbManager);
      mgr.replaceInProgress("sess-1", turnRows(
        { role: "assistant", text: "consulting" },
        card("spawn-a", { status: "success" }),
      ));
      mgr.clearInProgress("sess-1");

      const all = new ChatHistoryManager(dbManager).load("sess-1");
      // The aborted turn's scratch is gone; the consult record is not.
      expect(all.map((m) => m.text)).toEqual([""]);
      expect(all[0].subAgentConsult).toMatchObject({ cardId: "card-spawn-a", status: "success" });
    });

    it("never leaves two rows for one card, and lets the terminal copy win", () => {
      // Defect A on its own — no deletion involved, so this has to manufacture
      // the finalized twin by a route that exists WITHOUT the fix: an
      // out-of-band `finalizeInProgress` (docs/240's turn adoption, the auth
      // handler, the crash paths). A live turn keeps the card in
      // `recordedCards`, so its next rebuild re-offers it; inserting it beside
      // the finalized copy leaves the stale row first, and every read that takes
      // a first match then reports `pending` for a finished run.
      const mgr = new ChatHistoryManager(dbManager);
      mgr.replaceInProgress("sess-1", turnRows(
        { role: "assistant", text: "running the review" },
        card("spawn-a"),
      ));
      mgr.finalizeInProgress("sess-1");
      // The turn is still alive and flushes its recorded card again — now
      // carrying the terminal status.
      mgr.replaceInProgress("sess-1", turnRows(
        { role: "assistant", text: "running the review" },
        card("spawn-a", { status: "success", outputMarkdown: "## Findings" }),
      ));

      const cards = new ChatHistoryManager(dbManager).listSubAgentConsultCards("sess-1");
      expect(cards).toHaveLength(1);
      expect(cards[0]).toMatchObject({ status: "success", outputMarkdown: "## Findings" });
    });

    it("a stale rebuild cannot downgrade a terminal card back to pending", () => {
      const mgr = new ChatHistoryManager(dbManager);
      mgr.replaceInProgress("sess-1", turnRows(card("spawn-a", { status: "success", outputMarkdown: "## Findings" })));
      mgr.finalizeInProgress("sess-1");
      mgr.replaceInProgress("sess-1", turnRows(card("spawn-a")));

      const cards = new ChatHistoryManager(dbManager).listSubAgentConsultCards("sess-1");
      expect(cards).toHaveLength(1);
      expect(cards[0]).toMatchObject({ status: "success", outputMarkdown: "## Findings" });
    });

    it("re-anchors a replaced card instead of freezing it above its own turn", () => {
      // The other half of finding 2: when a finalized twin exists and the batch
      // copy is at least as current, the surviving row is dropped and the card
      // re-inserted at its anchor. Patching the twin in place would keep the
      // data and lose the position — the card floating above the groups that
      // preceded it, which is the regression the preserve step is conditional
      // to avoid.
      const mgr = new ChatHistoryManager(dbManager);
      const rows = (status: "pending" | "success") => turnRows(
        { role: "assistant", text: "before the consult" },
        card("spawn-a", { status }),
        { role: "assistant", text: "after the consult" },
      );
      mgr.replaceInProgress("sess-1", rows("pending"));
      // A foreign rebuild orphans the card, so the preserve step finalizes THAT
      // ROW ALONE — the state the twin branch actually sees in production.
      mgr.replaceInProgress("sess-1", turnRows({ role: "assistant", text: "a preempting turn" }));
      // The original turn is alive after all and flushes its recorded card.
      mgr.replaceInProgress("sess-1", rows("success"));

      const all = new ChatHistoryManager(dbManager).load("sess-1");
      expect(all.map((m) => (m.subAgentConsult ? "<card>" : m.text))).toEqual([
        "before the consult",
        "<card>",
        "after the consult",
      ]);
      expect(all[1].subAgentConsult).toMatchObject({ status: "success" });
    });

    it("leaves the card at its anchor while its own turn is still rebuilding", () => {
      // Why the preserve is conditional on the batch: finalize a row the LIVE
      // turn still owns and its id freezes while the assistant rows around it
      // are reborn with higher ones — the card floats to the top of its turn.
      const mgr = new ChatHistoryManager(dbManager);
      const rebuild = (tail: string[]) =>
        mgr.replaceInProgress("sess-1", turnRows(
          { role: "assistant", text: "before the consult" },
          card("spawn-a", { status: "success" }),
          ...tail.map((t) => ({ role: "assistant" as const, text: t })),
        ));
      rebuild([]);
      rebuild(["after the consult"]);
      rebuild(["after the consult", "and later still"]);

      const all = new ChatHistoryManager(dbManager).load("sess-1");
      expect(all.map((m) => (m.subAgentConsult ? "<card>" : m.text))).toEqual([
        "before the consult",
        "<card>",
        "after the consult",
        "and later still",
      ]);
    });
  });

  describe("replaceInProgress notice dedupe (double failover-notice incident)", () => {
    const notice = (noticeId: string, text = "Claude2 is out of quota."): PersistedMessage => ({
      role: "assistant",
      text,
      notice: true,
      noticeLevel: "info",
      noticeId,
    });

    it("skips a notice whose id already exists as a finalized row", () => {
      const mgr = new ChatHistoryManager(dbManager);
      // Turn start: the env-prep notice is written in-progress…
      mgr.replaceInProgress("sess-1", [{ ...notice("n-1"), inProgress: true }]);
      // …and a stale teardown finalizes it out from under the turn.
      mgr.finalizeInProgress("sess-1");
      // The turn's next boundary rebuilds from `recordedCards`, which still
      // hold the notice — the finalized copy must win, not duplicate.
      mgr.replaceInProgress("sess-1", [
        { ...notice("n-1"), inProgress: true },
        { role: "assistant", text: "working…", inProgress: true },
      ]);
      mgr.finalizeInProgress("sess-1");

      const notices = mgr.load("sess-1").filter((m) => m.notice);
      expect(notices).toHaveLength(1);
      expect(notices[0].noticeId).toBe("n-1");
    });

    it("does not dedupe distinct notices or notices without a finalized twin", () => {
      const mgr = new ChatHistoryManager(dbManager);
      mgr.append("sess-1", notice("n-old", "an earlier, unrelated notice"));
      mgr.replaceInProgress("sess-1", [
        { ...notice("n-a"), inProgress: true },
        { ...notice("n-b", "a second, different notice"), inProgress: true },
      ]);
      mgr.finalizeInProgress("sess-1");

      expect(mgr.load("sess-1").filter((m) => m.notice)).toHaveLength(3);
    });

    it("scopes the dedupe to the session", () => {
      const mgr = new ChatHistoryManager(dbManager);
      mgr.append("sess-other", notice("n-1"));
      mgr.replaceInProgress("sess-1", [{ ...notice("n-1"), inProgress: true }]);
      mgr.finalizeInProgress("sess-1");

      expect(mgr.load("sess-1").filter((m) => m.notice)).toHaveLength(1);
      expect(mgr.load("sess-other").filter((m) => m.notice)).toHaveLength(1);
    });
  });

  describe("listPendingSubAgentConsultCards (planning#309)", () => {
    const consultWith = (spawnId: string, status: SubAgentConsultCard["status"]): PersistedMessage => ({
      role: "assistant",
      text: "",
      subAgentConsult: {
        cardId: `card-${spawnId}`,
        spawnId,
        subAgentId: "codex",
        status,
        createdAt: "2026-08-04T00:00:00.000Z",
      },
    });

    it("returns every pending card across ALL sessions, with its owning session", () => {
      // The boot sweep does not know which sessions were running when the
      // previous orchestrator died — that is why this read is not per-session.
      const mgr = new ChatHistoryManager(dbManager);
      mgr.append("sess-1", consultWith("spawn-a", "pending"));
      mgr.append("sess-1", consultWith("spawn-b", "success"));
      mgr.append("sess-2", consultWith("spawn-c", "pending"));
      mgr.append("sess-2", consultWith("spawn-d", "cancelled"));
      mgr.append("sess-3", { role: "assistant", text: "no consults here" });

      const pendingCards = new ChatHistoryManager(dbManager).listPendingSubAgentConsultCards();
      expect(pendingCards.map((p) => [p.sessionId, p.card.spawnId])).toEqual([
        ["sess-1", "spawn-a"],
        ["sess-2", "spawn-c"],
      ]);
    });

    it("includes a card still inside its own in-progress turn", () => {
      // The foreground-consult strand: the card never reached in_progress=0
      // because the turn holding it never finalized.
      const mgr = new ChatHistoryManager(dbManager);
      mgr.replaceInProgress("sess-1", [{ ...consultWith("spawn-a", "pending"), inProgress: true }]);
      expect(mgr.listPendingSubAgentConsultCards()).toHaveLength(1);
    });

    it("is empty when nothing is pending", () => {
      const mgr = new ChatHistoryManager(dbManager);
      mgr.append("sess-1", consultWith("spawn-a", "success"));
      expect(mgr.listPendingSubAgentConsultCards()).toEqual([]);
    });
  });

  describe("upsertReleaseCard (docs/171)", () => {
    const proposed = (cardId = "release:sess-1:v0.3.0") => ({
      sessionId: "sess-1",
      cardId,
      phase: "proposed" as const,
      version: "0.3.0",
      tag: "v0.3.0",
      prerelease: false,
      bumpType: "minor" as const,
    });

    it("appends a carrier message on first upsert (propose)", () => {
      const mgr = new ChatHistoryManager(dbManager);
      mgr.append("sess-1", { role: "assistant", text: "Proposing a release." });
      mgr.upsertReleaseCard("sess-1", proposed());

      const loaded = mgr.load("sess-1");
      expect(loaded).toHaveLength(2);
      // Lands after the agent's turn (append-at-end), like a post-turn notice.
      expect(loaded[1].releaseCard?.phase).toBe("proposed");
      expect(loaded[1].text).toBe("");
    });

    it("patches the same row in place on later transitions (no duplicate)", () => {
      const mgr = new ChatHistoryManager(dbManager);
      mgr.upsertReleaseCard("sess-1", proposed());
      mgr.upsertReleaseCard("sess-1", { ...proposed(), phase: "gating", commitSha: "abc" });
      mgr.upsertReleaseCard("sess-1", { ...proposed(), phase: "released" });

      const cards = mgr.load("sess-1").filter((m) => m.releaseCard);
      expect(cards).toHaveLength(1);
      expect(cards[0].releaseCard?.phase).toBe("released");
    });

    it("survives a reload (fresh manager rebuilds from the DB)", () => {
      const mgr = new ChatHistoryManager(dbManager);
      mgr.upsertReleaseCard("sess-1", { ...proposed(), phase: "cancelled" });

      const reloaded = new ChatHistoryManager(dbManager).load("sess-1");
      expect(reloaded[0].releaseCard?.phase).toBe("cancelled");
    });

    it("keeps distinct releases (different tag → different cardId) separate", () => {
      const mgr = new ChatHistoryManager(dbManager);
      mgr.upsertReleaseCard("sess-1", { ...proposed("release:sess-1:v0.3.0"), phase: "released" });
      mgr.upsertReleaseCard("sess-1", { ...proposed("release:sess-1:v0.4.0"), tag: "v0.4.0", version: "0.4.0" });

      const cards = mgr.load("sess-1").filter((m) => m.releaseCard);
      expect(cards).toHaveLength(2);
    });
  });

  describe("permission-request card persistence (docs/193)", () => {
    const pendingCard = (requestId: string): PersistedMessage => ({
      role: "assistant",
      text: "",
      permissionPrompt: {
        requestId,
        phase: "pending",
        toolName: "Write",
        path: ".npmrc",
        summary: "Write .npmrc",
        agentId: "claude",
        createdAt: "2026-06-11T00:00:00.000Z",
      },
    });

    it("persists a pending permission card so it replays on session attach", () => {
      const mgr = new ChatHistoryManager(dbManager);
      const msg = pendingCard("perm-1");
      mgr.append("sess-1", msg);
      const loaded = new ChatHistoryManager(dbManager).load("sess-1");
      expect(loaded[0].permissionPrompt).toEqual(msg.permissionPrompt);
    });

    it("updatePermissionCard flips a card to approved+remembered, preserving fields", () => {
      const mgr = new ChatHistoryManager(dbManager);
      mgr.append("sess-1", { role: "user", text: "add a line to .npmrc" });
      mgr.append("sess-1", pendingCard("perm-1"));

      const found = mgr.updatePermissionCard("sess-1", "perm-1", { phase: "approved", remembered: true });
      expect(found).toBe(true);

      const card = mgr.load("sess-1")[1].permissionPrompt;
      expect(card?.phase).toBe("approved");
      expect(card?.remembered).toBe(true);
      // Original request fields survive the merge.
      expect(card?.toolName).toBe("Write");
      expect(card?.path).toBe(".npmrc");
    });

    it("updatePermissionCard records a denied terminal state", () => {
      const mgr = new ChatHistoryManager(dbManager);
      mgr.append("sess-1", pendingCard("perm-1"));
      mgr.updatePermissionCard("sess-1", "perm-1", { phase: "denied" });
      expect(mgr.load("sess-1")[0].permissionPrompt?.phase).toBe("denied");
    });

    it("returns false when no permission card matches the given id", () => {
      const mgr = new ChatHistoryManager(dbManager);
      mgr.append("sess-1", pendingCard("perm-1"));
      expect(mgr.updatePermissionCard("sess-1", "missing", { phase: "approved" })).toBe(false);
    });

    // Regression: the permission card resolves MID-TURN (the agent is blocked
    // awaiting the answer), unlike bug-report / issue-write cards which resolve
    // after their turn finalizes. So a DB-only `updatePermissionCard` patch is
    // clobbered by the next in-progress rebuild — the card reverts to its
    // Approve/Deny variant on the next switch/reload. The fix patches the
    // recorded card so each rebuild carries the terminal phase.
    it("a later in-progress rebuild clobbers a DB-only patch, but a rebuild from the patched card survives", () => {
      const mgr = new ChatHistoryManager(dbManager);
      mgr.append("sess-1", { role: "user", text: "add a line to .npmrc" });

      // Proposing turn persists the assistant group + the pending card in-progress
      // (what emitChatCard → persistTurnInProgress does on the request).
      const inProgress = (card: PersistedMessage): PersistedMessage[] => [
        { role: "assistant", text: "editing .npmrc", inProgress: true },
        { ...card, inProgress: true },
      ];
      mgr.replaceInProgress("sess-1", inProgress(pendingCard("perm-1")));

      // DB-only patch flips it to approved...
      mgr.updatePermissionCard("sess-1", "perm-1", { phase: "approved", remembered: true });
      expect(mgr.load("sess-1").find((m) => m.permissionPrompt?.requestId === "perm-1")?.permissionPrompt?.phase).toBe("approved");

      // ...but the NEXT rebuild of the same in-progress turn re-inserts from the
      // turn's recorded cards, which still hold pending — reverting the card.
      // This is the clobber `updateRecordedCard` prevents.
      mgr.replaceInProgress("sess-1", inProgress(pendingCard("perm-1")));
      expect(mgr.load("sess-1").find((m) => m.permissionPrompt?.requestId === "perm-1")?.permissionPrompt?.phase).toBe("pending");

      // With the recorded card itself patched to approved, every rebuild — and
      // the final end-of-turn persist — carries the terminal phase.
      const approved = pendingCard("perm-1");
      approved.permissionPrompt = { ...approved.permissionPrompt!, phase: "approved", remembered: true };
      mgr.replaceInProgress("sess-1", inProgress(approved));
      const card = mgr.load("sess-1").find((m) => m.permissionPrompt?.requestId === "perm-1")?.permissionPrompt;
      expect(card?.phase).toBe("approved");
      expect(card?.remembered).toBe(true);
    });
  });

  describe("egress allow-once card lifecycle (docs/172, planning#92)", () => {
    const pendingEgress = (cardId: string): PersistedMessage => ({
      role: "assistant",
      text: "",
      egressPrompt: { cardId, host: "cdn.example.com", phase: "pending", createdAt: "2026-06-13T00:00:00.000Z" },
    });

    it("updateEgressPromptCard flips a card to a resolved phase, preserving host", () => {
      const mgr = new ChatHistoryManager(dbManager);
      mgr.append("sess-1", pendingEgress("eg-1"));
      expect(mgr.updateEgressPromptCard("sess-1", "eg-1", { phase: "added" })).toBe(true);
      const card = mgr.load("sess-1")[0].egressPrompt;
      expect(card?.phase).toBe("added");
      expect(card?.host).toBe("cdn.example.com");
    });

    it("returns false when no egress card matches the given id", () => {
      const mgr = new ChatHistoryManager(dbManager);
      mgr.append("sess-1", pendingEgress("eg-1"));
      expect(mgr.updateEgressPromptCard("sess-1", "missing", { phase: "denied" })).toBe(false);
    });
  });

  it("round-trips a message carrying every optional field (serialization contract)", () => {
    const mgr = new ChatHistoryManager(dbManager);
    mgr.append("sess-1", EVERY_OPTIONAL_FIELD_MESSAGE);
    expect(mgr.load("sess-1")[0]).toEqual(EVERY_OPTIONAL_FIELD_MESSAGE);
  });

  it("degrades a legacy agent_review row to a plain aiReview card (docs/203 migration)", () => {
    const mgr = new ChatHistoryManager(dbManager);
    // Simulate a pre-docs/203 row: only the legacy `agent_review` column is set
    // (no `ai_review`). It must still render as a degraded `aiReview` card.
    dbManager.db
      .prepare(
        "INSERT INTO messages (session_id, role, content, agent_review) VALUES (?, 'assistant', '', ?)",
      )
      .run(
        "sess-legacy",
        JSON.stringify({
          reviewId: "legacy-1",
          filePath: "docs/old.md",
          fileType: "markdown",
          findingCount: 3,
          snapshotHash: "deadbeef",
          createdAt: "2026-01-01T00:00:00.000Z",
        }),
      );
    const [msg] = mgr.load("sess-legacy");
    expect(msg.aiReview).toEqual({
      reviewId: "legacy-1",
      filePath: "docs/old.md",
      markdown: "",
      reviewerLabel: "Reviewed earlier",
      legacy: true,
      findingCount: 3,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
  });

  it("prefers a present ai_review over a legacy agent_review on the same row", () => {
    const mgr = new ChatHistoryManager(dbManager);
    const card = {
      reviewId: "r9",
      filePath: "a.ts",
      markdown: "No material issues found.",
      reviewerLabel: "Reviewed by Claude",
      createdAt: "2026-06-05T00:00:00.000Z",
    };
    dbManager.db
      .prepare(
        "INSERT INTO messages (session_id, role, content, agent_review, ai_review) VALUES (?, 'assistant', '', ?, ?)",
      )
      .run("sess-both", JSON.stringify({ reviewId: "old", filePath: "a.ts", findingCount: 1, createdAt: "x" }), JSON.stringify(card));
    expect(mgr.load("sess-both")[0].aiReview).toEqual(card);
  });

  it("every inline-card field is exercised by the serialization contract (no emit-only cards, docs/188)", () => {
    // The forcing function that kills the recurring bug class: every field in
    // CARD_MESSAGE_FIELDS (the single list that also drives `hasCardContent`, so
    // it's the only way to make a card render) MUST appear in the round-trip
    // message above. Combined with the deep-equal round-trip test, this chains:
    //   in the render list ⇒ must be in this contract message ⇒ must survive
    //   append→load ⇒ must have a DB column + toRow/fromRow.
    // So a new card that ships emit-only (renders live, vanishes on reload)
    // turns CI red, naming the missing field.
    for (const field of CARD_MESSAGE_FIELDS) {
      expect(
        EVERY_OPTIONAL_FIELD_MESSAGE[field],
        `Card field "${field}" is in CARD_MESSAGE_FIELDS but missing from the serialization contract — ` +
          `add it to EVERY_OPTIONAL_FIELD_MESSAGE and wire its column + toRow/fromRow so it survives a reload.`,
      ).toBeDefined();
    }
  });

  describe("issue-write card persistence (docs/177)", () => {
    const writeCard = (cardId: string): PersistedMessage => ({
      role: "assistant",
      text: "",
      issueWrite: {
        cardId,
        // docs/248 — a card records BOTH the destination the write reached and
        // the name it was addressed by: the destination so an Undo survives the
        // repository dropping the declaration (req 11), the name so a re-point
        // re-targets it (req 16).
        tracker: "github:acme/planning",
        trackerName: "planning",
        issueId: "42",
        identifier: "planning#42",
        title: "Bug",
        url: "https://github.com/acme/planning/issues/42",
        verb: "comment",
        summary: "commented on planning#42",
        content: { comment: "Repro'd on staging — clamping the offset. PR incoming." },
        attribution: "user",
        undo: { kind: "comment", commentId: "c-99" },
        undoState: "available",
        createdAt: "2026-06-05T00:00:00.000Z",
      },
    });

    it("persists a write card so it replays on session attach", () => {
      const mgr = new ChatHistoryManager(dbManager);
      const msg = writeCard("iw-1");
      mgr.append("sess-1", msg);
      const loaded = new ChatHistoryManager(dbManager).load("sess-1");
      expect(loaded[0].issueWrite).toEqual(msg.issueWrite);
    });

    it("round-trips an edit card's label/priority undo snapshot (planning#94)", () => {
      const mgr = new ChatHistoryManager(dbManager);
      const msg: PersistedMessage = {
        role: "assistant",
        text: "",
        issueWrite: {
          cardId: "iw-edit",
          tracker: "linear",
          issueId: "SHI-9",
          identifier: "SHI-9",
          title: "Doc",
          verb: "edit",
          summary: "edited labels & priority on SHI-9 (priority: High; labels: security)",
          attribution: "workspace",
          undo: { kind: "edit", previousLabels: ["backend"], previousPriority: "low" },
          undoState: "available",
          createdAt: "2026-06-05T00:00:00.000Z",
        },
      };
      mgr.append("sess-1", msg);
      const card = new ChatHistoryManager(dbManager).load("sess-1")[0].issueWrite;
      expect(card?.undo).toEqual({ kind: "edit", previousLabels: ["backend"], previousPriority: "low" });
    });

    it("round-trips a comment-edit card's previous-body undo snapshot (planning#88)", () => {
      const mgr = new ChatHistoryManager(dbManager);
      const msg: PersistedMessage = {
        role: "assistant",
        text: "",
        issueWrite: {
          cardId: "iw-comment-edit",
          tracker: "linear",
          issueId: "SHI-9",
          identifier: "SHI-9",
          title: "Doc",
          verb: "comment-edit",
          summary: "edited a comment on SHI-9",
          // Line 2 shows the NEW body; the prior text lives on the snapshot.
          content: { comment: "Corrected: the migration replays 1,344 comments." },
          attribution: "workspace",
          undo: { kind: "comment-edit", commentId: "c-99", previousBody: "the original text" },
          undoState: "available",
          createdAt: "2026-06-05T00:00:00.000Z",
        },
      };
      mgr.append("sess-1", msg);
      const card = new ChatHistoryManager(dbManager).load("sess-1")[0].issueWrite;
      // The whole card survives a reload — without the snapshot the Undo button
      // would render with nothing to restore.
      expect(card).toEqual(msg.issueWrite);
    });

    it("round-trips a label-edit card's prior-values undo snapshot (planning#88)", () => {
      const mgr = new ChatHistoryManager(dbManager);
      const msg: PersistedMessage = {
        role: "assistant",
        text: "",
        issueWrite: {
          cardId: "iw-label-edit",
          tracker: "github:acme/planning",
          trackerName: "planning",
          // A label write targets tracker CONFIG, so there is no issue: the
          // identifier is the label's name AS IT NOW STANDS.
          issueId: "",
          identifier: "Bug",
          title: "",
          verb: "label-edit",
          summary: 'edited label renamed "bug" → "Bug", color → #d73a4a',
          content: { label: { before: "bug", after: "Bug" }, attrs: "color → #d73a4a" },
          attribution: "user",
          undo: {
            kind: "label-edit",
            labelId: "Bug",
            previousName: "bug",
            previousColor: "#ededed",
          },
          undoState: "available",
          createdAt: "2026-06-05T00:00:00.000Z",
        },
      };
      mgr.append("sess-1", msg);
      const card = new ChatHistoryManager(dbManager).load("sess-1")[0].issueWrite;
      // Without the snapshot surviving a reload the Undo button would render
      // with nothing to restore — the label would stay wrong the other way.
      expect(card).toEqual(msg.issueWrite);
    });

    it("round-trips the docs/189 line-2 content (comment preview, status delta)", () => {
      const mgr = new ChatHistoryManager(dbManager);
      mgr.append("sess-1", writeCard("iw-comment"));
      const statusMsg: PersistedMessage = {
        role: "assistant",
        text: "",
        issueWrite: {
          cardId: "iw-status",
          tracker: "linear",
          issueId: "SHI-9",
          identifier: "SHI-9",
          title: "Doc",
          verb: "status",
          summary: "set SHI-9 → In Review",
          content: { status: { from: "In Progress", to: "In Review" } },
          attribution: "workspace",
          undo: { kind: "status", previousStatus: "In Progress" },
          undoState: "available",
          createdAt: "2026-06-05T00:00:00.000Z",
        },
      };
      mgr.append("sess-1", statusMsg);
      const loaded = new ChatHistoryManager(dbManager).load("sess-1");
      expect(loaded[0].issueWrite?.content).toEqual({
        comment: "Repro'd on staging — clamping the offset. PR incoming.",
      });
      expect(loaded[1].issueWrite?.content).toEqual({ status: { from: "In Progress", to: "In Review" } });
    });

    it("findIssueWriteCard recovers the tracker + undo snapshot by id", () => {
      const mgr = new ChatHistoryManager(dbManager);
      mgr.append("sess-1", { role: "user", text: "comment please" });
      mgr.append("sess-1", writeCard("iw-1"));
      const card = mgr.findIssueWriteCard("sess-1", "iw-1");
      expect(card?.tracker).toBe("github:acme/planning");
      expect(card?.trackerName).toBe("planning");
      expect(card?.undo).toEqual({ kind: "comment", commentId: "c-99" });
      expect(mgr.findIssueWriteCard("sess-1", "missing")).toBeNull();
    });

    it("updateIssueWriteCard flips a card to undone in place", () => {
      const mgr = new ChatHistoryManager(dbManager);
      mgr.append("sess-1", writeCard("iw-1"));
      expect(mgr.updateIssueWriteCard("sess-1", "iw-1", { undoState: "undone" })).toBe(true);
      const card = mgr.load("sess-1")[0].issueWrite;
      expect(card?.undoState).toBe("undone");
      // Original fields survive the merge.
      expect(card?.summary).toBe("commented on planning#42");
    });

    it("returns false when no write card matches the given id", () => {
      const mgr = new ChatHistoryManager(dbManager);
      mgr.append("sess-1", writeCard("iw-1"));
      expect(mgr.updateIssueWriteCard("sess-1", "missing", { undoState: "undone" })).toBe(false);
    });
  });

  describe("issue-ref card persistence (docs/188)", () => {
    const refCard = (cardId: string): PersistedMessage => ({
      role: "assistant",
      text: "",
      issueRef: {
        cardId,
        tracker: "github",
        identifier: "octocat/hello#42",
        title: "Bug",
        url: "https://github.com/octocat/hello/issues/42",
        status: "Open",
        statusType: "started",
        createdAt: "2026-06-05T00:00:00.000Z",
      },
    });

    it("persists a read card so it replays on session attach", () => {
      const mgr = new ChatHistoryManager(dbManager);
      const msg = refCard("ir-1");
      mgr.append("sess-1", msg);
      const loaded = new ChatHistoryManager(dbManager).load("sess-1");
      expect(loaded[0].issueRef).toEqual(msg.issueRef);
    });
  });

  it("persists error messages with isError flag", () => {
    const mgr = new ChatHistoryManager(dbManager);
    mgr.append("sess-1", { role: "assistant", text: "Error: something broke", isError: true });

    const loaded = mgr.load("sess-1");
    expect(loaded[0].isError).toBe(true);
  });

  it("deletes a session's history", () => {
    const mgr = new ChatHistoryManager(dbManager);
    mgr.append("sess-1", { role: "user", text: "To delete" });

    const deleted = mgr.delete("sess-1");
    expect(deleted).toBe(true);
    expect(mgr.load("sess-1")).toEqual([]);
  });

  it("returns false when deleting nonexistent session", () => {
    const mgr = new ChatHistoryManager(dbManager);
    expect(mgr.delete("nonexistent")).toBe(false);
  });

  it("lists session IDs that have stored history", () => {
    const mgr = new ChatHistoryManager(dbManager);
    mgr.append("sess-a", { role: "user", text: "A" });
    mgr.append("sess-b", { role: "user", text: "B" });

    const ids = mgr.listSessions();
    expect(ids).toContain("sess-a");
    expect(ids).toContain("sess-b");
    expect(ids).toHaveLength(2);
  });

  it("loads persisted history across manager instances", () => {
    const mgr1 = new ChatHistoryManager(dbManager);
    mgr1.append("sess-1", { role: "user", text: "Persisted" });

    const mgr2 = new ChatHistoryManager(dbManager);
    const loaded = mgr2.load("sess-1");
    expect(loaded).toHaveLength(1);
    expect(loaded[0].text).toBe("Persisted");
  });

  it("persists subagent events for Task tool transparency (109)", () => {
    const mgr = new ChatHistoryManager(dbManager);
    const msg: PersistedMessage = {
      role: "assistant",
      text: "Spawning subagent...",
      toolUse: [
        {
          type: "tool_use",
          id: "task-1",
          name: "Task",
          input: { description: "Audit", prompt: "Audit the codebase." },
        },
      ],
      toolResults: [{ toolUseId: "task-1", content: "## Report\n\nDone." }],
      subagentEvents: [
        {
          kind: "assistant",
          parentToolUseId: "task-1",
          text: "Reading...",
          toolUse: [
            { type: "tool_use", id: "sub-r1", name: "Read", input: { file_path: "/a.ts" } },
          ],
        },
        {
          kind: "tool_result",
          parentToolUseId: "task-1",
          toolResults: [{ toolUseId: "sub-r1", content: "file contents" }],
        },
      ],
    };

    mgr.append("sess-1", msg);

    // Reload via a fresh instance to confirm round-trip serialization works.
    const mgr2 = new ChatHistoryManager(dbManager);
    const loaded = mgr2.load("sess-1");
    expect(loaded).toHaveLength(1);
    expect(loaded[0].subagentEvents).toHaveLength(2);
    expect(loaded[0].subagentEvents![0].kind).toBe("assistant");
    expect(loaded[0].subagentEvents![0].parentToolUseId).toBe("task-1");
    expect(loaded[0].subagentEvents![1].kind).toBe("tool_result");
  });

  describe("updateLastMessage", () => {
    it("merges fields into the last finalized message", () => {
      const mgr = new ChatHistoryManager(dbManager);
      mgr.append("sess-1", { role: "assistant", text: "Done" });

      const updatedId = mgr.updateLastMessage("sess-1", { commitHash: "abc123" });

      expect(updatedId).not.toBeNull();
      const messages = mgr.load("sess-1");
      expect(messages).toHaveLength(1);
      expect(messages[0].text).toBe("Done");
      expect(messages[0].commitHash).toBe("abc123");
    });

    it("updates only the last message when multiple exist", () => {
      const mgr = new ChatHistoryManager(dbManager);
      mgr.append("sess-1", { role: "user", text: "Hello" });
      mgr.append("sess-1", { role: "assistant", text: "Hi" });

      mgr.updateLastMessage("sess-1", { text: "Updated hi" });

      const messages = mgr.load("sess-1");
      expect(messages).toHaveLength(2);
      expect(messages[0].text).toBe("Hello");
      expect(messages[1].text).toBe("Updated hi");
    });

    it("skips in-progress rows so postTurnCommit doesn't stamp commit info on a stale next-turn row", () => {
      // Regression: the previous behavior selected the absolute last row by id.
      // If the next turn had already inserted in_progress=1 rows when
      // postTurnCommit ran, the commit_hash got stamped on one of those
      // transient rows — and the next replaceInProgress wiped it. The result
      // was an "0 files" rewind preview for a turn that genuinely committed.
      const mgr = new ChatHistoryManager(dbManager);
      mgr.append("sess-1", { role: "user", text: "first" });
      mgr.append("sess-1", { role: "assistant", text: "finalized answer" });
      // Next turn has begun and persisted an in-progress placeholder.
      mgr.append("sess-1", { role: "assistant", text: "next turn streaming...", inProgress: true });

      const updatedId = mgr.updateLastMessage("sess-1", { commitHash: "deadbeef" });

      expect(updatedId).not.toBeNull();
      const messages = mgr.load("sess-1");
      const finalized = messages.find((m) => m.text === "finalized answer");
      const transient = messages.find((m) => m.text === "next turn streaming...");
      expect(finalized?.commitHash).toBe("deadbeef");
      expect(transient?.commitHash).toBeUndefined();
    });

    it("is a no-op for an empty session", () => {
      const mgr = new ChatHistoryManager(dbManager);
      const id = mgr.updateLastMessage("nonexistent", { text: "ghost" });
      expect(id).toBeNull();
      expect(mgr.load("nonexistent")).toEqual([]);
    });
  });

  describe("truncate", () => {
    it("keeps only the first N messages", () => {
      const mgr = new ChatHistoryManager(dbManager);
      mgr.append("sess-1", { role: "user", text: "A" });
      mgr.append("sess-1", { role: "assistant", text: "B" });
      mgr.append("sess-1", { role: "user", text: "C" });
      mgr.append("sess-1", { role: "assistant", text: "D" });

      const kept = mgr.truncate("sess-1", 2);
      expect(kept).toHaveLength(2);
      expect(kept[0].text).toBe("A");
      expect(kept[1].text).toBe("B");

      // Verify persisted state
      const loaded = mgr.load("sess-1");
      expect(loaded).toHaveLength(2);
    });

    it("returns all messages when count exceeds total", () => {
      const mgr = new ChatHistoryManager(dbManager);
      mgr.append("sess-1", { role: "user", text: "Only one" });

      const kept = mgr.truncate("sess-1", 10);
      expect(kept).toHaveLength(1);
      expect(kept[0].text).toBe("Only one");
    });

    it("returns empty for a session with no messages", () => {
      const mgr = new ChatHistoryManager(dbManager);
      const kept = mgr.truncate("nonexistent", 5);
      expect(kept).toEqual([]);
    });
  });

  describe("transaction error propagation", () => {
    it("saveMessages rolls back on error and preserves original data", () => {
      const mgr = new ChatHistoryManager(dbManager);
      mgr.append("sess-1", { role: "user", text: "Original" });

      // Corrupt the insert statement to force an error mid-transaction
      const internal = mgr as any;
      const origRun = internal.stmtInsert.run;
      let callCount = 0;
      vi.spyOn(internal.stmtInsert, "run").mockImplementation(function (this: unknown, ...args: unknown[]) {
        callCount++;
        if (callCount === 2) throw new Error("Simulated DB error");
        return origRun.apply(this, args);
      });

      // saveMessages: deletes existing + inserts new → error on 2nd insert should roll back
      expect(() =>
        mgr.saveMessages("sess-1", [
          { role: "user", text: "New A" },
          { role: "assistant", text: "New B" },
        ]),
      ).toThrow("Simulated DB error");

      vi.restoreAllMocks();

      // Original data should be intact (transaction rolled back the delete + first insert)
      const messages = mgr.load("sess-1");
      expect(messages).toHaveLength(1);
      expect(messages[0].text).toBe("Original");
    });
  });

  // docs/252 phase 7 (req 9) — the notice must still be findable after a reload,
  // and dismissal is STATE on the row rather than its removal: deleting it would
  // make "I read this" and "it never happened" the same thing on the next load,
  // and would take the record of a recurring failure with it.
  it("keeps a dismissed non-turn-failure notice in history with its dismissal stamped", () => {
    const mgr = new ChatHistoryManager(dbManager);
    mgr.append("sess-1", {
      role: "assistant",
      text: "",
      nonTurnFailure: {
        cardId: "ntf-1",
        purpose: "session-naming",
        serviceId: "deepseek",
        serviceName: "DeepSeek",
        billingMode: "key",
        modelId: "deepseek-v4-flash",
        fallback: "The session kept its placeholder title.",
        createdAt: "2026-08-09T00:00:00.000Z",
      },
    });

    expect(mgr.updateNonTurnFailureCard("sess-1", "ntf-1", { dismissedAt: "2026-08-09T00:05:00.000Z" }))
      .toBe(true);

    const reloaded = mgr.load("sess-1");
    expect(reloaded).toHaveLength(1);
    expect(reloaded[0].nonTurnFailure?.dismissedAt).toBe("2026-08-09T00:05:00.000Z");
    expect(reloaded[0].nonTurnFailure?.serviceName).toBe("DeepSeek");
  });

  it("reports false when dismissing a notice that is not in this session", () => {
    const mgr = new ChatHistoryManager(dbManager);
    expect(mgr.updateNonTurnFailureCard("sess-1", "missing", { dismissedAt: "x" })).toBe(false);
  });

  describe("consumeUnreportedBugOutcomes (nikzlabs/shipit#2350)", () => {
    const card = (over: Record<string, unknown>) => ({
      cardId: "c1",
      phase: "draft",
      title: "Preview won't reload",
      body: "b",
      stage2Ran: true,
      producer: "session",
      ...over,
    });

    it("returns a resolved card once, then never again", () => {
      const mgr = new ChatHistoryManager(dbManager);
      mgr.append("s1", {
        role: "assistant",
        text: "",
        bugReport: card({ phase: "filed", issueNumber: 7, issueUrl: "u" }) as never,
      });

      const first = mgr.consumeUnreportedBugOutcomes("s1");
      expect(first).toHaveLength(1);
      expect(first[0].issueNumber).toBe(7);
      // The mark is durable, so a second turn — or a restart — gets nothing.
      expect(mgr.consumeUnreportedBugOutcomes("s1")).toHaveLength(0);
      expect(new ChatHistoryManager(dbManager).consumeUnreportedBugOutcomes("s1")).toHaveLength(0);
    });

    it("ignores cards that are not resolved", () => {
      const mgr = new ChatHistoryManager(dbManager);
      mgr.append("s1", { role: "assistant", text: "", bugReport: card({ phase: "draft" }) as never });
      mgr.append("s1", {
        role: "assistant",
        text: "",
        bugReport: card({ cardId: "c2", phase: "filing" }) as never,
      });
      expect(mgr.consumeUnreportedBugOutcomes("s1")).toHaveLength(0);
    });

    it("reports every card resolved since the last turn, not just the newest", () => {
      const mgr = new ChatHistoryManager(dbManager);
      mgr.append("s1", {
        role: "assistant",
        text: "",
        bugReport: card({ phase: "filed", issueNumber: 1, issueUrl: "u1" }) as never,
      });
      mgr.append("s1", {
        role: "assistant",
        text: "",
        bugReport: card({ cardId: "c2", phase: "dismissed" }) as never,
      });
      // The single last-write-wins `pendingAgentNotice` slot could not do this,
      // which is why the flag lives on the card.
      expect(mgr.consumeUnreportedBugOutcomes("s1").map((c) => c.cardId)).toEqual(["c1", "c2"]);
    });

    it("scopes to the session", () => {
      const mgr = new ChatHistoryManager(dbManager);
      mgr.append("s2", {
        role: "assistant",
        text: "",
        bugReport: card({ phase: "filed", issueNumber: 9, issueUrl: "u" }) as never,
      });
      expect(mgr.consumeUnreportedBugOutcomes("s1")).toHaveLength(0);
      expect(mgr.consumeUnreportedBugOutcomes("s2")).toHaveLength(1);
    });
  });
});

/**
 * planning#324 — the per-session transcript revision counter.
 *
 * The `/history` route uses this counter as the messages-half of its ETag, so
 * its one failure mode is a write path that forgets to bump: the route would
 * then answer 304 forever against a transcript that changed. That is why the
 * main test below is an ENUMERATION — one case per mutating method, each
 * failing by name if its method stops moving the counter. Adding a mutating
 * method without a bump fails `updateLastMessage`-style cases only by accident,
 * so the list is the contract: add the method, add the case.
 *
 * The flip side is pinned too: provable no-ops must NOT move the counter, or
 * every no-op patch invalidates a transcript that did not change.
 */
describe("transcript revision counter", () => {
  let dbManager: DatabaseManager;
  let mgr: ChatHistoryManager;

  beforeEach(() => {
    dbManager = new DatabaseManager(":memory:");
    mgr = new ChatHistoryManager(dbManager);
  });

  afterEach(() => {
    dbManager.close();
  });

  /** Verbatim CLI launch acknowledgement (see subagent-completion.test.ts). */
  const LAUNCH_ACK = JSON.stringify([
    {
      type: "text",
      text: [
        "Async agent launched successfully. (This tool result is internal metadata — never quote or paste any part of it, including the agentId below, into a user-facing reply.)",
        "agentId: af0615944a51b4583 (internal ID - do not mention to user. Use SendMessage with to: 'af0615944a51b4583', summary: '<5-10 word recap>' to continue this agent.)",
        "The agent is working in the background. You will be notified automatically when it completes.",
        "output_file: /tmp/claude-1000/-tmp-probe/3bc49c90/tasks/af0615944a51b4583.output",
      ].join("\n"),
    },
  ]);
  const RETIRE_TOOL_ID = "toolu_013fUMwLfWGNwaaqVsj8ojXF";
  const RETIRE_REPORT = "## Probe report\n\nThe number seven holds profound significance.";

  function seed(sid: string): void {
    mgr.append(sid, { role: "user", text: "Hello" });
    mgr.append(sid, { role: "assistant", text: "Hi" });
  }

  /** Row ids of a session's last `n` messages — `load()` deliberately carries no ids. */
  function lastRowIds(sid: string, n: number): number[] {
    const rows = dbManager.db.prepare(
      "SELECT id FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT ?",
    ).all(sid, n) as { id: number }[];
    return rows.map((r) => r.id);
  }

  /**
   * One row carrying EVERY card the in-place patch methods key on, plus the
   * launch-ack row `retireBackgroundSubagentResult` rewrites. The all-fields
   * fixture doubles as the seed because the patch methods match on cardId.
   */
  function seedCards(sid: string): void {
    mgr.append(sid, { ...EVERY_OPTIONAL_FIELD_MESSAGE });
    mgr.append(sid, {
      role: "assistant",
      text: "",
      toolUse: [{ type: "tool_use", id: RETIRE_TOOL_ID, name: "Agent", input: {} }],
      toolResults: [{ toolUseId: RETIRE_TOOL_ID, content: LAUNCH_ACK }],
    });
  }

  interface RevisionCase {
    name: string;
    seed: (sid: string) => void;
    mutate: (sid: string) => unknown;
  }

  const cases: RevisionCase[] = [
    {
      name: "append",
      seed: () => {},
      mutate: (sid) => mgr.append(sid, { role: "user", text: "one more" }),
    },
    {
      name: "updateLastMessage",
      seed,
      mutate: (sid) => mgr.updateLastMessage(sid, { commitHash: "abc123" }),
    },
    {
      name: "updateBugReportCard (in-place row patch)",
      seed: seedCards,
      mutate: (sid) => mgr.updateBugReportCard(sid, "b1", { phase: "dismissed" }),
    },
    {
      name: "consumeUnreportedBugOutcomes (marks filed cards)",
      seed: seedCards,
      mutate: (sid) => mgr.consumeUnreportedBugOutcomes(sid),
    },
    {
      name: "upsertReleaseCard patch branch (in-place row patch)",
      seed: seedCards,
      mutate: (sid) =>
        mgr.upsertReleaseCard(sid, { ...EVERY_OPTIONAL_FIELD_MESSAGE.releaseCard!, phase: "failed" }),
    },
    {
      name: "upsertReleaseCard append branch (no matching card yet)",
      seed,
      mutate: (sid) =>
        mgr.upsertReleaseCard(sid, {
          ...EVERY_OPTIONAL_FIELD_MESSAGE.releaseCard!,
          sessionId: sid,
          cardId: `release:${sid}:v0.3.0`,
        }),
    },
    {
      name: "updateEgressPromptCard (in-place row patch)",
      seed: seedCards,
      mutate: (sid) => mgr.updateEgressPromptCard(sid, "eg1", { phase: "allowed-once" }),
    },
    {
      name: "updatePermissionCard (in-place row patch)",
      seed: seedCards,
      mutate: (sid) => mgr.updatePermissionCard(sid, "p1", { phase: "denied" }),
    },
    {
      name: "retireBackgroundSubagentResult (rewrites a tool result in place)",
      seed: seedCards,
      mutate: (sid) => {
        const completion = {
          toolUseId: RETIRE_TOOL_ID,
          status: "completed" as const,
          summary: RETIRE_REPORT,
        };
        return mgr.retireBackgroundSubagentResult(sid, completion, buildRetiredSubagentResult(completion));
      },
    },
    {
      name: "updateSubAgentConsultCard (in-place row patch)",
      seed: seedCards,
      mutate: (sid) => mgr.updateSubAgentConsultCard(sid, "sac1", { durationMs: 5 }),
    },
    {
      name: "updateNonTurnFailureCard (in-place row patch)",
      seed: seedCards,
      mutate: (sid) =>
        mgr.updateNonTurnFailureCard(sid, "ntf1", { dismissedAt: "2026-08-21T00:00:00.000Z" }),
    },
    {
      name: "updateIssueWriteCard (in-place row patch)",
      seed: seedCards,
      mutate: (sid) => mgr.updateIssueWriteCard(sid, "iw1", { summary: "set SHI-28 → Todo" }),
    },
    {
      name: "truncate (deletes the tail)",
      seed: (sid) => {
        mgr.append(sid, { role: "user", text: "1" });
        mgr.append(sid, { role: "assistant", text: "2" });
        mgr.append(sid, { role: "user", text: "3" });
      },
      mutate: (sid) => mgr.truncate(sid, 1),
    },
    {
      name: "saveMessages (full rewrite)",
      seed,
      mutate: (sid) => mgr.saveMessages(sid, [{ role: "user", text: "rewritten" }]),
    },
    {
      name: "markRolledBackFromIndex",
      seed,
      mutate: (sid) => mgr.markRolledBackFromIndex(sid, 1, "c0ffee"),
    },
    {
      name: "clearRolledBack",
      seed: (sid) => {
        seed(sid);
        mgr.markRolledBackFromIndex(sid, 1, "c0ffee");
      },
      mutate: (sid) => {
        const rolledBack = lastRowIds(sid, 1);
        mgr.clearRolledBack(sid, rolledBack);
      },
    },
    {
      name: "deleteMessageById",
      seed,
      mutate: (sid) => mgr.deleteMessageById(sid, lastRowIds(sid, 1)[0]),
    },
    {
      name: "replaceInProgress (boundary rewrite)",
      seed,
      mutate: (sid) => mgr.replaceInProgress(sid, [
        { role: "assistant", text: "streaming…", inProgress: true },
      ]),
    },
    {
      name: "finalizeInProgress (flips in-progress rows)",
      seed: (sid) => {
        seed(sid);
        mgr.replaceInProgress(sid, [{ role: "assistant", text: "working", inProgress: true }]);
      },
      mutate: (sid) => mgr.finalizeInProgress(sid),
    },
    {
      name: "clearInProgress (error/abort teardown)",
      seed: (sid) => {
        seed(sid);
        mgr.replaceInProgress(sid, [{ role: "assistant", text: "working", inProgress: true }]);
      },
      mutate: (sid) => mgr.clearInProgress(sid),
    },
    {
      name: "delete (whole session)",
      seed,
      mutate: (sid) => mgr.delete(sid),
    },
  ];

  it.each(cases.map((c) => [c.name, c] as const))("moves on %s", (_name, c) => {
    const sid = `rev-${c.name.replace(/[^a-z0-9]+/gi, "-")}`;
    c.seed(sid);
    const before = mgr.transcriptRevision(sid);
    c.mutate(sid);
    expect(mgr.transcriptRevision(sid)).toBeGreaterThan(before);
  });

  it("reads 0 for a session with no mutations", () => {
    expect(mgr.transcriptRevision("never-touched")).toBe(0);
  });

  it("survives a manager re-instantiation over the same database", () => {
    seed("durable");
    const before = mgr.transcriptRevision("durable");
    const reopened = new ChatHistoryManager(dbManager);
    expect(reopened.transcriptRevision("durable")).toBe(before);
  });

  it("counts per session — another session's writes move nothing here", () => {
    seed("mine");
    const before = mgr.transcriptRevision("mine");
    mgr.append("theirs", { role: "user", text: "unrelated" });
    expect(mgr.transcriptRevision("mine")).toBe(before);
  });

  it("does not move on reads", () => {
    seed("read-only");
    const before = mgr.transcriptRevision("read-only");
    mgr.load("read-only");
    mgr.getBugReportCard("read-only", "missing");
    mgr.listSubAgentConsultCards("read-only");
    mgr.indexOfMessageId("read-only", 1);
    expect(mgr.transcriptRevision("read-only")).toBe(before);
  });

  // The no-op half of the contract: these paths write nothing, so bumping here
  // would invalidate transcripts that did not change. Each is a provable no-op
  // in the manager, and each test fails if someone makes one write anyway
  // without noticing the bump now lies.
  it("does not move when a card patch matches no row", () => {
    seedCards("no-match");
    const before = mgr.transcriptRevision("no-match");
    expect(mgr.updateBugReportCard("no-match", "wrong-id", { phase: "dismissed" })).toBe(false);
    expect(mgr.transcriptRevision("no-match")).toBe(before);
  });

  it("does not move when truncate keeps everything", () => {
    seed("keep-all");
    const before = mgr.transcriptRevision("keep-all");
    expect(mgr.truncate("keep-all", 99)).toHaveLength(2);
    expect(mgr.transcriptRevision("keep-all")).toBe(before);
  });

  it("does not move when finalizeInProgress has nothing to finalize", () => {
    seed("nothing-open");
    const before = mgr.transcriptRevision("nothing-open");
    mgr.finalizeInProgress("nothing-open");
    expect(mgr.transcriptRevision("nothing-open")).toBe(before);
  });

  it("does not move when deleteMessageById hits no row", () => {
    seed("no-row");
    const before = mgr.transcriptRevision("no-row");
    expect(mgr.deleteMessageById("no-row", 999999)).toBe(false);
    expect(mgr.transcriptRevision("no-row")).toBe(before);
  });

  it("does not move when consumeUnreportedBugOutcomes finds nothing to report", () => {
    seed("quiet");
    const before = mgr.transcriptRevision("quiet");
    expect(mgr.consumeUnreportedBugOutcomes("quiet")).toHaveLength(0);
    expect(mgr.transcriptRevision("quiet")).toBe(before);
  });
});
