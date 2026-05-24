/**
 * Agent dispatch API routes (docs/150).
 *
 * HTTP-side entry point for system-initiated client buttons (Create PR, Send
 * compose error, Auto-fix preview errors, etc.) that previously either
 * prefilled the textarea or sent a `send_message` over WS. Internally
 * delegates to the same `runner.dispatch` funnel that Fix CI and child-session
 * spawn use, so the send-or-queue rule lives in one place.
 */

import type { FastifyInstance } from "fastify";
import type { ApiDeps } from "./api-routes.js";
import type {
  PermissionMode,
  ImageAttachment,
  FileContextRef,
  UploadRef,
} from "../shared/types.js";
import { dispatchAgentMessage, ServiceError } from "./services/index.js";
import { getErrorMessage } from "./validation.js";

export async function registerAgentRoutes(
  app: FastifyInstance,
  deps: ApiDeps,
): Promise<void> {
  // POST /api/sessions/:id/agent/dispatch — dispatch a system-initiated agent
  // message. Mirrors the gates the WS `send_message` handler runs; the
  // runner.dispatch funnel owns the queue/send decision.
  app.post<{
    Params: { id: string };
    Body: {
      text?: string;
      activity?: string;
      permissionMode?: PermissionMode;
      images?: ImageAttachment[];
      files?: FileContextRef[];
      uploads?: UploadRef[];
      reviewFilePath?: string;
    };
  }>(
    "/api/sessions/:id/agent/dispatch",
    async (request, reply) => {
      try {
        const body = request.body ?? {};
        const result = await dispatchAgentMessage(
          {
            runnerRegistry: deps.runnerRegistry,
            agentRegistry: deps.agentRegistry,
            credentialStore: deps.credentialStore,
            authManager: deps.authManager,
          },
          request.params.id,
          {
            text: body.text ?? "",
            ...(body.activity !== undefined ? { activity: body.activity } : {}),
            ...(body.permissionMode !== undefined ? { permissionMode: body.permissionMode } : {}),
            ...(body.images !== undefined ? { images: body.images } : {}),
            ...(body.files !== undefined ? { files: body.files } : {}),
            ...(body.uploads !== undefined ? { uploads: body.uploads } : {}),
            ...(body.reviewFilePath !== undefined ? { reviewFilePath: body.reviewFilePath } : {}),
          },
        );
        reply.send(result);
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Dispatch failed: ${getErrorMessage(err)}` });
      }
    },
  );
}
