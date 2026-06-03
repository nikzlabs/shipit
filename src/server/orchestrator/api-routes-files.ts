/**
 * File and document API routes.
 * Handles: file tree, file content, write/edit, docs, uploads.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { createReadStream } from "node:fs";
import type { FastifyInstance } from "fastify";
import type { ApiDeps } from "./api-routes.js";
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
  uninstallPlugin,
  scanInstalledPlugins,
  withWorkspaceLock,
  getCatalogCacheRoot,
  ensureCatalogCloned,
  killAgent,
} from "./services/index.js";
import type { MarketplaceStore } from "./marketplace-store.js";
import { getErrorMessage } from "./validation.js";

export async function registerFileRoutes(
  app: FastifyInstance,
  deps: ApiDeps & { marketplaceStore?: MarketplaceStore },
): Promise<void> {
  const { sessionManager, defaultAgentId, runnerRegistry, marketplaceStore, agentRegistry } = deps;
  const cacheRoot = getCatalogCacheRoot(deps.stateDir ?? deps.workspaceDir);

  // GET /api/sessions/:id/files — file tree
  app.get<{ Params: { id: string } }>("/api/sessions/:id/files", async (request, reply) => {
    const dir = resolveSessionDir(sessionManager, request.params.id, reply);
    if (!dir) return;
    return { tree: await getFileTree(dir) };
  });

  // GET /api/sessions/:id/files/* — file content
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
        // Upload files live in a sibling "uploads" directory, not inside workspace
        const resolveDir = filePath.startsWith("uploads/")
          ? path.dirname(dir)
          : dir;

        // raw=true: serve image bytes directly (for <img src> usage)
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

  // PUT /api/sessions/:id/files/* — write UTF-8 file content
  app.put<{ Params: { id: string; "*": string }; Body: { content?: unknown } }>(
    "/api/sessions/:id/files/*",
    async (request, reply) => {
      const dir = resolveSessionDir(sessionManager, request.params.id, reply);
      if (!dir) return;
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
        return await writeFileContent(dir, filePath, request.body.content);
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `File save failed: ${getErrorMessage(err)}` });
      }
    },
  );

  // GET /api/sessions/:id/files/download/* — download raw file
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

  // GET /api/sessions/:id/docs — doc list with optional status metadata
  app.get<{ Params: { id: string } }>("/api/sessions/:id/docs", async (request, reply) => {
    const dir = resolveSessionDir(sessionManager, request.params.id, reply);
    if (!dir) return;
    const docs = await listDocs(dir);
    // Flag docs the agent actually changed this session, using git (committed
    // branch changes + uncommitted edits) rather than file mtimes. Git rewrites
    // mtimes on every checkout/fetch/reset, so the mtime heuristic falsely
    // flagged files the session never touched. Best-effort — on any git error
    // we leave the flag unset and the client falls back gracefully.
    try {
      const changed = await getSessionChangedPaths(deps.createGitManager(dir));
      for (const doc of docs) {
        if (changed.has(doc.path)) doc.changedInSession = true;
      }
    } catch {
      // No git / unresolvable base — leave changedInSession unset.
    }
    return { docs };
  });

  // GET /api/sessions/:id/skills — user-invocable skills for the composer's `/`
  // autocomplete. The backend is the session's locked-in agent (falling back to
  // the optional ?agent= override, then the server default): Claude scans
  // `.claude/skills/**`, Codex scans `.codex/skills/**`. For Codex we also merge
  // its built-in system skills (`~/.codex/skills/**`), which live inside the
  // container and are scanned by a session-worker endpoint (the orchestrator
  // can't read that path directly). See docs/138-skill-invocation.
  app.get<{ Params: { id: string }; Querystring: { agent?: string } }>(
    "/api/sessions/:id/skills",
    async (request, reply) => {
      const dir = resolveSessionDir(sessionManager, request.params.id, reply);
      if (!dir) return;
      const session = sessionManager.get(request.params.id);
      const queryAgent = request.query.agent === "codex" || request.query.agent === "claude"
        ? request.query.agent
        : undefined;
      const agentId = session?.agentId ?? queryAgent ?? defaultAgentId;

      const skillsDirName = agentRegistry.get(agentId)?.capabilities.skillsDirName ?? ".claude";
      const projectSkills = await listSkills(dir, skillsDirName);
      // eslint-disable-next-line no-restricted-syntax -- docs/155 hair 8: Codex ships built-in skills inside ~/.codex/skills/; Claude has none today. Becomes an optional runner method (`getBuiltinSkills?()`) once a second backend ships built-ins.
      if (agentId !== "codex") {
        return { skills: projectSkills };
      }

      // Merge Codex's container-side built-ins. Best-effort — if there's no
      // running container or the worker is unreachable, fall back to project
      // skills alone rather than failing the autocomplete.
      let bundled: Awaited<ReturnType<typeof listSkills>> = [];
      const runner = runnerRegistry.get(request.params.id);
      if (runner?.getCodexBuiltinSkills) {
        try {
          bundled = await runner.getCodexBuiltinSkills();
        } catch {
          bundled = [];
        }
      }
      // Project skills win over a built-in of the same name.
      const names = new Set(projectSkills.map((s) => s.name));
      const merged = [...projectSkills, ...bundled.filter((s) => !names.has(s.name))];
      merged.sort((a, b) => a.name.localeCompare(b.name));
      return { skills: merged };
    },
  );

  // GET /api/sessions/:id/docs/* — doc content
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

  // POST /api/sessions/:id/files/uploads — upload files
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

      try {
        const parts = request.files();
        const results = [];
        let fileCount = 0;

        for await (const part of parts) {
          fileCount++;
          if (fileCount > MAX_UPLOAD_FILES_PER_REQUEST) {
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
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Upload failed: ${getErrorMessage(err)}` });
      }
    },
  );

  // DELETE /api/sessions/:id/files/uploads/:filename — delete an uploaded file
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

  // GET /api/sessions/:id/files/uploads — list uploaded files
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

  // ---- Plugin install/uninstall (docs/149) ----
  // These are session-scoped because the install writes into the session's
  // workspace and auto-commits there. App-wide marketplace browsing lives in
  // `api-routes-marketplace.ts`; the routes here are the action verbs that
  // mutate the workspace.
  //
  // The install flow:
  //   1. Refuses while `runner.running` (no install during a turn — see plan
  //      §Concurrency case 1). The runner state mutex shared with
  //      `postTurnCommit` covers the post-turn commit window.
  //   2. Acquires the per-workspace install mutex (shared with `postTurnCommit`
  //      via `withWorkspaceLock`) so install↔post-turn-commit and
  //      install↔install on the same workspace are fully serialized.
  //   3. Calls `installPlugin()` which uses a path-scoped `git add` (not -A).
  //   4. Calls `killAgent` on the runner — noop for one-shot `claude -p`
  //      between turns; SIGKILLs persistent backends so the next turn
  //      respawns with the new skills picked up.

  if (marketplaceStore) {
    // GET /api/sessions/:id/plugins — installed plugin rows for the Installed sub-tab.
    app.get<{ Params: { id: string } }>(
      "/api/sessions/:id/plugins",
      async (request, reply) => {
        const dir = resolveSessionDir(sessionManager, request.params.id, reply);
        if (!dir) return;
        const session = sessionManager.get(request.params.id);
        const agentId = session?.agentId ?? defaultAgentId;
        const installed = await scanInstalledPlugins(dir, agentId, agentRegistry);
        return { plugins: installed };
      },
    );

    // POST /api/sessions/:id/plugins/install — install a plugin from a catalog.
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

      // Refuse install while a turn is running — see plan §Concurrency case 1.
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

        // Persistent backends need a kill so the next turn re-scans skills.
        // For one-shot `claude -p` this is a noop between turns.
        try {
          await killAgent({
            sessionManager,
            containerManager: deps.containerManager ?? null,
            runnerRegistry,
            defaultAgentId: deps.defaultAgentId,
            // Plugin install/uninstall: killAgent is just here to force the
            // next turn's CLI to re-scan skills. The install path already
            // committed its own changes via withWorkspaceLock, so the
            // post-interrupt fallback is a no-op (clean tree) but we wire
            // the deps anyway for consistency with the recovery path.
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
          // The worker may be unreachable during install (e.g. fresh session).
          // That's fine — skills are read from disk on next agent spawn.
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

    // DELETE /api/sessions/:id/plugins/:marketplaceId/:pluginName — uninstall.
    app.delete<{
      Params: { id: string; marketplaceId: string; pluginName: string };
    }>(
      "/api/sessions/:id/plugins/:marketplaceId/:pluginName",
      async (request, reply) => {
        const dir = resolveSessionDir(sessionManager, request.params.id, reply);
        if (!dir) return;
        const session = sessionManager.get(request.params.id);
        const agentId = session?.agentId ?? defaultAgentId;

        const runner = runnerRegistry.get(request.params.id) as
          | { running?: boolean } | undefined;
        if (runner?.running) {
          reply.code(409).send({
            error: "Agent is working — uninstall will become available when it's done.",
          });
          return;
        }

        try {
          const git = deps.createGitManager(dir);
          const result = await withWorkspaceLock(dir, async () => {
            return uninstallPlugin({
              workspaceDir: dir,
              agentId,
              marketplaceId: request.params.marketplaceId,
              pluginName: request.params.pluginName,
              git,
              agentRegistry,
            });
          });
          // Force respawn so any persistent agent drops the removed skills.
          try {
            await killAgent({
              sessionManager,
              containerManager: deps.containerManager ?? null,
              runnerRegistry,
              defaultAgentId: deps.defaultAgentId,
            }, request.params.id);
          } catch (err) {
            console.warn("[marketplace] post-uninstall killAgent failed:", getErrorMessage(err));
          }
          return result;
        } catch (err) {
          if (err instanceof ServiceError) {
            reply.code(err.statusCode).send({ error: err.message });
            return;
          }
          reply.code(500).send({ error: getErrorMessage(err) });
        }
      },
    );
  }
}
