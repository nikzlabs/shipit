/**
 * Unit tests for the issue-lifecycle orchestrator helper (docs/194).
 *
 * Covers both transitions against the GitHub tracker (token + repo context, no
 * Linear team binding needed): the merge-time close/comment driven by a PR body
 * ({@link applyMergedPrIssueRefs}) and the seed-time `started` one-shot
 * ({@link markIssueStartedFromSeed}). The tracker HTTP is stubbed; we assert the
 * brokered writes that fired and the provenance cards appended to chat history.
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CredentialStore } from "./credential-store.js";
import { applyMergedPrIssueRefs, markIssueStartedFromSeed, type IssueLifecycleDeps } from "./issue-lifecycle.js";
import type { GitHubAuthManager } from "./github-auth.js";
import type { SessionManager } from "./sessions.js";
import type { ChatHistoryManager } from "./chat-history.js";
import type { SessionRunnerRegistry } from "./session-runner.js";
import type { PersistedMessage } from "./chat-history.js";
import type { IssueRef, WsServerMessage } from "../shared/types.js";

const REMOTE = "https://github.com/octocat/hello-world";

interface Call {
  method: string;
  url: string;
  body: unknown;
}

/**
 * A GitHub REST stub. GET issues/:n returns an issue in `initialState`; PATCH
 * echoes the requested `state`; POST comments returns a comment node. Records
 * every call for assertions.
 */
function makeHarness(initialState: "open" | "closed" = "open") {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, url, body });
    const numMatch = /\/issues\/(\d+)/.exec(url);
    const n = numMatch ? Number(numMatch[1]) : 0;

    if (/\/issues\/\d+\/comments$/.test(url) && method === "POST") {
      return new Response(
        JSON.stringify({
          id: 1000 + n,
          body: body?.body ?? "",
          user: { login: "octocat" },
          created_at: "2026-06-11T00:00:00Z",
          html_url: `${REMOTE}/issues/${n}#comment`,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // GET (load) or PATCH (status change) of a single issue.
    const state = method === "PATCH" ? (body?.state ?? "open") : initialState;
    return new Response(
      JSON.stringify({
        id: n,
        number: n,
        title: `Issue ${n}`,
        html_url: `${REMOTE}/issues/${n}`,
        state,
        labels: [],
        body: "",
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as unknown as typeof fetch;

  const appended: PersistedMessage[] = [];
  const emitted: WsServerMessage[] = [];
  const deps: IssueLifecycleDeps = {
    credentialStore: new CredentialStore(fs.mkdtempSync(path.join(os.tmpdir(), "lc-"))),
    trackerFetchImpl: fetchImpl,
    githubAuthManager: { getToken: () => "ghp_test" } as unknown as GitHubAuthManager,
    sessionManager: { get: () => ({ remoteUrl: REMOTE }) } as unknown as SessionManager,
    chatHistoryManager: {
      append: (_sid: string, msg: PersistedMessage) => {
        appended.push(msg);
        return appended.length;
      },
    } as unknown as ChatHistoryManager,
    runnerRegistry: {
      get: () => ({ emitMessage: (m: WsServerMessage) => emitted.push(m) }),
    } as unknown as SessionRunnerRegistry,
  };
  return { deps, calls, appended, emitted };
}

const mergedPr = (body: string | null) => ({
  sessionId: "s1",
  prNumber: 7,
  prUrl: `${REMOTE}/pull/7`,
  prTitle: "Implement the thing",
  body,
});

describe("applyMergedPrIssueRefs — completed on merge", () => {
  it("closes the issue and posts a resolved-by comment for a Closes pointer", async () => {
    const { deps, calls, appended } = makeHarness("open");
    await applyMergedPrIssueRefs(deps, mergedPr("## Summary\nDone.\n\nCloses octocat/hello-world#42"));

    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch?.url).toContain("/issues/42");
    expect(patch?.body).toMatchObject({ state: "closed", state_reason: "completed" });

    const comment = calls.find((c) => c.method === "POST" && c.url.includes("/comments"));
    expect((comment?.body as { body: string }).body).toContain("PR #7");

    // Exactly one provenance card — the status flip (the comment is supplementary).
    const cards = appended.filter((m) => m.issueWrite);
    expect(cards).toHaveLength(1);
    expect(cards[0].issueWrite).toMatchObject({ verb: "status", undoState: "available" });
  });

  it("posts a progress comment only (no status change) for a Refs pointer", async () => {
    const { deps, calls, appended } = makeHarness("open");
    await applyMergedPrIssueRefs(deps, mergedPr("Refs octocat/hello-world#42"));

    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
    const comment = calls.find((c) => c.method === "POST" && c.url.includes("/comments"));
    expect((comment?.body as { body: string }).body).toContain("Referenced by");

    const cards = appended.filter((m) => m.issueWrite);
    expect(cards).toHaveLength(1);
    expect(cards[0].issueWrite).toMatchObject({ verb: "comment" });
  });

  it("is a no-op for a body with no pointer", async () => {
    const { deps, calls, appended } = makeHarness("open");
    await applyMergedPrIssueRefs(deps, mergedPr("## Summary\nA partial PR, more to come."));
    expect(calls).toHaveLength(0);
    expect(appended).toHaveLength(0);
  });

  it("closes every issue named by multiple Closes lines", async () => {
    const { deps, calls } = makeHarness("open");
    await applyMergedPrIssueRefs(
      deps,
      mergedPr("Closes octocat/hello-world#1\nCloses octocat/hello-world#2"),
    );
    const patched = calls.filter((c) => c.method === "PATCH").map((c) => c.url);
    expect(patched.some((u) => u.includes("/issues/1"))).toBe(true);
    expect(patched.some((u) => u.includes("/issues/2"))).toBe(true);
  });
});

describe("markIssueStartedFromSeed — started at seed time", () => {
  const ref: IssueRef = {
    tracker: "github",
    identifier: "octocat/hello-world#42",
    title: "Issue 42",
    url: `${REMOTE}/issues/42`,
  };

  it("emits a provenance card when the status actually moves (reopen)", async () => {
    // Issue starts closed → `started` reopens it → Closed→Open transition → card.
    const { deps, calls, appended } = makeHarness("closed");
    await markIssueStartedFromSeed(deps, "s1", ref);

    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch?.body).toMatchObject({ state: "open" });
    const cards = appended.filter((m) => m.issueWrite);
    expect(cards).toHaveLength(1);
    expect(cards[0].issueWrite).toMatchObject({ verb: "status" });
  });

  it("skips the card when the status didn't change (already-open GitHub issue)", async () => {
    const { deps, calls, appended } = makeHarness("open");
    await markIssueStartedFromSeed(deps, "s1", ref);
    // The write is still attempted (best-effort, tracker-neutral)…
    expect(calls.some((c) => c.method === "PATCH")).toBe(true);
    // …but a no-op Open→Open transition isn't worth a transcript card.
    expect(appended.filter((m) => m.issueWrite)).toHaveLength(0);
  });

  it("never throws on an unresolvable pointer", async () => {
    const { deps, calls } = makeHarness("open");
    await expect(
      markIssueStartedFromSeed(deps, "s1", { tracker: "github", identifier: "not a pointer", title: "x" }),
    ).resolves.toBeUndefined();
    expect(calls).toHaveLength(0);
  });
});
