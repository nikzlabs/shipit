/**
 * Integration test for the tracker label writes (planning#232 create, planning#88 edit).
 *
 * Drives the real orchestrator (`buildApp()`) with a live WS viewer (which puts
 * a runner in the registry) and a faked GitHub REST layer whose repo label set
 * is MUTABLE, asserting the label write paths end-to-end:
 *
 *  - `POST /issue/label/create` (the `shipit issue label create` broker target)
 *    mints the label, emits + persists one `verb: "label"` provenance card with
 *    a delete-if-unused undo snapshot, and is idempotent across a verbatim
 *    replay (same dedup contract as the other writes, planning#114);
 *  - `POST /issue/label/edit` corrects an existing label's color/casing, persists
 *    a `verb: "label-edit"` card whose undo restores the prior values, absorbs a
 *    replay, and keeps edits to DIFFERENT labels distinct (the dedup key's
 *    target slot is the label, so the second must not collapse into the first);
 *  - `POST /issue/create` with `createMissingLabels` mints unknown labels first
 *    (one extra card per minted label, before the main create card) and reports
 *    them as `createdLabels`; WITHOUT the flag an unknown label still fails,
 *    now pointing at `label create` / `--create-missing-labels`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../index.js";
import { SessionManager } from "../sessions.js";
import { AuthManager } from "../agents/claude/auth-manager.js";
import { GitManager } from "../../shared/git.js";
import type { CredentialStore } from "../credential-store.js";
import type { GitHubAuthManager } from "../github-auth.js";
import {
  TestClient,
  StubAuthManager,
  StubGitHubAuthManager,
  FakeClaudeProcess,
  createTestCredentialStore,
  createTestDatabaseManager,
  createTestSession,
} from "./test-helpers.js";
import type { DatabaseManager } from "../../shared/database.js";
import type { IssueWriteCard } from "../../shared/types.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** The declared destination these tests address (docs/248-declared-issue-trackers req 13). */
const DECLARED_TRACKER = "github:octocat/hello-world";

