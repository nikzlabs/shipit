/**
 * Unit tests for the issue tracker service layer (docs/175 read + docs/177 write).
 *
 * `getIssueForTracker` is the single-issue read that backs `shipit issue view`;
 * `commentOnIssueForTracker` / `updateIssueForTracker` / `setIssueStatusForTracker`
 * / `setIssueAssigneeForTracker` are the do-then-surface writes, each snapshotting
 * prior state for undo, and `undoIssueWrite` replays that snapshot. The tests stub
 * the GitHub REST + Linear GraphQL HTTP and assert tracker-neutral behavior.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CredentialStore } from "../credential-store.js";
import {
  getIssueForTracker,
  commentOnIssueForTracker,
  updateIssueForTracker,
  setIssueStatusForTracker,
  setIssueAssigneeForTracker,
  undoIssueWrite,
} from "./issues.js";
import { ServiceError } from "./types.js";
import type { GitHubTrackerContext } from "../trackers/index.js";

const TEAM = { id: "team-1", key: "SHI", name: "ShipIt" };
const GH: GitHubTrackerContext = { token: "ghp_test", repo: { owner: "octocat", repo: "hello-world" } };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function ghResponse(body: unknown, status = 200): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function tmpStore(): CredentialStore {
  return new CredentialStore(fs.mkdtempSync(path.join(os.tmpdir(), "iss-")));
}

describe("getIssueForTracker (docs/175)", () => {
  let tmpDir: string;
  let credentialStore: CredentialStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "issues-service-"));
    credentialStore = new CredentialStore(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("dispatches to the GitHub tracker by bare number", async () => {
    const fetchImpl = (async (url: string) => {
      expect(url).toContain("/repos/octocat/hello-world/issues/42");
      return jsonResponse({
        id: 1,
        number: 42,
        title: "An open issue",
        html_url: "https://github.com/octocat/hello-world/issues/42",
        state: "open",
        labels: ["P1"],
        body: "Body text",
        assignee: { login: "octocat" },
      });
    }) as unknown as typeof fetch;

    const { tracker, issue } = await getIssueForTracker(
      credentialStore,
      "github",
      "42",
      fetchImpl,
      GH,
    );
    expect(tracker.id).toBe("github");
    expect(issue.identifier).toBe("octocat/hello-world#42");
    expect(issue.priority.level).toBe("high");
    expect(issue.description).toBe("Body text");
  });

  it("dispatches to the Linear tracker by key", async () => {
    credentialStore.setLinearToken("lin_api_x");
    credentialStore.setLinearTeam(TEAM);

    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? "{}") as {
        query?: string;
        variables?: { id?: string };
      };
      expect(body.query).toContain("Issue");
      expect(body.variables?.id).toBe("SHI-28");
      return jsonResponse({
        data: {
          issue: {
            id: "abc",
            identifier: "SHI-28",
            title: "Decouple priorities",
            url: "https://linear.app/shipit-ai/issue/SHI-28",
            description: "Body",
            priority: 1,
            priorityLabel: "Urgent",
            state: { name: "In Progress" },
            assignee: { displayName: "Nik" },
          },
        },
      });
    }) as unknown as typeof fetch;

    const { tracker, issue } = await getIssueForTracker(
      credentialStore,
      "linear",
      "SHI-28",
      fetchImpl,
    );
    expect(tracker.id).toBe("linear");
    expect(issue.identifier).toBe("SHI-28");
    expect(issue.priority.level).toBe("urgent");
    expect(issue.assignee?.name).toBe("Nik");
  });

  it("errors when the tracker is unconfigured (Linear, no token)", async () => {
    await expect(
      getIssueForTracker(credentialStore, "linear", "SHI-1"),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("errors when the GitHub tracker has no repo binding", async () => {
    await expect(
      getIssueForTracker(credentialStore, "github", "1", undefined, {
        token: "ghp_test",
        repo: null,
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("rejects an unknown tracker with 404", async () => {
    await expect(
      getIssueForTracker(credentialStore, "jira", "1", undefined, GH),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("404s when the GitHub issue does not exist", async () => {
    const fetchImpl = (async () => jsonResponse({ message: "Not Found" }, 404)) as unknown as typeof fetch;
    await expect(
      getIssueForTracker(credentialStore, "github", "999", fetchImpl, GH),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("404s when the number is a pull request, not an issue", async () => {
    const fetchImpl = (async () =>
      jsonResponse({
        id: 5,
        number: 7,
        title: "A pull request",
        html_url: "https://github.com/octocat/hello-world/pull/7",
        state: "open",
        pull_request: { url: "…" },
      })) as unknown as typeof fetch;
    await expect(
      getIssueForTracker(credentialStore, "github", "7", fetchImpl, GH),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("surfaces tracker HTTP failures as a 502", async () => {
    const fetchImpl = (async () => jsonResponse({ message: "boom" }, 500)) as unknown as typeof fetch;
    await expect(
      getIssueForTracker(credentialStore, "github", "1", fetchImpl, GH),
    ).rejects.toMatchObject({ statusCode: 502 });
  });
});

/** A GitHub REST stub routing on method + path tail. */
function ghFetch(over: Partial<{ issue: Record<string, unknown> }> = {}) {
  const issue = {
    id: 1,
    number: 42,
    title: "Original title",
    html_url: "https://github.com/octocat/hello-world/issues/42",
    body: "original body",
    state: "open",
    assignee: { login: "alice" },
    ...over.issue,
  };
  return vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = url as string;
    const method = init?.method ?? "GET";
    if (method === "GET" && u.endsWith("/issues/42")) return ghResponse(issue);
    if (method === "POST" && u.endsWith("/issues/42/comments")) {
      return ghResponse({ id: 9001, html_url: `${issue.html_url}#c`, body: "noted" });
    }
    if (method === "DELETE" && u.endsWith("/issues/comments/9001")) return ghResponse(null, 204);
    if (method === "PATCH" && u.endsWith("/issues/42")) {
      return ghResponse({ ...issue, ...JSON.parse(init?.body as string) });
    }
    throw new Error(`unexpected ${method} ${u}`);
  });
}

