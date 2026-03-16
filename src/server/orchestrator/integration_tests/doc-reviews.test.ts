import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildApp } from "../index.js";
import { GitManager } from "../../shared/git.js";
import { SessionManager } from "../sessions.js";
import { AuthManager } from "../auth.js";

import type { FastifyInstance } from "fastify";
import {
  StubAuthManager,
  StubGitHubAuthManager,
  FakeClaudeProcess,
  createTestCredentialStore,
  createTestDatabaseManager,
} from "./test-helpers.js";
import { DatabaseManager } from "../../shared/database.js";
import { GitHubAuthManager } from "../github-auth.js";
import { CredentialStore } from "../credential-store.js";
import type { DocReview, ReviewComment } from "../../shared/types.js";

describe("Integration: Doc Review HTTP Endpoints", () => {
  let app: FastifyInstance;
  let tmpDir: string;
  let dbManager: DatabaseManager;
  let credentialStore: CredentialStore;
  const featureId = "012-deployment";

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-doc-reviews-"));

    // Create docs directory with a plan.md
    const docsDir = path.join(tmpDir, "docs", featureId);
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

    credentialStore = createTestCredentialStore(tmpDir);

    app = await buildApp({
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager: new SessionManager(dbManager),
      authManager: new StubAuthManager() as unknown as AuthManager,
      githubAuthManager: new StubGitHubAuthManager() as unknown as GitHubAuthManager,
      agentFactory: () => new FakeClaudeProcess() as any,
      credentialStore,
      workspaceDir: tmpDir,
      serveStatic: false,
    });
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

  it("POST /api/features/:featureId/reviews creates a draft", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/features/${featureId}/reviews`,
      payload: { planPath },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as DocReview;
    expect(body.status).toBe("draft");
    expect(body.featureId).toBe(featureId);
    expect(body.planPath).toBe(planPath);
    expect(body.sectionHeadings).toContain("## Summary");
    expect(body.sectionHeadings).toContain("## Architecture");
    expect(body.sectionHeadings).toContain("## Testing");
    expect(body.comments).toHaveLength(0);
  });

  it("GET /api/features/:featureId/reviews/draft returns existing draft", async () => {
    // Create draft
    await app.inject({
      method: "POST",
      url: `/api/features/${featureId}/reviews`,
      payload: { planPath },
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/features/${featureId}/reviews/draft`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as DocReview;
    expect(body.status).toBe("draft");
  });

  it("GET /api/features/:featureId/reviews/draft returns 404 when no draft", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/features/${featureId}/reviews/draft`,
    });
    expect(res.statusCode).toBe(404);
  });

  it("POST .../comments adds a comment to a draft", async () => {
    const draft = (await app.inject({
      method: "POST",
      url: `/api/features/${featureId}/reviews`,
      payload: { planPath },
    })).json() as DocReview;

    const res = await app.inject({
      method: "POST",
      url: `/api/features/${featureId}/reviews/${draft.id}/comments`,
      payload: {
        sectionHeading: "## Architecture",
        sectionIndex: 2,
        text: "Consider a registry pattern",
        source: "human",
      },
    });
    expect(res.statusCode).toBe(200);
    const comment = res.json() as ReviewComment;
    expect(comment.text).toBe("Consider a registry pattern");
    expect(comment.source).toBe("human");
    expect(comment.sectionHeading).toBe("## Architecture");
  });

  it("POST .../comments validates empty text", async () => {
    const draft = (await app.inject({
      method: "POST",
      url: `/api/features/${featureId}/reviews`,
      payload: { planPath },
    })).json() as DocReview;

    const res = await app.inject({
      method: "POST",
      url: `/api/features/${featureId}/reviews/${draft.id}/comments`,
      payload: {
        sectionHeading: "## Summary",
        sectionIndex: 1,
        text: "   ",
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it("PATCH .../comments/:commentId updates comment text", async () => {
    const draft = (await app.inject({
      method: "POST",
      url: `/api/features/${featureId}/reviews`,
      payload: { planPath },
    })).json() as DocReview;

    const comment = (await app.inject({
      method: "POST",
      url: `/api/features/${featureId}/reviews/${draft.id}/comments`,
      payload: { sectionHeading: "## Summary", sectionIndex: 1, text: "Original" },
    })).json() as ReviewComment;

    const res = await app.inject({
      method: "PATCH",
      url: `/api/features/${featureId}/reviews/${draft.id}/comments/${comment.id}`,
      payload: { text: "Updated text" },
    });
    expect(res.statusCode).toBe(200);

    // Verify
    const draftRes = (await app.inject({
      method: "GET",
      url: `/api/features/${featureId}/reviews/draft`,
    })).json() as DocReview;
    expect(draftRes.comments[0].text).toBe("Updated text");
  });

  it("DELETE .../comments/:commentId removes comment", async () => {
    const draft = (await app.inject({
      method: "POST",
      url: `/api/features/${featureId}/reviews`,
      payload: { planPath },
    })).json() as DocReview;

    const comment = (await app.inject({
      method: "POST",
      url: `/api/features/${featureId}/reviews/${draft.id}/comments`,
      payload: { sectionHeading: "## Summary", sectionIndex: 1, text: "Delete me" },
    })).json() as ReviewComment;

    const res = await app.inject({
      method: "DELETE",
      url: `/api/features/${featureId}/reviews/${draft.id}/comments/${comment.id}`,
    });
    expect(res.statusCode).toBe(200);

    const draftRes = (await app.inject({
      method: "GET",
      url: `/api/features/${featureId}/reviews/draft`,
    })).json() as DocReview;
    expect(draftRes.comments).toHaveLength(0);
  });

  it("POST .../send marks review as sent and returns prompt", async () => {
    const draft = (await app.inject({
      method: "POST",
      url: `/api/features/${featureId}/reviews`,
      payload: { planPath },
    })).json() as DocReview;

    await app.inject({
      method: "POST",
      url: `/api/features/${featureId}/reviews/${draft.id}/comments`,
      payload: { sectionHeading: "## Architecture", sectionIndex: 2, text: "Add Netlify support" },
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/features/${featureId}/reviews/${draft.id}/send`,
      payload: { sessionId: "test-session-123" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { prompt: string };
    expect(body.prompt).toContain("Add Netlify support");
    expect(body.prompt).toContain("## Architecture");

    // Verify it's no longer a draft
    const draftRes = await app.inject({
      method: "GET",
      url: `/api/features/${featureId}/reviews/draft`,
    });
    expect(draftRes.statusCode).toBe(404);
  });

  it("POST .../send rejects review with no comments", async () => {
    const draft = (await app.inject({
      method: "POST",
      url: `/api/features/${featureId}/reviews`,
      payload: { planPath },
    })).json() as DocReview;

    const res = await app.inject({
      method: "POST",
      url: `/api/features/${featureId}/reviews/${draft.id}/send`,
      payload: { sessionId: "test-session-123" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("GET /api/features/:featureId/reviews lists all reviews", async () => {
    // Create and send a review
    const draft = (await app.inject({
      method: "POST",
      url: `/api/features/${featureId}/reviews`,
      payload: { planPath },
    })).json() as DocReview;

    await app.inject({
      method: "POST",
      url: `/api/features/${featureId}/reviews/${draft.id}/comments`,
      payload: { sectionHeading: "## Summary", sectionIndex: 1, text: "Good" },
    });

    await app.inject({
      method: "POST",
      url: `/api/features/${featureId}/reviews/${draft.id}/send`,
      payload: { sessionId: "s1" },
    });

    // Create a new draft
    await app.inject({
      method: "POST",
      url: `/api/features/${featureId}/reviews`,
      payload: { planPath },
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/features/${featureId}/reviews`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { reviews: DocReview[] };
    expect(body.reviews).toHaveLength(2);
  });

  it("DELETE /api/features/:featureId/reviews/:reviewId deletes a draft", async () => {
    const draft = (await app.inject({
      method: "POST",
      url: `/api/features/${featureId}/reviews`,
      payload: { planPath },
    })).json() as DocReview;

    const res = await app.inject({
      method: "DELETE",
      url: `/api/features/${featureId}/reviews/${draft.id}`,
    });
    expect(res.statusCode).toBe(200);

    const draftRes = await app.inject({
      method: "GET",
      url: `/api/features/${featureId}/reviews/draft`,
    });
    expect(draftRes.statusCode).toBe(404);
  });
});
