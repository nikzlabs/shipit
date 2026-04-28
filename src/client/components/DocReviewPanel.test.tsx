import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DocReviewPanel } from "./DocReviewPanel.js";
import type { DocEntry, DocReview, ReviewComment } from "../../server/shared/types.js";

const FEATURE: DocEntry = {
  path: "docs/012-deployment/plan.md",
  status: "in-progress",
  title: "Deployment",
};

const SAMPLE_CONTENT = `## Summary\n\nIntro.\n\n## Architecture\n\nBody.\n`;

function makeDraft(overrides?: Partial<DocReview>): DocReview {
  return {
    id: "review-1",
    featureId: "012-deployment",
    planPath: "docs/012-deployment/plan.md",
    status: "draft",
    comments: [],
    docSnapshotHash: "deadbeef",
    sectionHeadings: ["## Summary", "## Architecture"],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeComment(overrides?: Partial<ReviewComment>): ReviewComment {
  return {
    id: "c1",
    sectionHeading: "## Architecture",
    sectionIndex: 1,
    text: "thoughts",
    source: "human",
    ...overrides,
  };
}

interface FetchScript {
  /** Per URL+method, an array of responses to return in order. */
  routes: Map<string, unknown[]>;
  /** Records every call made for assertions. */
  calls: { url: string; method: string; body: unknown }[];
}

function script(): FetchScript {
  return { routes: new Map(), calls: [] };
}

function key(url: string, method: string): string {
  return `${method.toUpperCase()} ${url}`;
}

function setupFetch(s: FetchScript): void {
  globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = typeof url === "string" ? url : (url instanceof URL ? url.toString() : url.url);
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    s.calls.push({ url: u, method, body });

    const k = key(u, method);
    const queue = s.routes.get(k);
    if (!queue || queue.length === 0) {
      // Default: 404 for unmatched
      return new Response(JSON.stringify({ error: "not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }
    const next = queue.shift()!;
    if (next instanceof Error) {
      return new Response(JSON.stringify({ error: next.message }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify(next), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
}

function on(s: FetchScript, method: string, url: string, ...responses: unknown[]): void {
  s.routes.set(key(url, method), responses);
}

describe("DocReviewPanel", () => {
  let s: FetchScript;

  beforeEach(() => {
    s = script();
    setupFetch(s);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  function renderPanel(props?: {
    onSendComments?: (feature: DocEntry, prompt: string) => void;
    onClose?: () => void;
  }) {
    return render(
      <DocReviewPanel
        feature={FEATURE}
        content={SAMPLE_CONTENT}
        onSendComments={props?.onSendComments ?? (() => {})}
        onClose={props?.onClose ?? (() => {})}
      />,
    );
  }

  it("shows loading state initially", () => {
    // No routes registered → 404 for draft → POST to create draft will 404 too,
    // but useEffect resolves both, then loading flips off
    on(s, "GET", "/api/features/012-deployment/reviews/draft");  // 404
    on(s, "POST", "/api/features/012-deployment/reviews", makeDraft());
    on(s, "GET", "/api/features/012-deployment/reviews", { reviews: [] });

    renderPanel();
    expect(screen.getByText("Loading review...")).toBeInTheDocument();
  });

  it("loads an existing draft when one is returned", async () => {
    const draft = makeDraft({ comments: [makeComment({ text: "existing" })] });
    on(s, "GET", "/api/features/012-deployment/reviews/draft", draft);
    on(s, "GET", "/api/features/012-deployment/reviews", { reviews: [draft] });

    renderPanel();

    expect(await screen.findByText("existing")).toBeInTheDocument();
    // Should NOT have created a new draft
    expect(s.calls.some((c) => c.method === "POST" && c.url === "/api/features/012-deployment/reviews")).toBe(false);
  });

  it("creates a new draft when none exists", async () => {
    on(s, "GET", "/api/features/012-deployment/reviews/draft");  // 404
    on(s, "POST", "/api/features/012-deployment/reviews", makeDraft());
    on(s, "GET", "/api/features/012-deployment/reviews", { reviews: [] });

    renderPanel();
    await waitFor(() => {
      expect(s.calls.some((c) => c.method === "POST" && c.url === "/api/features/012-deployment/reviews")).toBe(true);
    });
  });

  it("renders the feature title in the header", async () => {
    const draft = makeDraft();
    on(s, "GET", "/api/features/012-deployment/reviews/draft", draft);
    on(s, "GET", "/api/features/012-deployment/reviews", { reviews: [] });

    renderPanel();
    expect(await screen.findByText("Review: Deployment")).toBeInTheDocument();
  });

  it("Send Comments button is disabled with no comments and enabled with comments", async () => {
    const empty = makeDraft();
    const withComments = makeDraft({ comments: [makeComment()] });

    // Render once with empty
    on(s, "GET", "/api/features/012-deployment/reviews/draft", empty);
    on(s, "GET", "/api/features/012-deployment/reviews", { reviews: [] });
    const { unmount } = renderPanel();
    await waitFor(() => expect(screen.getByText("0 comments")).toBeInTheDocument());
    expect(screen.getByText("Send Comments").closest("button")).toBeDisabled();
    unmount();

    // Render again with comments
    s.routes.clear();
    s.calls.length = 0;
    on(s, "GET", "/api/features/012-deployment/reviews/draft", withComments);
    on(s, "GET", "/api/features/012-deployment/reviews", { reviews: [] });
    renderPanel();
    await waitFor(() => expect(screen.getByText("1 comment")).toBeInTheDocument());
    expect(screen.getByText("Send Comments").closest("button")).not.toBeDisabled();
  });

  it("pluralises the comment count correctly", async () => {
    const draft = makeDraft({
      comments: [
        makeComment({ id: "c1" }),
        makeComment({ id: "c2", text: "second" }),
      ],
    });
    on(s, "GET", "/api/features/012-deployment/reviews/draft", draft);
    on(s, "GET", "/api/features/012-deployment/reviews", { reviews: [] });
    renderPanel();
    await waitFor(() => expect(screen.getByText("2 comments")).toBeInTheDocument());
  });

  it("renders the AI Review button", async () => {
    on(s, "GET", "/api/features/012-deployment/reviews/draft", makeDraft());
    on(s, "GET", "/api/features/012-deployment/reviews", { reviews: [] });
    renderPanel();
    expect(await screen.findByText("AI Review")).toBeInTheDocument();
  });

  it("calls AI review endpoint and merges returned comments", async () => {
    const draft = makeDraft();
    on(s, "GET", "/api/features/012-deployment/reviews/draft", draft);
    on(s, "GET", "/api/features/012-deployment/reviews", { reviews: [] });
    on(s, "POST", "/api/features/012-deployment/reviews/review-1/ai-review", {
      comments: [makeComment({ id: "ai-1", text: "AI feedback", source: "ai" })],
    });

    renderPanel();
    await screen.findByText("AI Review");

    const user = userEvent.setup();
    await user.click(screen.getByText("AI Review"));

    expect(await screen.findByText("AI feedback")).toBeInTheDocument();
  });

  it("sends review and invokes onSendComments with returned prompt", async () => {
    const draft = makeDraft({ comments: [makeComment()] });
    on(s, "GET", "/api/features/012-deployment/reviews/draft", draft);
    on(s, "GET", "/api/features/012-deployment/reviews", { reviews: [] });
    on(s, "POST", "/api/features/012-deployment/reviews/review-1/send", {
      prompt: "GENERATED PROMPT",
    });

    const onSend = vi.fn();
    renderPanel({ onSendComments: onSend });
    await screen.findByText("Send Comments");

    fireEvent.click(screen.getByText("Send Comments"));

    await waitFor(() => {
      expect(onSend).toHaveBeenCalledWith(FEATURE, "GENERATED PROMPT");
    });
  });

  it("deletes empty drafts on close", async () => {
    const draft = makeDraft();
    on(s, "GET", "/api/features/012-deployment/reviews/draft", draft);
    on(s, "GET", "/api/features/012-deployment/reviews", { reviews: [] });
    on(s, "DELETE", "/api/features/012-deployment/reviews/review-1", {});

    const onClose = vi.fn();
    renderPanel({ onClose });
    await screen.findByLabelText("Close");
    fireEvent.click(screen.getByLabelText("Close"));

    await waitFor(() => {
      expect(s.calls.some((c) => c.method === "DELETE" && c.url === "/api/features/012-deployment/reviews/review-1")).toBe(true);
    });
    expect(onClose).toHaveBeenCalled();
  });

  it("does NOT delete drafts that have comments on close", async () => {
    const draft = makeDraft({ comments: [makeComment()] });
    on(s, "GET", "/api/features/012-deployment/reviews/draft", draft);
    on(s, "GET", "/api/features/012-deployment/reviews", { reviews: [] });

    const onClose = vi.fn();
    renderPanel({ onClose });
    await screen.findByLabelText("Close");
    fireEvent.click(screen.getByLabelText("Close"));

    // Wait a tick to ensure no DELETE is fired
    await new Promise((r) => setTimeout(r, 10));
    expect(s.calls.some((c) => c.method === "DELETE")).toBe(false);
    expect(onClose).toHaveBeenCalled();
  });

  it("shows past reviews in the history", async () => {
    const sentReview = makeDraft({
      id: "old-review",
      status: "sent",
      sentAt: "2026-02-15T10:00:00Z",
      comments: [makeComment({ text: "old feedback" })],
    });
    on(s, "GET", "/api/features/012-deployment/reviews/draft", makeDraft());
    on(s, "GET", "/api/features/012-deployment/reviews", { reviews: [sentReview] });

    renderPanel();
    expect(await screen.findByText(/Past reviews/)).toBeInTheDocument();
    expect(screen.getByText(/Past reviews/).textContent).toContain("1");
  });
});
