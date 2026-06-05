/**
 * Unit tests for the issue tracker service layer (docs/175).
 *
 * `getIssueForTracker` is the single-issue read that backs `shipit issue view`.
 * It dispatches to the same tracker registry that powers the Issues tab, so the
 * test stubs the GitHub REST + Linear GraphQL HTTP and asserts the
 * tracker-neutral behavior: dispatch to both trackers, the unconfigured-tracker
 * error, and the 404s (missing issue and a GitHub PR number).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CredentialStore } from "../credential-store.js";
import { getIssueForTracker, ServiceError } from "./index.js";

const TEAM = { id: "team-1", key: "SHI", name: "ShipIt" };
const GH = { token: "ghp_test", repo: { owner: "octocat", repo: "hello-world" } };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
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
    ).rejects.toBeInstanceOf(ServiceError);
    await expect(
      getIssueForTracker(credentialStore, "github", "1", fetchImpl, GH),
    ).rejects.toMatchObject({ statusCode: 502 });
  });
});