describe("issue write services (docs/177)", () => {
  let store: CredentialStore;
  beforeEach(() => {
    store = tmpStore();
  });

  it("comment: writes and returns a delete-comment undo snapshot", async () => {
    const fetchImpl = ghFetch();
    const out = await commentOnIssueForTracker(store, "github", "42", "noted", fetchImpl, GH);
    expect(out.verb).toBe("comment");
    expect(out.summary).toContain("octocat/hello-world#42");
    expect(out.undo).toEqual({ kind: "comment", commentId: "9001" });
  });

  it("edit: snapshots the prior title for undo", async () => {
    const out = await updateIssueForTracker(store, "github", "42", { title: "New title" }, ghFetch(), GH);
    expect(out.verb).toBe("edit");
    expect(out.undo).toEqual({ kind: "edit", previousTitle: "Original title" });
  });

  it("status: snapshots the prior native status name for undo", async () => {
    // Prior state is open → native name "Open".
    const out = await setIssueStatusForTracker(store, "github", "42", "completed", ghFetch(), GH);
    expect(out.undo).toEqual({ kind: "status", previousStatus: "Open" });
  });

  it("assignee: snapshots the prior internal id (login), not the display name", async () => {
    const out = await setIssueAssigneeForTracker(store, "github", "42", "bob", ghFetch(), GH);
    expect(out.undo).toEqual({ kind: "assignee", previousAssigneeId: "alice" });
  });

  it("assignee: prior id is null when the issue was unassigned", async () => {
    const fetchImpl = ghFetch({ issue: { assignee: null } });
    const out = await setIssueAssigneeForTracker(store, "github", "42", "bob", fetchImpl, GH);
    expect(out.undo).toEqual({ kind: "assignee", previousAssigneeId: null });
  });

  it("maps an ambiguous status to a 422 ServiceError listing options", async () => {
    await expect(
      setIssueStatusForTracker(store, "github", "42", "in review", ghFetch(), GH),
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  it("rejects an unconfigured tracker with a ServiceError", async () => {
    await expect(
      getIssueForTracker(store, "linear", "SHI-1"),
    ).rejects.toBeInstanceOf(ServiceError);
  });

  it("undo: comment → deletes the comment by id", async () => {
    const fetchImpl = ghFetch();
    await undoIssueWrite(
      store,
      { tracker: "github", issueId: "42", undo: { kind: "comment", commentId: "9001" } },
      fetchImpl,
      GH,
    );
    expect(fetchImpl.mock.calls.some(([u, i]) => i?.method === "DELETE" && (u as string).includes("/issues/comments/9001"))).toBe(true);
  });

  it("undo: assignee → replays the prior internal id verbatim (raw)", async () => {
    const fetchImpl = ghFetch();
    await undoIssueWrite(
      store,
      { tracker: "github", issueId: "42", undo: { kind: "assignee", previousAssigneeId: "alice" } },
      fetchImpl,
      GH,
    );
    const patch = fetchImpl.mock.calls.find(([, i]) => i?.method === "PATCH")!;
    expect(JSON.parse(patch[1]?.body as string)).toEqual({ assignees: ["alice"] });
  });
});
