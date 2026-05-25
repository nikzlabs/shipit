import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { useFileReviewStore } from "./file-review-store.js";
import type { FileReview, ReviewComment } from "../../server/shared/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface FakeRoute {
  matches: (method: string, url: string) => boolean;
  respond: (body: unknown) => unknown;
}

class FakeFetch {
  routes: FakeRoute[] = [];
  calls: { method: string; url: string; body?: unknown }[] = [];

  on(method: string, urlOrRegex: string | RegExp, respond: (body: unknown) => unknown): this {
    this.routes.push({
      matches: (m, u) => {
        if (m !== method) return false;
        return typeof urlOrRegex === "string" ? u === urlOrRegex : urlOrRegex.test(u);
      },
      respond,
    });
    return this;
  }

  install(): void {
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : (input as URL).toString();
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(init.body as string) as unknown : undefined;
      this.calls.push({ method, url, body });
      const route = this.routes.find((r) => r.matches(method, url));
      if (!route) {
        return Promise.resolve(
          new Response(JSON.stringify({ error: "no fake route" }), { status: 404 }),
        );
      }
      const response = route.respond(body);
      return Promise.resolve(new Response(JSON.stringify(response), { status: 200 }));
    }) as typeof fetch;
  }
}

function makeDraft(overrides?: Partial<FileReview>): FileReview {
  return {
    id: overrides?.id ?? "draft-1",
    sessionId: overrides?.sessionId ?? "s1",
    filePath: overrides?.filePath ?? "plan.md",
    fileType: overrides?.fileType ?? "markdown",
    status: overrides?.status ?? "draft",
    comments: overrides?.comments ?? [],
    docSnapshotHash: overrides?.docSnapshotHash ?? "h",
    createdAt: overrides?.createdAt ?? "2025-01-01T00:00:00Z",
    updatedAt: overrides?.updatedAt ?? "2025-01-01T00:00:00Z",
    sentAt: overrides?.sentAt,
  };
}

function selectionComment(id: string, text = "x"): ReviewComment {
  return {
    id,
    kind: "selection",
    quotedText: "anchored text",
    contextBefore: "",
    contextAfter: "",
    text,
    source: "human",
  };
}

