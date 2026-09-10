import fs from "node:fs/promises";
import { etagFor, matchesIfNoneMatch } from "./http-etag.js";
import path from "node:path";
import { createReadStream } from "node:fs";
import type { FastifyInstance } from "fastify";
import type { ApiDeps } from "./api-routes.js";
import type { UploadedFile } from "../shared/types.js";
import { resolveSessionDir } from "./api-routes.js";

import {
  getFileTree,
  getFileContent,
  getRawFilePath,
  writeFileContent,
  listDocs,
  getSessionChangedPaths,
  listSkills,
  getDocContent,
  saveUploadedFile,
  listUploads,
  deleteUpload,
  MAX_UPLOAD_FILES_PER_REQUEST,
  ServiceError,
  installPlugin,
  withWorkspaceLock,
  getCatalogCacheRoot,
  ensureCatalogCloned,
  killAgent,
} from "./services/index.js";
import { sessionAutoCommitAllowed } from "./services/auto-commit-gate.js";
import type { MarketplaceStore } from "./marketplace-store.js";
import { getErrorMessage } from "./validation.js";
import { pushToOrigin } from "./git-utils.js";
import { emitNoticePostTurn, persistNoticeUnattached } from "./chat-card-persistence.js";
import { formatUnreadableWorkspaceNotice } from "./services/unreadable-workspace-notice.js";

async function commitManualEdit(
  deps: ApiDeps,
  sessionId: string,
  dir: string,
  filePath: string,
): Promise<void> {
  const runner = deps.runnerRegistry.get(sessionId);
  // autoCommit stages all files; a running turn must commit its own edits.
  if ((runner as { running?: boolean } | undefined)?.running) return;
  if (!sessionAutoCommitAllowed(deps.sessionManager, sessionId)) return;
  try {
    const git = deps.createGitManager(dir);
    const { commitHash, unreadable } = await withWorkspaceLock(dir, () =>
      git.autoCommit(`Edit ${path.basename(filePath)}`),
    );
    if (unreadable) {
      const message = formatUnreadableWorkspaceNotice(unreadable, {
        committed: commitHash !== null,
        what: "This file edit",
      });
      if (runner) {
        emitNoticePostTurn((m) => runner.emitMessage(m), deps.chatHistoryManager, sessionId, message, "warn");
      } else {
        persistNoticeUnattached(deps.chatHistoryManager, sessionId, message, "warn");
      }
    }
    if (commitHash && deps.githubAuthManager.authenticated) {
      void pushToOrigin(git, (reason) => {
        const why = reason === "no-origin" ? "no `origin` remote" : "no current branch (detached HEAD)";
        console.warn(`[files] manual-edit auto-push skipped for ${sessionId}: ${why}`);
      }).catch((err: unknown) => {
        console.warn("[files] manual-edit auto-push failed:", getErrorMessage(err));
      });
    }
  } catch (err) {
    console.warn("[files] manual-edit auto-commit failed:", getErrorMessage(err));
  }
}

