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
  listDocs,
  listSkills,
  getDocContent,
  saveUploadedFile,
  listUploads,
  deleteUpload,
  MAX_UPLOAD_FILES_PER_REQUEST,
  ServiceError,
} from "./services/index.js";
import { getErrorMessage } from "./validation.js";

export async function registerFileRoutes(
  app: FastifyInstance,
  deps: ApiDeps,
): Promise<void> {
  const { sessionManager, defaultAgentId } = deps;

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
    return { docs: await listDocs(dir) };
  });

  // GET /api/sessions/:id/skills — user-invocable project skills for the
  // composer's `/` autocomplete. The backend is the session's locked-in agent
  // (falling back to the optional ?agent= override, then the server default),
  // since Claude scans `.claude/skills/**` and Codex scans `.codex/prompts/**`.
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
      return { skills: await listSkills(dir, agentId) };
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
}
