import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildApp } from "../index.js";
import { GitManager } from "../../shared/git.js";
import { SessionManager } from "../sessions.js";
import { AuthManager } from "../agents/claude/auth-manager.js";

import type { FastifyInstance } from "fastify";
import {
  StubAuthManager,
  StubGitHubAuthManager,
  FakeClaudeProcess,
  createTestCredentialStore,
  createTestDatabaseManager,
  createTestSession,
} from "./test-helpers.js";
import { DatabaseManager } from "../../shared/database.js";
import { GitHubAuthManager } from "../github-auth.js";
import { CredentialStore } from "../credential-store.js";
import type { FileReview, ReviewComment } from "../../shared/types.js";

describe("Integration: File Review HTTP Endpoints", () => {
  let app: FastifyInstance;
  let tmpDir: string;
  let dbManager: DatabaseManager;
  let credentialStore: CredentialStore;
  let sessionManager: SessionManager;
  let sessionId: string;
  let sessionDir: string;
  const featureId = "012-deployment";

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-file-reviews-"));
    sessionManager = new SessionManager(dbManager);

    credentialStore = createTestCredentialStore(tmpDir);

    app = await buildApp({
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager,
      authManager: new StubAuthManager() as unknown as AuthManager,
      githubAuthManager: new StubGitHubAuthManager() as unknown as GitHubAuthManager,
      agentFactory: () => new FakeClaudeProcess() as unknown as never,
      credentialStore,
      databaseManager: dbManager,
      workspaceDir: tmpDir,
      serveStatic: false,
    });

    // Create a session, since the new API is per-session and validates session dirs.
    const created = await createTestSession(sessionManager, tmpDir);
    sessionId = created.sessionId;
    sessionDir = created.sessionDir;

    // Place a plan inside the session workspace (sessions are git-initialized).
    const docsDir = path.join(sessionDir, "docs", featureId);
    fs.mkdirSync(docsDir, { recursive: true });
    fs.writeFileSync(
      path.join(docsDir, "plan.md"),
      `---
status: in-progress
---
# 012 — Deployment

## Summary
Add deployment support.

## Architecture
Plugin-based approach.

## Testing
Unit and integration tests.
`,
    );

    // Place a code file too
    fs.mkdirSync(path.join(sessionDir, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(sessionDir, "src", "api.ts"),
      "export function hello() {\n  return 'world';\n}\n",
    );
  });

  afterEach(async () => {
    await app.close();
    dbManager.close();
    await new Promise((r) => setTimeout(r, 50));
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch { /* ignore cleanup failures */ }
  });

  const planPath = `docs/${featureId}/plan.md`;
  const codePath = "src/api.ts";

  // ----------------------------------------------------------------
  // Ensure draft
  // ----------------------------------------------------------------

  it("POST /file-reviews/draft creates a markdown draft", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/file-reviews/draft`,
      payload: { filePath: planPath },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as FileReview;
    expect(body.status).toBe("draft");
    expect(body.fileType).toBe("markdown");
    expect(body.sessionId).toBe(sessionId);
    expect(body.filePath).toBe(planPath);
    expect(body.comments).toHaveLength(0);
  });

  it("POST /file-reviews/draft creates a code draft", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/file-reviews/draft`,
      payload: { filePath: codePath },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as FileReview;
    expect(body.fileType).toBe("code");
  });

  it("POST /file-reviews/draft is idempotent — returns the same draft on repeat calls", async () => {
    const first = (await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/file-reviews/draft`,
      payload: { filePath: planPath },
    })).json() as FileReview;

    const second = (await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/file-reviews/draft`,
      payload: { filePath: planPath },
    })).json() as FileReview;

    expect(second.id).toBe(first.id);
  });

  // ----------------------------------------------------------------
  // Get / not-found
  // ----------------------------------------------------------------

  it("GET /file-reviews/draft returns existing draft", async () => {
    await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/file-reviews/draft`,
      payload: { filePath: planPath },
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/sessions/${sessionId}/file-reviews/draft?filePath=${encodeURIComponent(planPath)}`,
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as FileReview).status).toBe("draft");
  });

  it("GET /file-reviews/draft returns 404 when no draft", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/sessions/${sessionId}/file-reviews/draft?filePath=${encodeURIComponent(planPath)}`,
    });
    expect(res.statusCode).toBe(404);
  });

  // ----------------------------------------------------------------
  // Add selection comment (markdown)
  // ----------------------------------------------------------------

  it("POST /comments adds a selection comment to a markdown draft", async () => {
    const draft = (await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/file-reviews/draft`,
      payload: { filePath: planPath },
    })).json() as FileReview;

    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/file-reviews/${draft.id}/comments`,
      payload: {
        kind: "selection",
        quotedText: "Plugin-based approach",
        contextBefore: "## Architecture\n",
        contextAfter: ".",
        text: "Consider a registry pattern",
      },
    });
    expect(res.statusCode).toBe(200);
    const comment = res.json() as ReviewComment;
    expect(comment.kind).toBe("selection");
    expect(comment.text).toBe("Consider a registry pattern");
    expect(comment.source).toBe("human");
  });

  // ----------------------------------------------------------------
  // Add line comment (code)
  // ----------------------------------------------------------------

  it("POST /comments adds a line comment to a code draft", async () => {
    const draft = (await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/file-reviews/draft`,
      payload: { filePath: codePath },
    })).json() as FileReview;

    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/file-reviews/${draft.id}/comments`,
      payload: { kind: "line", line: 2, text: "Why hardcode 'world'?" },
    });
    expect(res.statusCode).toBe(200);
    const comment = res.json() as ReviewComment;
    expect(comment.kind).toBe("line");
    if (comment.kind !== "line") throw new Error("expected line");
    expect(comment.line).toBe(2);
  });

  it("POST /comments rejects line comment on a markdown review", async () => {
    const draft = (await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/file-reviews/draft`,
      payload: { filePath: planPath },
    })).json() as FileReview;

    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/file-reviews/${draft.id}/comments`,
      payload: { kind: "line", line: 1, text: "no" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("POST /comments rejects selection comment on a code review", async () => {
    const draft = (await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/file-reviews/draft`,
      payload: { filePath: codePath },
    })).json() as FileReview;

    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/file-reviews/${draft.id}/comments`,
      payload: { kind: "selection", quotedText: "anything", text: "x" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("POST /comments validates empty text", async () => {
    const draft = (await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/file-reviews/draft`,
      payload: { filePath: planPath },
    })).json() as FileReview;

    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/file-reviews/${draft.id}/comments`,
      payload: { kind: "selection", quotedText: "Plugin-based approach", text: "  " },
    });
    expect(res.statusCode).toBe(400);
  });

  it("POST /comments validates empty selection", async () => {
    const draft = (await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/file-reviews/draft`,
      payload: { filePath: planPath },
    })).json() as FileReview;

    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/file-reviews/${draft.id}/comments`,
      payload: { kind: "selection", quotedText: "", text: "needs anchor" },
    });
    expect(res.statusCode).toBe(400);
  });

  // ----------------------------------------------------------------
  // PATCH / DELETE comment
  // ----------------------------------------------------------------

  it("PATCH /comments/:id updates comment text", async () => {
    const draft = (await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/file-reviews/draft`,
      payload: { filePath: planPath },
    })).json() as FileReview;

    const comment = (await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/file-reviews/${draft.id}/comments`,
      payload: { kind: "selection", quotedText: "Add deployment support", text: "Original" },
    })).json() as ReviewComment;

    const res = await app.inject({
      method: "PATCH",
      url: `/api/sessions/${sessionId}/file-reviews/${draft.id}/comments/${comment.id}`,
      payload: { text: "Updated" },
    });
    expect(res.statusCode).toBe(200);

    const draftRes = (await app.inject({
      method: "GET",
      url: `/api/sessions/${sessionId}/file-reviews/draft?filePath=${encodeURIComponent(planPath)}`,
    })).json() as FileReview;
    expect(draftRes.comments[0].text).toBe("Updated");
  });

  it("DELETE /comments/:id removes comment", async () => {
    const draft = (await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/file-reviews/draft`,
      payload: { filePath: planPath },
    })).json() as FileReview;

    const comment = (await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/file-reviews/${draft.id}/comments`,
      payload: { kind: "selection", quotedText: "Add deployment support", text: "Delete me" },
    })).json() as ReviewComment;

    const res = await app.inject({
      method: "DELETE",
      url: `/api/sessions/${sessionId}/file-reviews/${draft.id}/comments/${comment.id}`,
    });
    expect(res.statusCode).toBe(200);

    const draftRes = (await app.inject({
      method: "GET",
      url: `/api/sessions/${sessionId}/file-reviews/draft?filePath=${encodeURIComponent(planPath)}`,
    })).json() as FileReview;
    expect(draftRes.comments).toHaveLength(0);
  });

  // ----------------------------------------------------------------
  // Send (markdown)
  // ----------------------------------------------------------------

  it("POST /send marks markdown review as sent and returns a quoted-text prompt", async () => {
    const draft = (await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/file-reviews/draft`,
      payload: { filePath: planPath },
    })).json() as FileReview;

    await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/file-reviews/${draft.id}/comments`,
      payload: {
        kind: "selection",
        quotedText: "Plugin-based approach",
        text: "Add Netlify support",
      },
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/file-reviews/${draft.id}/send`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { prompt: string; review: FileReview };
    expect(body.prompt).toContain("Add Netlify support");
    expect(body.prompt).toContain("Plugin-based approach");
    expect(body.prompt).toContain(planPath);
    expect(body.review.status).toBe("sent");

    // Draft is gone
    const draftRes = await app.inject({
      method: "GET",
      url: `/api/sessions/${sessionId}/file-reviews/draft?filePath=${encodeURIComponent(planPath)}`,
    });
    expect(draftRes.statusCode).toBe(404);
  });

  // ----------------------------------------------------------------
  // Send (code)
  // ----------------------------------------------------------------

  it("POST /send returns a snippet-based prompt for code reviews", async () => {
    const draft = (await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/file-reviews/draft`,
      payload: { filePath: codePath },
    })).json() as FileReview;

    await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/file-reviews/${draft.id}/comments`,
      payload: { kind: "line", line: 2, text: "Hardcoded value" },
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/file-reviews/${draft.id}/send`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { prompt: string; review: FileReview };
    expect(body.prompt).toContain(codePath);
    expect(body.prompt).toContain("Hardcoded value");
    expect(body.prompt).toContain(":2");
  });

  it("POST /send rejects review with no comments", async () => {
    const draft = (await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/file-reviews/draft`,
      payload: { filePath: planPath },
    })).json() as FileReview;

    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/file-reviews/${draft.id}/send`,
    });
    expect(res.statusCode).toBe(400);
  });

  // ----------------------------------------------------------------
  // List
  // ----------------------------------------------------------------

  it("GET /file-reviews lists all reviews for a (session, file)", async () => {
    const first = (await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/file-reviews/draft`,
      payload: { filePath: planPath },
    })).json() as FileReview;
    await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/file-reviews/${first.id}/comments`,
      payload: { kind: "selection", quotedText: "Add deployment support", text: "Good" },
    });
    await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/file-reviews/${first.id}/send`,
    });

    // Start a fresh draft
    await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/file-reviews/draft`,
      payload: { filePath: planPath },
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/sessions/${sessionId}/file-reviews?filePath=${encodeURIComponent(planPath)}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { reviews: FileReview[] };
    expect(body.reviews).toHaveLength(2);
  });

  // ----------------------------------------------------------------
  // Delete draft
  // ----------------------------------------------------------------

  it("DELETE /file-reviews/:reviewId deletes an empty draft", async () => {
    const draft = (await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/file-reviews/draft`,
      payload: { filePath: planPath },
    })).json() as FileReview;

    const res = await app.inject({
      method: "DELETE",
      url: `/api/sessions/${sessionId}/file-reviews/${draft.id}`,
    });
    expect(res.statusCode).toBe(200);

    const draftRes = await app.inject({
      method: "GET",
      url: `/api/sessions/${sessionId}/file-reviews/draft?filePath=${encodeURIComponent(planPath)}`,
    });
    expect(draftRes.statusCode).toBe(404);
  });
});