export async function registerFileRoutes(
  app: FastifyInstance,
  deps: ApiDeps & { marketplaceStore?: MarketplaceStore },
): Promise<void> {
  const { sessionManager, defaultAgentId, runnerRegistry, marketplaceStore, agentRegistry } = deps;
  const cacheRoot = getCatalogCacheRoot(deps.stateDir ?? deps.workspaceDir);

  app.get<{ Params: { id: string } }>("/api/sessions/:id/files", async (request, reply) => {
    const dir = resolveSessionDir(sessionManager, request.params.id, reply);
    if (!dir) return;
    const body = JSON.stringify({ tree: await getFileTree(dir) });
    const etag = etagFor(body);
    if (matchesIfNoneMatch(request.headers["if-none-match"], etag)) {
      reply.code(304).send();
      return;
    }
    reply.header("etag", etag).header("cache-control", "no-cache").type("application/json");
    return reply.send(body);
  });

  app.get<{ Params: { id: string; "*": string }; Querystring: { tree?: string; raw?: string } }>(
    "/api/sessions/:id/files/*",
    async (request, reply) => {
      const dir = resolveSessionDir(sessionManager, request.params.id, reply);
      if (!dir) return;
      const filePath = request.params["*"];
      if (!filePath) {
        reply.code(400).send({ error: "File path is required" });
        return;
      }
      try {
        const resolveDir = filePath.startsWith("uploads/")
          ? path.dirname(dir)
          : dir;

        if (request.query.raw === "true") {
          const safePath = path.resolve(resolveDir, filePath);
          if (!safePath.startsWith(`${resolveDir}/`)) {
            reply.code(400).send({ error: "Invalid path" });
            return;
          }
          const ext = path.extname(filePath).slice(1).toLowerCase();
          const mimeMap: Record<string, string> = {
            png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
            gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
          };
          const mime = mimeMap[ext];
          if (!mime) {
            reply.code(400).send({ error: "Raw mode only supports images" });
            return;
          }
          const data = await fs.readFile(safePath);
          reply.type(mime).send(data);
          return;
        }

        const result = await getFileContent(resolveDir, filePath);
        const response: Record<string, unknown> = {
          path: filePath,
          content: result.content,
          isBinary: result.isBinary,
          isImage: result.isImage,
        };
        if (request.query.tree === "true") {
          response.tree = await getFileTree(dir);
        }
        return response;
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(404).send({ error: `File not found: ${getErrorMessage(err)}` });
      }
    },
  );

  app.put<{ Params: { id: string; "*": string }; Body: { content?: unknown } }>(
    "/api/sessions/:id/files/*",
    async (request, reply) => {
      const dir = resolveSessionDir(sessionManager, request.params.id, reply);
      if (!dir) return;
      const session = sessionManager.get(request.params.id);
      if (session?.warm) {
        reply.code(409).send({
          error: "Editing isn't available until the session starts — send a message first.",
        });
        return;
      }
      const filePath = request.params["*"];
      if (!filePath) {
        reply.code(400).send({ error: "File path is required" });
        return;
      }
      if (typeof request.body?.content !== "string") {
        reply.code(400).send({ error: "content is required and must be a string" });
        return;
      }
      try {
        const result = await writeFileContent(dir, filePath, request.body.content);
        await commitManualEdit(deps, request.params.id, dir, filePath);
        return result;
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `File save failed: ${getErrorMessage(err)}` });
      }
    },
  );

  app.get<{ Params: { id: string; "*": string } }>(
    "/api/sessions/:id/files/download/*",
    async (request, reply) => {
      const dir = resolveSessionDir(sessionManager, request.params.id, reply);
      if (!dir) return;
      const filePath = request.params["*"];
      if (!filePath) {
        reply.code(400).send({ error: "File path is required" });
        return;
      }
      try {
        const { safePath, filename } = getRawFilePath(dir, filePath);
        reply.header("Content-Disposition", `attachment; filename="${filename}"`);
        const stream = createReadStream(safePath);
        return await reply.send(stream);
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(404).send({ error: `File not found: ${getErrorMessage(err)}` });
      }
    },
  );

  app.get<{ Params: { id: string } }>("/api/sessions/:id/docs", async (request, reply) => {
    const dir = resolveSessionDir(sessionManager, request.params.id, reply);
    if (!dir) return;
    const docs = await listDocs(dir);
    // Use the PR's base so document flags match the PR's changed files.
    try {
      const session = sessionManager.get(request.params.id);
      const git = deps.createGitManager(dir);
      const baseBranch =
        deps.prStatusPoller?.getStatus(request.params.id)?.baseBranch ??
        session?.previousMergedPr?.baseBranch ??
        await git.getDefaultBranch();
      const changed = await getSessionChangedPaths(git, baseBranch);
      for (const doc of docs) {
        if (changed.has(doc.path)) doc.changedInSession = true;
      }
    } catch {
      // No git / unresolvable base — leave changedInSession unset.
    }
    return { docs };
  });

  app.get<{ Params: { id: string }; Querystring: { agent?: string } }>(
    "/api/sessions/:id/skills",
    async (request, reply) => {
      const dir = resolveSessionDir(sessionManager, request.params.id, reply);
      if (!dir) return;
      const session = sessionManager.get(request.params.id);
      const queryAgent =
        request.query.agent === "codex" || request.query.agent === "claude"
        || request.query.agent === "opencode" || request.query.agent === "grok"
          ? request.query.agent
          : undefined;
      const agentId = session?.agentId ?? queryAgent ?? defaultAgentId;

      const skillsDirName = agentRegistry.get(agentId)?.capabilities.skillsDirName ?? ".claude";
      const projectSkills = await listSkills(dir, skillsDirName);
      // eslint-disable-next-line no-restricted-syntax -- Codex bundles skills inside the container.
      if (agentId !== "codex") {
        return { skills: projectSkills };
      }

      let bundled: Awaited<ReturnType<typeof listSkills>> = [];
      const runner = runnerRegistry.get(request.params.id);
      if (runner?.getCodexBuiltinSkills) {
        try {
          bundled = await runner.getCodexBuiltinSkills();
        } catch {
          bundled = [];
        }
      }
      const names = new Set(projectSkills.map((s) => s.name));
      const merged = [...projectSkills, ...bundled.filter((s) => !names.has(s.name))];
      merged.sort((a, b) => a.name.localeCompare(b.name));
      return { skills: merged };
    },
  );

  app.get<{ Params: { id: string; "*": string } }>(
    "/api/sessions/:id/docs/*",
    async (request, reply) => {
      const dir = resolveSessionDir(sessionManager, request.params.id, reply);
      if (!dir) return;
      const docPath = request.params["*"];
      if (!docPath) {
        reply.code(400).send({ error: "Doc path is required" });
        return;
      }
      try {
        const content = await getDocContent(dir, docPath);
        return { path: docPath, content };
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(404).send({ error: `Doc not found: ${getErrorMessage(err)}` });
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/sessions/:id/files/uploads",
    async (request, reply) => {
      const session = sessionManager.get(request.params.id);
      if (!session) {
        reply.code(404).send({ error: "Session not found" });
        return;
      }
      if (!session.workspaceDir) {
        reply.code(404).send({ error: "Session has no workspace directory" });
        return;
      }

      const uploadsDir = path.join(path.dirname(session.workspaceDir), "uploads");

      // Roll back the batch on failure so retries cannot leave duplicate files.
      const results: UploadedFile[] = [];
      const rollback = async () => {
        for (const saved of results) {
          // saveUploadedFile exclusively creates each name; this request owns it.
          await deleteUpload(uploadsDir, path.basename(saved.path)).catch((err: unknown) => {
            app.log.warn(`[upload] rollback of ${saved.path} failed: ${getErrorMessage(err)}`);
          });
        }
      };
      try {
        const parts = request.files();
        let fileCount = 0;

        for await (const part of parts) {
          fileCount++;
          if (fileCount > MAX_UPLOAD_FILES_PER_REQUEST) {
            await rollback();
            reply.code(400).send({ error: `Maximum ${MAX_UPLOAD_FILES_PER_REQUEST} files per upload` });
            return;
          }
          const buf = await part.toBuffer();
          const uploaded = await saveUploadedFile(uploadsDir, part.filename, buf);
          results.push(uploaded);
        }

        if (results.length === 0) {
          reply.code(400).send({ error: "No files provided" });
          return;
        }

        return { files: results };
      } catch (err) {
        await rollback();
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Upload failed: ${getErrorMessage(err)}` });
      }
    },
  );

  app.delete<{ Params: { id: string; filename: string } }>(
    "/api/sessions/:id/files/uploads/:filename",
    async (request, reply) => {
      const session = sessionManager.get(request.params.id);
      if (!session) {
        reply.code(404).send({ error: "Session not found" });
        return;
      }
      if (!session.workspaceDir) {
        reply.code(404).send({ error: "Session has no workspace directory" });
        return;
      }

      const uploadsDir = path.join(path.dirname(session.workspaceDir), "uploads");
      try {
        const deleted = await deleteUpload(uploadsDir, request.params.filename);
        if (!deleted) {
          reply.code(404).send({ error: "File not found" });
          return;
        }
        return { deleted: true };
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Delete failed: ${getErrorMessage(err)}` });
      }
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/sessions/:id/files/uploads",
    async (request, reply) => {
      const session = sessionManager.get(request.params.id);
      if (!session) {
        reply.code(404).send({ error: "Session not found" });
        return;
      }
      if (!session.workspaceDir) {
        reply.code(404).send({ error: "Session has no workspace directory" });
        return;
      }

      const uploadsDir = path.join(path.dirname(session.workspaceDir), "uploads");
      const files = await listUploads(uploadsDir);
      return { files };
    },
  );

  if (marketplaceStore) {
    app.post<{
      Params: { id: string };
      Body: { marketplaceId?: unknown; pluginName?: unknown };
    }>("/api/sessions/:id/plugins/install", async (request, reply) => {
      const dir = resolveSessionDir(sessionManager, request.params.id, reply);
      if (!dir) return;
      const session = sessionManager.get(request.params.id);
      const agentId = session?.agentId ?? defaultAgentId;

      const marketplaceId = typeof request.body.marketplaceId === "string"
        ? request.body.marketplaceId : null;
      const pluginName = typeof request.body.pluginName === "string"
        ? request.body.pluginName : null;
      if (!marketplaceId || !pluginName) {
        reply.code(400).send({ error: "marketplaceId and pluginName are required" });
        return;
      }

      const runner = runnerRegistry.get(request.params.id) as
        | { running?: boolean } | undefined;
      if (runner?.running) {
        reply.code(409).send({
          error: "Agent is working — install will become available when it's done.",
        });
        return;
      }

      try {
        await ensureCatalogCloned(marketplaceStore, marketplaceId, cacheRoot);
        const git = deps.createGitManager(dir);
        const result = await withWorkspaceLock(dir, async () => {
          return installPlugin({
            workspaceDir: dir,
            agentId,
            marketplaceId,
            pluginName,
            cacheRoot,
            store: marketplaceStore,
            git,
            agentRegistry,
          });
        });

        // Restart persistent backends so they read the installed skills.
        try {
          await killAgent({
            sessionManager,
            containerManager: deps.containerManager ?? null,
            runnerRegistry,
            defaultAgentId: deps.defaultAgentId,
            ...(deps.prStatusPoller
              ? {
                  postInterruptCommitDeps: {
                    sessionManager,
                    chatHistoryManager: deps.chatHistoryManager,
                    prStatusPoller: deps.prStatusPoller,
                    githubAuthManager: deps.githubAuthManager,
                    credentialStore: deps.credentialStore,
                    generateText: deps.generateText,
                    createGitManager: deps.createGitManager,
                  },
                }
              : {}),
          }, request.params.id);
        } catch (err) {
          console.warn("[marketplace] post-install killAgent failed:", getErrorMessage(err));
        }

        return result;
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: getErrorMessage(err) });
      }
    });
  }
}
