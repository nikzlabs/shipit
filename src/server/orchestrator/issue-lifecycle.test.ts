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
function makeHarness(initialState: "open" | "closed" = "open", archived = false, declarations?: string) {
  // docs/248 — declarations come from the session workspace's shipit.yaml, so a
  // test that needs more than the session's own repository writes one.
  const workspaceDir = declarations ? fs.mkdtempSync(path.join(os.tmpdir(), "lc-ws-")) : undefined;
  if (workspaceDir && declarations) {
    fs.writeFileSync(path.join(workspaceDir, "shipit.yaml"), declarations);
  }
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
  // In-memory stand-in for the persisted docs/194 fire-once guard set.
  const appliedEffects = new Map<string, Set<string>>();
  const deps: IssueLifecycleDeps = {
    credentialStore: new CredentialStore(fs.mkdtempSync(path.join(os.tmpdir(), "lc-"))),
    trackerFetchImpl: fetchImpl,
    githubAuthManager: { getToken: () => "ghp_test" } as unknown as GitHubAuthManager,
    sessionManager: {
      get: () => ({ remoteUrl: REMOTE, archived, userArchived: archived, workspaceDir }),
      hasAppliedMergeIssueEffect: (id: string, key: string) => appliedEffects.get(id)?.has(key) ?? false,
      markAppliedMergeIssueEffect: (id: string, key: string) => {
        const set = appliedEffects.get(id) ?? new Set<string>();
        set.add(key);
        appliedEffects.set(id, set);
      },
    } as unknown as SessionManager,
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

  // docs/248 — the fire-once key and the deterministic card id both carry the
  // DESTINATION. Keyed on the issue number alone, `Closes beta#42` looks like an
  // already-applied `Closes alpha#42` and is skipped, so one of the two issues
  // silently never closes.
  it("completes both destinations when two declared trackers share an issue number", async () => {
    const { deps, calls, appended } = makeHarness(
      "open",
      false,
      `version: 1
issues:
  trackers:
    - kind: github
      repo: octocat/alpha
      name: alpha
    - kind: github
      repo: octocat/beta
      name: beta
`,
    );
    await applyMergedPrIssueRefs(deps, mergedPr("Closes alpha#42\nCloses beta#42"));

    const patched = calls.filter((c) => c.method === "PATCH").map((c) => c.url);
    expect(patched.some((u) => u.includes("octocat/alpha/issues/42"))).toBe(true);
    expect(patched.some((u) => u.includes("octocat/beta/issues/42"))).toBe(true);

    const cards = appended.filter((m) => m.issueWrite).map((m) => m.issueWrite!);
    expect(cards).toHaveLength(2);
    expect(new Set(cards.map((c) => c.cardId)).size).toBe(2);
    expect(new Set(cards.map((c) => c.trackerName))).toEqual(new Set(["alpha", "beta"]));
  });

  // req 19 — a reference that resolves to nothing is dropped permanently, so a
  // server log alone would mean the PR merges, the issue stays open, and nothing
  // the user can see says why.
  it("records an unresolvable reference in the transcript instead of dropping it silently", async () => {
    const { deps, calls, appended } = makeHarness("open");
    await applyMergedPrIssueRefs(deps, mergedPr("Closes planning#42"));

    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
    const note = appended.find((m) => !m.issueWrite && m.text.includes("planning#42"));
    expect(note?.text).toContain("could not act on it");
  });

  // Same failure re-derives from the same PR body on every reconnect re-fire, so
  // the note is fire-once rather than one copy per reopen.
  it("records an unresolvable reference only once across re-fires", async () => {
    const { deps, appended } = makeHarness("open");
    await applyMergedPrIssueRefs(deps, mergedPr("Closes planning#42"));
    await applyMergedPrIssueRefs(deps, mergedPr("Closes planning#42"));
    expect(appended.filter((m) => m.text.includes("planning#42"))).toHaveLength(1);
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

  // docs/194 Layer 1 — the merge effect re-fires whenever the poller's in-memory
  // mergedSessions guard is wiped (every viewer reconnect). The persisted guard
  // must make a second call a complete no-op: no tracker write, no extra card.
  it("does NOT re-fire the status flip or resolved-by comment on a second call", async () => {
    const { deps, calls, appended } = makeHarness("open");
    const pr = mergedPr("Closes octocat/hello-world#42");

    await applyMergedPrIssueRefs(deps, pr);
    const callsAfterFirst = calls.length;
    const cardsAfterFirst = appended.filter((m) => m.issueWrite).length;
    expect(cardsAfterFirst).toBe(1);

    // Simulate the reconnect-driven re-fire.
    await applyMergedPrIssueRefs(deps, pr);
    expect(calls.length).toBe(callsAfterFirst); // no new PATCH / POST
    expect(appended.filter((m) => m.issueWrite)).toHaveLength(1); // no duplicate card
  });

  it("does NOT re-fire the progress comment for a Refs pointer on a second call", async () => {
    const { deps, calls, appended } = makeHarness("open");
    const pr = mergedPr("Refs octocat/hello-world#42");

    await applyMergedPrIssueRefs(deps, pr);
    const callsAfterFirst = calls.length;

    await applyMergedPrIssueRefs(deps, pr);
    expect(calls.length).toBe(callsAfterFirst);
    expect(appended.filter((m) => m.issueWrite)).toHaveLength(1);
  });

  // The production scenario, at the scale it actually happened. Before the
  // docs/194 Layer 1 guard (4ee77aa5, 2026-06-13) each viewer reconnect wiped the
  // poller's in-memory `mergedSessions` edge, re-promoted the already-merged PR
  // and re-ran these writes — SHI-126 and SHI-128 each ended up carrying **89
  // byte-identical** "Resolved by ShipIt on merge of PR #1294" / "Referenced by
  // merged PR #1294" comments, posted within a ~3-hour window on 2026-06-12, and
  // 17 issues were affected in total. It went unnoticed for two months because
  // nobody scrolls to the bottom of a closed issue; it surfaced only when the
  // docs/247 Linear migration's write-dedup window collapsed the copies.
  //
  // The two tests above lock the guard at N=2. This one asserts the property the
  // duplicates violated, on the COMMENT bodies specifically rather than on an
  // aggregate call count: however many times the merge handler re-fires for one
  // PR, each provenance comment is posted exactly once.
  it("posts each provenance comment exactly once across many re-fires of one PR", async () => {
    const { deps, calls, appended } = makeHarness("open");
    const pr = mergedPr("## Summary\nDone.\n\nCloses octocat/hello-world#42\nRefs octocat/hello-world#43");

    for (let i = 0; i < 89; i++) await applyMergedPrIssueRefs(deps, pr);

    const commentBodies = calls
      .filter((c) => c.method === "POST" && c.url.includes("/comments"))
      .map((c) => (c.body as { body: string }).body);
    expect(commentBodies.filter((b) => b.startsWith("Resolved by ShipIt on merge of PR #7"))).toHaveLength(1);
    expect(commentBodies.filter((b) => b.startsWith("Referenced by merged PR #7"))).toHaveLength(1);
    expect(commentBodies).toHaveLength(2);

    // …and the rest of the effects stay single too: one status flip, and one card
    // each for the close and the progress comment.
    expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(1);
    expect(appended.filter((m) => m.issueWrite)).toHaveLength(2);
  });

  // docs/194 Layer 2 — even if the guard regressed, the card id is deterministic
  // (keyed by session + PR + tracker + issue + verb) so the client's
  // idempotent-by-cardId store collapses a re-fire instead of rendering a
  // duplicate. The TRACKER is in the key (docs/248) so two destinations' `#42`
  // don't collapse into one card.
  it("mints a deterministic card id for the merge-completed card", async () => {
    const { deps, appended } = makeHarness("open");
    await applyMergedPrIssueRefs(deps, mergedPr("Closes octocat/hello-world#42"));
    const card = appended.find((m) => m.issueWrite)?.issueWrite;
    expect(card?.cardId).toBe("issue-write-s1-7-github-42-completed");
  });

  // Archived-receives-nothing invariant: the outward tracker write (closing the
  // linked issue on merge) is correct regardless of local session lifecycle, but
  // the in-session provenance card must NOT be pushed into an archived session's
  // transcript or broadcast to it.
  it("performs the tracker write but pushes NO card into an archived session", async () => {
    const { deps, calls, appended, emitted } = makeHarness("open", true);
    await applyMergedPrIssueRefs(deps, mergedPr("Closes octocat/hello-world#42"));

    // The issue still closes — lifecycle is independent of archival.
    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch?.url).toContain("/issues/42");
    expect(patch?.body).toMatchObject({ state: "closed" });

    // …but nothing lands in the archived session's transcript or on its socket.
    expect(appended.filter((m) => m.issueWrite)).toHaveLength(0);
    expect(emitted).toHaveLength(0);
  });

  // A transient tracker failure must NOT mark the effect applied — a later
  // re-fire retries it (best-effort), and the poller never sees the throw.
  it("retries the status flip after a transient tracker failure", async () => {
    const { deps, calls, appended } = makeHarness("open");
    const pr = mergedPr("Closes octocat/hello-world#42");

    // First attempt: force the PATCH to fail.
    let failPatch = true;
    const original = deps.trackerFetchImpl!;
    deps.trackerFetchImpl = (async (url: string, init?: { method?: string; body?: string }) => {
      if (failPatch && (init?.method ?? "GET") === "PATCH") throw new Error("tracker down");
      return original(url, init as RequestInit);
    }) as unknown as typeof fetch;

    await expect(applyMergedPrIssueRefs(deps, pr)).resolves.toBeUndefined();
    expect(appended.filter((m) => m.issueWrite)).toHaveLength(0); // no card on failure
    const patchesAfterFail = calls.filter((c) => c.method === "PATCH").length;

    // Second attempt succeeds — the unset guard lets it retry.
    failPatch = false;
    await applyMergedPrIssueRefs(deps, pr);
    expect(calls.filter((c) => c.method === "PATCH").length).toBeGreaterThan(patchesAfterFail);
    expect(appended.filter((m) => m.issueWrite)).toHaveLength(1);
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

/**
 * docs/262 req 25 — a declared plugin repository is a feedback destination, so a
 * project PR's `Closes` must not complete an issue on it: req 7 keeps the plugin
 * read-only, so whatever that merge contained, it was not the fix.
 */
describe("applyMergedPrIssueRefs — a plugin repository is not closable (docs/262 req 25)", () => {
  const DECLARES_PLUGIN =
    "plugins:\n  repos:\n    - repo: acme/dev-tools\n      name: tools\n      branch: main\n";

  it("refuses `Closes tools#12`, leaves the issue open, and says why", async () => {
    const { deps, calls, appended } = makeHarness("open", false, DECLARES_PLUGIN);
    await applyMergedPrIssueRefs(deps, mergedPr("Closes tools#12"));

    // Nothing was written to the plugin repository at all.
    expect(calls.filter((c) => c.method !== "GET")).toHaveLength(0);
    expect(appended.filter((m) => m.issueWrite)).toHaveLength(0);
    // …and the refusal is visible, not a log line (req 19's accountability rule).
    const note = appended.find((m) => m.text.includes("tools#12"));
    expect(note?.text).toContain("plugin repository");
    expect(note?.text).toContain("Refs");
  });

  // `Refs` is what the author meant, and it still works: the plugin maintainer
  // gets the consumer's merged PR on the report.
  it("still posts a Refs progress comment on a plugin repository", async () => {
    const { deps, calls, appended } = makeHarness("open", false, DECLARES_PLUGIN);
    await applyMergedPrIssueRefs(deps, mergedPr("Refs tools#12"));

    const comment = calls.find((c) => c.method === "POST" && c.url.includes("/comments"));
    expect(comment?.url).toContain("/repos/acme/dev-tools/issues/12/comments");
    expect(appended.filter((m) => m.issueWrite)).toHaveLength(1);
  });

  // The guard keys off the NAME the pointer used, so a repository declared both
  // ways behaves as the pointer asked — both directions.
  it("refuses the plugin name on a repository declared both ways", async () => {
    const { deps, calls, appended } = makeHarness(
      "open",
      false,
      `issues:\n  trackers:\n    - kind: github\n      repo: acme/dev-tools\n      name: planning\n${DECLARES_PLUGIN}`,
    );
    await applyMergedPrIssueRefs(deps, mergedPr("Closes tools#12"));
    expect(calls.filter((c) => c.method !== "GET")).toHaveLength(0);
    expect(appended.find((m) => m.text.includes("tools#12"))?.text).toContain("plugin repository");
  });

  it("still closes a repository the project also declares as a tracker", async () => {
    const { deps, calls } = makeHarness(
      "open",
      false,
      `issues:\n  trackers:\n    - kind: github\n      repo: acme/dev-tools\n      name: planning\n${DECLARES_PLUGIN}`,
    );
    await applyMergedPrIssueRefs(deps, mergedPr("Closes planning#12"));
    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch?.url).toContain("/repos/acme/dev-tools/issues/12");
    expect(patch?.body).toMatchObject({ state: "closed" });
  });
});
