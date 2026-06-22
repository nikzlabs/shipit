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
  AgentId,
} from "../shared/types.js";
import { dispatchAgentMessage, runSubAgent, ServiceError } from "./services/index.js";
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

  // POST /api/sessions/:id/agent/spawn — docs/144 sub-agent spawn. Reached via
  // the worker's `/agent-ops/agent/spawn` broker, which injects the trusted
  // SESSION_ID into the path (the agent cannot name a different session) and
  // forwards the body. Blocks until the sub-agent exits, then returns its final
  // text. Errors map to the shim's non-zero exit (disabled, unknown agent, cap
  // exceeded, recursion, crash, …).
  app.post<{
    Params: { id: string };
    Body: { agentId?: AgentId; prompt?: string; depth?: number };
  }>(
    "/api/sessions/:id/agent/spawn",
    { config: { containerAccessible: true } },
    async (request, reply) => {
      try {
        const body = request.body ?? {};
        if (!body.agentId) {
          reply.code(400).send({ error: "agentId is required" });
          return;
        }
        const result = await runSubAgent(
          {
            sessionManager: deps.sessionManager,
            credentialStore: deps.credentialStore,
            agentRegistry: deps.agentRegistry,
            ...(deps.providerAccountManager ? { providerAccountManager: deps.providerAccountManager } : {}),
            runnerRegistry: deps.runnerRegistry,
            usageManager: deps.usageManager,
            chatHistoryManager: deps.chatHistoryManager,
            ...(deps.recordAgentRateLimits ? { recordAgentRateLimits: deps.recordAgentRateLimits } : {}),
            ...(deps.credentialsDir ? { credentialsDir: deps.credentialsDir } : {}),
          },
          request.params.id,
          {
            subAgentId: body.agentId,
            prompt: body.prompt ?? "",
            depth: typeof body.depth === "number" ? body.depth : 0,
          },
        );
        reply.send(result);
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Sub-agent spawn failed: ${getErrorMessage(err)}` });
      }
    },
  );
}