describe("Integration: issue label writes (planning#232 create, planning#88 edit)", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let dbManager: DatabaseManager;
  let credentialStore: CredentialStore;
  let sessionManager: SessionManager;
  let githubAuthManager: StubGitHubAuthManager;
  let sessionId: string;
  let repoLabels: { name: string; color?: string; description?: string }[];
  let labelPostCount: number;
  let labelPatchCount: number;

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "issue-label-create-"));
    sessionManager = new SessionManager(dbManager);
    credentialStore = createTestCredentialStore(tmpDir);
    githubAuthManager = new StubGitHubAuthManager();
    await githubAuthManager.setToken("ghp_test_token");
    repoLabels = [{ name: "security", color: "ededed" }];
    labelPostCount = 0;
    labelPatchCount = 0;

    const trackerFetch = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      const method = init?.method ?? "GET";
      // Mint a repo label — the mutable set means a follow-up resolve sees it.
      if (url.endsWith("/labels") && method === "POST") {
        labelPostCount += 1;
        const body = JSON.parse(init?.body ?? "{}") as { name: string; color?: string };
        const created = { name: body.name, color: body.color ?? "ededed" };
        repoLabels.push(created);
        return jsonResponse(created, 201);
      }
      // Rename/recolor in place, addressed by the label's CURRENT name — GitHub's
      // own contract, and why a rename doesn't re-label a single issue.
      if (url.includes("/labels/") && method === "PATCH") {
        labelPatchCount += 1;
        const name = decodeURIComponent(url.slice(url.indexOf("/labels/") + "/labels/".length));
        const target = repoLabels.find((l) => l.name === name);
        if (!target) return jsonResponse({ message: "Not Found" }, 404);
        const body = JSON.parse(init?.body ?? "{}") as { new_name?: string; color?: string; description?: string };
        if (body.new_name !== undefined) target.name = body.new_name;
        if (body.color !== undefined) target.color = body.color;
        if (body.description !== undefined) target.description = body.description;
        return jsonResponse({ ...target });
      }
      if (url.includes("/labels") && method === "GET") {
        return jsonResponse(repoLabels.map((l) => ({ ...l })));
      }
      // Create an issue on the session repo.
      if (url.endsWith("/issues") && method === "POST") {
        const body = JSON.parse(init?.body ?? "{}") as { title?: string; labels?: string[] };
        return jsonResponse(
          {
            id: 9,
            number: 7,
            title: body.title ?? "",
            html_url: "https://github.com/octocat/hello-world/issues/7",
            state: "open",
            labels: (body.labels ?? []).map((name) => ({ name })),
          },
          201,
        );
      }
      if (/\/issues\/\d+/.test(url)) {
        return jsonResponse({
          id: 1,
          number: 42,
          title: "An open issue",
          html_url: "https://github.com/octocat/hello-world/issues/42",
          state: "open",
          labels: [],
          body: "The GitHub body.",
        });
      }
      return jsonResponse({ message: "Not Found" }, 404);
    });

    app = await buildApp({
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager,
      authManager: new StubAuthManager() as unknown as AuthManager,
      githubAuthManager: githubAuthManager as unknown as GitHubAuthManager,
      agentFactory: () => new FakeClaudeProcess() as unknown as never,
      credentialStore,
      databaseManager: dbManager,
      workspaceDir: tmpDir,
      serveStatic: false,
      trackerFetchImpl: trackerFetch as unknown as typeof fetch,
    });

    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    port = Number(/:(\d+)$/.exec(address)?.[1] ?? 0);

    const created = await createTestSession(sessionManager, tmpDir);
    sessionId = created.sessionId;
    sessionManager.setRemoteUrl(sessionId, "https://github.com/octocat/hello-world.git");
    // docs/248-declared-issue-trackers req 13 — a create (of an issue OR a label) always names its
    // destination, and the orchestrator refuses the unnamed `github` id as a
    // backstop against a `curl` that bypasses the shim. So these tests declare
    // the session's own repository under a name and address it by that.
    fs.writeFileSync(
      path.join(created.sessionDir, "shipit.yaml"),
      "issues:\n  trackers:\n    - kind: github\n      repo: octocat/hello-world\n      name: planning\n",
    );
  });

  afterEach(async () => {
    await app.close();
    dbManager.close();
    await new Promise((r) => setTimeout(r, 50));
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch { /* ignore */ }
  });

  async function writeCardsInHistory(): Promise<IssueWriteCard[]> {
    const history = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/history` });
    return (history.json() as { messages: { issueWrite?: IssueWriteCard }[] }).messages
      .map((m) => m.issueWrite)
      .filter((c): c is IssueWriteCard => Boolean(c));
  }

  it("label create mints the label, persists a card with delete-if-unused undo, and dedups a replay", async () => {
    const client = await TestClient.connect(port, sessionId);
    await client.receive(); // preview_status

    const post = () =>
      app.inject({
        method: "POST",
        url: `/api/sessions/${sessionId}/issue/label/create`,
        payload: { tracker: DECLARED_TRACKER, name: "t3code", color: "#0ea5e9" },
      });

    const first = await post();
    expect(first.statusCode).toBe(200);
    const body = first.json() as { ok: boolean; cardId: string; summary: string; label: { name: string } };
    expect(body.ok).toBe(true);
    expect(body.summary).toBe('created label "t3code"');
    expect(body.label.name).toBe("t3code");

    // A verbatim replay (crash/retry, planning#114 contract) neither re-creates the
    // label nor mints a second card.
    const replay = await post();
    expect(replay.statusCode).toBe(200);
    expect((replay.json() as { cardId: string }).cardId).toBe(body.cardId);
    expect(labelPostCount).toBe(1);

    const cards = await writeCardsInHistory();
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      cardId: body.cardId,
      verb: "label",
      identifier: "t3code",
      issueId: "",
      undo: { kind: "label", labelId: "t3code", labelName: "t3code" },
      undoState: "available",
    });

    client.close();
  });

  it("label create 409s on an existing name (case-insensitive) without a card", async () => {
    const client = await TestClient.connect(port, sessionId);
    await client.receive();

    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/issue/label/create`,
      payload: { tracker: DECLARED_TRACKER, name: "Security" },
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: string }).error).toContain("already exists");
    expect(labelPostCount).toBe(0);
    expect(await writeCardsInHistory()).toHaveLength(0);

    client.close();
  });

  it("label edit recolors, persists a restore-the-prior-values card, and dedups a replay", async () => {
    const client = await TestClient.connect(port, sessionId);
    await client.receive();

    const post = () =>
      app.inject({
        method: "POST",
        url: `/api/sessions/${sessionId}/issue/label/edit`,
        payload: { tracker: DECLARED_TRACKER, name: "security", color: "#8b5cf6" },
      });

    const first = await post();
    expect(first.statusCode).toBe(200);
    const body = first.json() as { ok: boolean; cardId: string; summary: string; label: { color?: string } };
    expect(body.ok).toBe(true);
    expect(body.label.color).toBe("#8b5cf6");
    expect(repoLabels[0].color).toBe("8b5cf6");

    const replay = await post();
    expect((replay.json() as { cardId: string }).cardId).toBe(body.cardId);
    expect(labelPatchCount).toBe(1);

    const cards = await writeCardsInHistory();
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      cardId: body.cardId,
      verb: "label-edit",
      identifier: "security",
      issueId: "",
      // The snapshot names only what changed, so undo can't revert a field the
      // edit never touched.
      undo: { kind: "label-edit", labelId: "security", previousColor: "#ededed" },
      undoState: "available",
      content: { attrs: "color → #8b5cf6" },
    });

    client.close();
  });

  it("label edit renames in place and undo puts the previous name back", async () => {
    const client = await TestClient.connect(port, sessionId);
    await client.receive();

    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/issue/label/edit`,
      payload: { tracker: DECLARED_TRACKER, name: "security", newName: "Security" },
    });
    expect(res.statusCode).toBe(200);
    expect(repoLabels[0].name).toBe("Security");
    const card = (await writeCardsInHistory())[0];
    expect(card).toMatchObject({
      verb: "label-edit",
      identifier: "Security",
      content: { label: { before: "security", after: "Security" } },
      // The undo address is the post-rename id — on GitHub the name IS the id.
      undo: { kind: "label-edit", labelId: "Security", previousName: "security" },
    });

    // Undo is the reverse write: rename it back, in place, again touching no
    // issue that carries it.
    client.send({ type: "undo_issue_write", cardId: card.cardId });
    let update = await client.receiveType("issue_write_update");
    while ((update as { undoState?: string }).undoState === "undoing") {
      update = await client.receiveType("issue_write_update");
    }
    expect(update).toMatchObject({ cardId: card.cardId, undoState: "undone" });
    expect(repoLabels[0].name).toBe("security");

    client.close();
  });

  it("two edits to DIFFERENT labels each get their own write and card", async () => {
    const client = await TestClient.connect(port, sessionId);
    await client.receive();
    repoLabels.push({ name: "bug", color: "d73a4a" });

    const editSecurity = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/issue/label/edit`,
      payload: { tracker: DECLARED_TRACKER, name: "security", color: "#8b5cf6" },
    });
    // Same patch content, different target label: if the dedup key ignored the
    // label, the second would silently collapse into the first and come back
    // with its card, leaving `bug` un-fixed with nothing to show for it.
    const editBug = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/issue/label/edit`,
      payload: { tracker: DECLARED_TRACKER, name: "bug", color: "#8b5cf6" },
    });
    expect(editSecurity.statusCode).toBe(200);
    expect(editBug.statusCode).toBe(200);
    expect((editBug.json() as { cardId: string }).cardId).not.toBe(
      (editSecurity.json() as { cardId: string }).cardId,
    );
    expect(labelPatchCount).toBe(2);
    expect(await writeCardsInHistory()).toHaveLength(2);

    client.close();
  });

  it("label edit 404s on an unknown label and 409s on a no-op, without a card", async () => {
    const client = await TestClient.connect(port, sessionId);
    await client.receive();

    const missing = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/issue/label/edit`,
      payload: { tracker: DECLARED_TRACKER, name: "t3code", color: "#8b5cf6" },
    });
    expect(missing.statusCode).toBe(404);
    expect((missing.json() as { error: string }).error).toContain("security"); // the valid set

    const noop = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/issue/label/edit`,
      payload: { tracker: DECLARED_TRACKER, name: "security", color: "#EDEDED" },
    });
    expect(noop.statusCode).toBe(409);

    expect(labelPatchCount).toBe(0);
    expect(await writeCardsInHistory()).toHaveLength(0);

    client.close();
  });

  it("issue create with createMissingLabels mints unknown labels first, one card each", async () => {
    const client = await TestClient.connect(port, sessionId);
    await client.receive();

    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/issue/create`,
      payload: {
        tracker: DECLARED_TRACKER,
        title: "New thing",
        body: "",
        labels: ["security", "t3code"],
        createMissingLabels: true,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; createdLabels?: string[]; labels: string[] };
    expect(body.ok).toBe(true);
    // Only the genuinely-missing label was minted; both were applied.
    expect(body.createdLabels).toEqual(["t3code"]);
    expect(body.labels).toEqual(["security", "t3code"]);
    expect(labelPostCount).toBe(1);

    // Two cards: the label creation FIRST (it happened first), then the create.
    const cards = await writeCardsInHistory();
    expect(cards).toHaveLength(2);
    expect(cards[0]).toMatchObject({ verb: "label", identifier: "t3code" });
    // req 15 — the card carries the declared name form.
    expect(cards[1]).toMatchObject({ verb: "create", identifier: "planning#7" });

    client.close();
  });

  it("issue create WITHOUT the flag still rejects unknown labels, pointing at label create", async () => {
    const client = await TestClient.connect(port, sessionId);
    await client.receive();

    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/issue/create`,
      payload: { tracker: DECLARED_TRACKER, title: "New thing", body: "", labels: ["t3code"] },
    });
    expect(res.statusCode).toBe(422);
    const error = (res.json() as { error: string }).error;
    expect(error).toContain('No label "t3code"');
    expect(error).toContain("security"); // the valid options
    expect(error).toContain("shipit issue label create");
    expect(error).toContain("--create-missing-labels");
    expect(labelPostCount).toBe(0);
    expect(await writeCardsInHistory()).toHaveLength(0);

    client.close();
  });
});
