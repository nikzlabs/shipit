import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { DatabaseManager } from "../shared/database.js";
import { ChatHistoryManager, type PersistedMessage } from "./chat-history.js";
import { CARD_MESSAGE_FIELDS } from "../../client/components/visual-elements.js";

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
  voiceNote: { id: "v1", headline: "h", needsAttention: true, kind: "authored", createdAt: "t" },
  bugReport: { cardId: "b1", phase: "filed", title: "T", body: "B", stage2Ran: true, producer: "ops", issueNumber: 5, issueUrl: "u" },
  permissionPrompt: { requestId: "p1", phase: "approved", toolName: "Write", path: ".npmrc", summary: "Write .npmrc", agentId: "claude", createdAt: "2026-06-05T00:00:00.000Z", remembered: true },
  egressPrompt: { cardId: "eg1", host: "evil.example.com", phase: "denied", createdAt: "2026-06-05T00:00:00.000Z" },
  compaction: { id: "c1", trigger: "manual", preTokens: 100, postTokens: 20, durationMs: 9, createdAt: "t" },
  subAgentConsult: { cardId: "sac1", spawnId: "spawn-1", subAgentId: "codex", status: "success", durationMs: 47000, costUsd: 0.03, truncated: false, outputMarkdown: "## Findings\n\n- `foo.ts:42` — bug\n", createdAt: "2026-06-05T00:00:00.000Z" },
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
        needsAttention: true,
        kind: "authored",
        createdAt: "2026-06-02T00:00:00.000Z",
      },
    };

    mgr.append("sess-1", msg);
    const loaded = mgr.load("sess-1");
    expect(loaded[0].voiceNote).toEqual(msg.voiceNote);
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

  describe("egress allow-once card lifecycle (docs/172, SHI-90)", () => {
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
        tracker: "github",
        issueId: "42",
        identifier: "octocat/hello#42",
        title: "Bug",
        url: "https://github.com/octocat/hello/issues/42",
        verb: "comment",
        summary: "commented on octocat/hello#42",
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

    it("round-trips an edit card's label/priority undo snapshot (SHI-92)", () => {
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
      expect(card?.tracker).toBe("github");
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
      expect(card?.summary).toBe("commented on octocat/hello#42");
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
});
