/**
 * File and document API routes.
 * Handles: file tree, file content, write/edit, docs, uploads.
 */

import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { ApiDeps } from "./api-routes.js";
import { resolveSessionDir } from "./api-routes.js";

import {
  getFileTree,
  getFileContent,
  listDocs,
  getDocContent,
  saveUploadedFile,
  listUploads,
  MAX_UPLOAD_FILES_PER_REQUEST,
  ServiceError,
} from "./services/index.js";
import { getErrorMessage } from "./validation.js";

export async function registerFileRoutes(
  app: FastifyInstance,
  deps: ApiDeps,
): Promise<void> {
  const { sessionManager } = deps;

  // GET /api/sessions/:id/files — file tree
  app.get<{ Params: { id: string } }>("/api/sessions/:id/files", async (request, reply) => {
    const dir = resolveSessionDir(sessionManager, request.params.id, reply);
    if (!dir) return;
    return { tree: await getFileTree(dir) };
  });

  // GET /api/sessions/:id/files/* — file content
  app.get<{ Params: { id: string; "*": string }; Querystring: { tree?: string } }>(
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
        const result = await getFileContent(dir, filePath);
        const response: Record<string, unknown> = {
          path: filePath,
          content: result.content,
          isBinary: result.isBinary,
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

  // GET /api/sessions/:id/docs — doc list
  app.get<{ Params: { id: string } }>("/api/sessions/:id/docs", async (request, reply) => {
    const dir = resolveSessionDir(sessionManager, request.params.id, reply);
    if (!dir) return;
    return { files: await listDocs(dir) };
  });

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

      const uploadsDir = path.join(session.workspaceDir, "uploads");

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

      const uploadsDir = path.join(session.workspaceDir, "uploads");
      const files = await listUploads(uploadsDir);
      return { files };
    },
  );
}