function lineComment(id: string, line = 1, text = "x"): ReviewComment {
  return { id, kind: "line", line, text, source: "human" };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const originalFetch = globalThis.fetch;

describe("file-review-store", () => {
  beforeEach(() => {
    // Reset zustand state between tests
    useFileReviewStore.setState({
      draftByKey: {},
      historyByKey: {},
      loadingByKey: {},
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("load() ensures a draft via POST and populates history", async () => {
    const draft = makeDraft({ id: "d1" });
    const sent = makeDraft({ id: "s0", status: "sent", sentAt: "2025-01-02T00:00:00Z" });

    const fake = new FakeFetch();
    fake.on("POST", "/api/sessions/s1/file-reviews/draft", () => draft);
    fake.on("GET", /\/api\/sessions\/s1\/file-reviews\?filePath=/, () => ({ reviews: [draft, sent] }));
    fake.install();

    const result = await useFileReviewStore.getState().load("s1", "plan.md");
    expect(result?.id).toBe("d1");
    expect(useFileReviewStore.getState().getDraft("s1", "plan.md")?.id).toBe("d1");
    expect(useFileReviewStore.getState().getHistory("s1", "plan.md").map((r) => r.id)).toEqual(["s0"]);
  });

  it("addSelectionComment() appends to draft locally after successful POST", async () => {
    const draft = makeDraft({ id: "d2" });
    const fake = new FakeFetch();
    fake.on("POST", "/api/sessions/s1/file-reviews/draft", () => draft);
    fake.on("GET", /file-reviews\?filePath/, () => ({ reviews: [] }));
    fake.on("POST", "/api/sessions/s1/file-reviews/d2/comments", () => selectionComment("c1", "hello"));
    fake.install();

    await useFileReviewStore.getState().load("s1", "plan.md");
    const comment = await useFileReviewStore.getState().addSelectionComment(
      "s1",
      "plan.md",
      "anchored text",
      "",
      "",
      "hello",
    );
    expect(comment?.id).toBe("c1");
    expect(useFileReviewStore.getState().getDraft("s1", "plan.md")?.comments).toHaveLength(1);
  });

  it("addLineComment() appends to a code draft", async () => {
    const draft = makeDraft({ id: "d3", fileType: "code" });
    const fake = new FakeFetch();
    fake.on("POST", "/api/sessions/s1/file-reviews/draft", () => draft);
    fake.on("GET", /file-reviews\?filePath/, () => ({ reviews: [] }));
    fake.on("POST", "/api/sessions/s1/file-reviews/d3/comments", () => lineComment("c1", 5, "fix"));
    fake.install();

    await useFileReviewStore.getState().load("s1", "src/foo.ts");
    const c = await useFileReviewStore.getState().addLineComment("s1", "src/foo.ts", 5, "fix");
    expect(c?.id).toBe("c1");
    expect(useFileReviewStore.getState().getDraft("s1", "src/foo.ts")?.comments).toHaveLength(1);
  });

  it("editComment() updates the local comment text", async () => {
    const draft = makeDraft({ id: "d4", comments: [selectionComment("c1", "old")] });
    const fake = new FakeFetch();
    fake.on("POST", "/api/sessions/s1/file-reviews/draft", () => draft);
    fake.on("GET", /file-reviews\?filePath/, () => ({ reviews: [] }));
    fake.on("PATCH", "/api/sessions/s1/file-reviews/d4/comments/c1", () => ({ ok: true }));
    fake.install();

    await useFileReviewStore.getState().load("s1", "plan.md");
    await useFileReviewStore.getState().editComment("s1", "plan.md", "c1", "new");
    expect(useFileReviewStore.getState().getDraft("s1", "plan.md")?.comments[0].text).toBe("new");
  });

  it("deleteComment() removes the local comment", async () => {
    const draft = makeDraft({ id: "d5", comments: [selectionComment("c1"), selectionComment("c2")] });
    const fake = new FakeFetch();
    fake.on("POST", "/api/sessions/s1/file-reviews/draft", () => draft);
    fake.on("GET", /file-reviews\?filePath/, () => ({ reviews: [] }));
    fake.on("DELETE", "/api/sessions/s1/file-reviews/d5/comments/c1", () => ({ ok: true }));
    fake.install();

    await useFileReviewStore.getState().load("s1", "plan.md");
    await useFileReviewStore.getState().deleteComment("s1", "plan.md", "c1");
    const comments = useFileReviewStore.getState().getDraft("s1", "plan.md")?.comments ?? [];
    expect(comments.map((c) => c.id)).toEqual(["c2"]);
  });

  it("sendDraft() returns the structured payload, clears the draft, and prepends to history", async () => {
    const draft = makeDraft({ id: "d6", comments: [selectionComment("c1")] });
    const sentReview: FileReview = { ...draft, status: "sent", sentAt: "2025-01-03T00:00:00Z" };
    const fake = new FakeFetch();
    fake.on("POST", "/api/sessions/s1/file-reviews/draft", () => draft);
    fake.on("GET", /file-reviews\?filePath/, () => ({ reviews: [] }));
    fake.on("POST", "/api/sessions/s1/file-reviews/d6/send", () => ({
      prompt: "I've reviewed plan.md and have the following feedback:",
      review: sentReview,
    }));
    fake.install();

    await useFileReviewStore.getState().load("s1", "plan.md");
    const result = await useFileReviewStore.getState().sendDraft("s1", "plan.md");
    expect(result?.prompt).toContain("I've reviewed plan.md");
    expect(result?.filePath).toBe("plan.md");
    expect(result?.commentCount).toBe(1);
    expect(useFileReviewStore.getState().getDraft("s1", "plan.md")).toBeNull();
    expect(useFileReviewStore.getState().getHistory("s1", "plan.md")[0]?.id).toBe("d6");
  });

  it("sendDraft() refuses to send when there are no comments", async () => {
    const draft = makeDraft({ id: "d7", comments: [] });
    const fake = new FakeFetch();
    fake.on("POST", "/api/sessions/s1/file-reviews/draft", () => draft);
    fake.on("GET", /file-reviews\?filePath/, () => ({ reviews: [] }));
    fake.install();

    await useFileReviewStore.getState().load("s1", "plan.md");
    const result = await useFileReviewStore.getState().sendDraft("s1", "plan.md");
    expect(result).toBeNull();
    expect(fake.calls.find((c) => c.url.endsWith("/send"))).toBeUndefined();
  });

  it("applyReviewUpdate() replaces the local draft with the broadcast review (docs/125)", () => {
    // Seed an existing draft so we can prove the WS update overwrites it.
    useFileReviewStore.setState({
      draftByKey: { "s1::plan.md": makeDraft({ id: "d8", comments: [] }) },
    });

    const updated = makeDraft({
      id: "d8",
      comments: [
        {
          id: "ai1",
          kind: "selection",
          quotedText: "anchored text",
          contextBefore: "",
          contextAfter: "",
          text: "robot says",
          source: "ai",
        },
      ],
    });
    useFileReviewStore.getState().applyReviewUpdate(updated);

    const draftNow = useFileReviewStore.getState().getDraft("s1", "plan.md");
    expect(draftNow?.comments).toHaveLength(1);
    expect(draftNow?.comments[0].source).toBe("ai");
  });

  it("discardEmptyDraft() deletes empty drafts on the server", async () => {
    const draft = makeDraft({ id: "d9" });
    const fake = new FakeFetch();
    fake.on("POST", "/api/sessions/s1/file-reviews/draft", () => draft);
    fake.on("GET", /file-reviews\?filePath/, () => ({ reviews: [] }));
    fake.on("DELETE", "/api/sessions/s1/file-reviews/d9", () => ({ ok: true }));
    fake.install();

    await useFileReviewStore.getState().load("s1", "plan.md");
    await useFileReviewStore.getState().discardEmptyDraft("s1", "plan.md");
    expect(fake.calls.find((c) => c.method === "DELETE" && c.url.endsWith("/d9"))).toBeDefined();
    expect(useFileReviewStore.getState().getDraft("s1", "plan.md")).toBeNull();
  });

  it("discardEmptyDraft() leaves drafts with comments alone", async () => {
    const draft = makeDraft({ id: "d10", comments: [selectionComment("c1")] });
    const fake = new FakeFetch();
    fake.on("POST", "/api/sessions/s1/file-reviews/draft", () => draft);
    fake.on("GET", /file-reviews\?filePath/, () => ({ reviews: [] }));
    fake.install();

    await useFileReviewStore.getState().load("s1", "plan.md");
    await useFileReviewStore.getState().discardEmptyDraft("s1", "plan.md");
    expect(fake.calls.find((c) => c.method === "DELETE")).toBeUndefined();
    expect(useFileReviewStore.getState().getDraft("s1", "plan.md")?.id).toBe("d10");
  });

  it("isolates state between (session, file) pairs", async () => {
    const a = makeDraft({ id: "da", filePath: "a.md" });
    const b = makeDraft({ id: "db", filePath: "b.md" });
    const fake = new FakeFetch();
    fake.on("POST", "/api/sessions/s1/file-reviews/draft", (body) => {
      const filePath = (body as { filePath: string }).filePath;
      return filePath === "a.md" ? a : b;
    });
    fake.on("GET", /file-reviews\?filePath/, () => ({ reviews: [] }));
    fake.install();

    await useFileReviewStore.getState().load("s1", "a.md");
    await useFileReviewStore.getState().load("s1", "b.md");
    expect(useFileReviewStore.getState().getDraft("s1", "a.md")?.id).toBe("da");
    expect(useFileReviewStore.getState().getDraft("s1", "b.md")?.id).toBe("db");
  });
});
