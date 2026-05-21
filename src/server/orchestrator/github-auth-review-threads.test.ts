/**
 * Unit tests for GitHub PR review-thread GraphQL mutation helpers (docs/102).
 *
 * Mocks `globalThis.fetch` to exercise the request shape and the response
 * envelope handling without hitting GitHub. Each test asserts both the
 * GraphQL body (`query` + `variables`) and the returned `{ success, message }`
 * shape so the contract with `services/github-pr-comments.ts` is locked in.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  addReviewThreadReply,
  resolveReviewThread,
  unresolveReviewThread,
} from "./github-auth-review-threads.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

interface CapturedRequest {
  url: string;
  method: string | undefined;
  body: { query: string; variables: Record<string, unknown> } | null;
  authorization: string | null;
}

function spyFetch(responses: Response[]): () => CapturedRequest[] {
  const captured: CapturedRequest[] = [];
  let i = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const headers = new Headers(init?.headers as HeadersInit | undefined);
    let body: { query: string; variables: Record<string, unknown> } | null = null;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body) as { query: string; variables: Record<string, unknown> };
      } catch {
        body = null;
      }
    }
    captured.push({
      url,
      method: init?.method,
      body,
      authorization: headers.get("authorization"),
    });
    return responses[i++] ?? jsonResponse({ data: {} });
  });
  return () => captured;
}

describe("github-auth-review-threads", () => {
  beforeEach(() => {
    // each test installs its own fetch spy via spyFetch
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("addReviewThreadReply", () => {
    it("POSTs the addPullRequestReviewThreadReply mutation with the right variables", async () => {
      const getCaptured = spyFetch([
        jsonResponse({ data: { addPullRequestReviewThreadReply: { comment: { id: "COMMENT_1", url: "https://github.com/x/y/pull/1#r1" } } } }),
      ]);

      const result = await addReviewThreadReply("ghp_test", "PRT_kw1", "looks good");
      expect(result).toEqual({ success: true, message: "reply to review thread succeeded" });

      const calls = getCaptured();
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe("https://api.github.com/graphql");
      expect(calls[0].method).toBe("POST");
      expect(calls[0].authorization).toBe("Bearer ghp_test");
      expect(calls[0].body?.query).toContain("addPullRequestReviewThreadReply");
      expect(calls[0].body?.variables).toEqual({ threadId: "PRT_kw1", body: "looks good" });
    });

    it("returns failure when GraphQL responds with errors", async () => {
      spyFetch([
        jsonResponse({ errors: [{ message: "Thread is locked" }] }),
      ]);
      const result = await addReviewThreadReply("ghp_test", "PRT_kw1", "looks good");
      expect(result).toEqual({ success: false, message: "Thread is locked" });
    });

    it("returns failure on non-2xx", async () => {
      spyFetch([
        new Response("", { status: 502 }),
      ]);
      const result = await addReviewThreadReply("ghp_test", "PRT_kw1", "looks good");
      expect(result).toEqual({
        success: false,
        message: "Failed to reply to review thread (HTTP 502)",
      });
    });
  });

  describe("resolveReviewThread", () => {
    it("POSTs the resolveReviewThread mutation", async () => {
      const getCaptured = spyFetch([
        jsonResponse({ data: { resolveReviewThread: { thread: { id: "PRT_kw1", isResolved: true } } } }),
      ]);

      const result = await resolveReviewThread("ghp_test", "PRT_kw1");
      expect(result).toEqual({ success: true, message: "resolve review thread succeeded" });
      const calls = getCaptured();
      expect(calls[0].body?.query).toContain("resolveReviewThread");
      expect(calls[0].body?.variables).toEqual({ threadId: "PRT_kw1" });
    });

    it("returns failure on GraphQL errors", async () => {
      spyFetch([
        jsonResponse({ errors: [{ message: "not found" }] }),
      ]);
      const result = await resolveReviewThread("ghp_test", "PRT_kw1");
      expect(result).toEqual({ success: false, message: "not found" });
    });
  });

  describe("unresolveReviewThread", () => {
    it("POSTs the unresolveReviewThread mutation", async () => {
      const getCaptured = spyFetch([
        jsonResponse({ data: { unresolveReviewThread: { thread: { id: "PRT_kw1", isResolved: false } } } }),
      ]);

      const result = await unresolveReviewThread("ghp_test", "PRT_kw1");
      expect(result).toEqual({ success: true, message: "unresolve review thread succeeded" });
      const calls = getCaptured();
      expect(calls[0].body?.query).toContain("unresolveReviewThread");
      expect(calls[0].body?.variables).toEqual({ threadId: "PRT_kw1" });
    });
  });
});
