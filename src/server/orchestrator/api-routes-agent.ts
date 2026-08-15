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
import {
  dispatchAgentMessage,
  materializeRunner,
  runSubAgent,
  parseSubAgentSpawnTarget,
  getSubAgentResult,
  waitForSubAgentResult,
  listRolesForAgent,
  listSpawnParameters,
  DEFAULT_SUB_AGENT_WAIT_MS,
  MAX_SUB_AGENT_WAIT_MS,
  ServiceError,
} from "./services/index.js";
import { getErrorMessage } from "./validation.js";
import { AgentTurnAdmissionError } from "./session-runner.js";
import type { AgentInterfaceProvenance } from "../shared/agent-interface-sdk/protocol.js";

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
      agentInterface?: AgentInterfaceProvenance;
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
            sessionManager: deps.sessionManager,
            graduation: {
              repoStore: deps.repoStore,
              createGitManager: deps.createGitManager,
              sseBroadcast: deps.sseBroadcast,
              ...(deps.prStatusPoller ? { prStatusPoller: deps.prStatusPoller } : {}),
              ...(deps.ensureAgentTokenFresh ? { ensureAgentTokenFresh: deps.ensureAgentTokenFresh } : {}),
            },
            ...(deps.warmSessionForRepo ? { warmSessionForRepo: deps.warmSessionForRepo } : {}),
            // docs/131 reqs 8–10 — a dispatch at a session nobody has open
            // wakes it instead of 404ing. Same materialization the WS connect
            // path runs (archived guard, workspace restore, agent
            // reconciliation), so the two transports can't drift.
            wakeSession: (sessionId) => materializeRunner(
              {
                sessionManager: deps.sessionManager,
                runnerRegistry: deps.runnerRegistry,
                createRepoGit: deps.createRepoGit,
                getBareCacheDir: deps.getSharedRepoDir,
                githubAuthManager: deps.githubAuthManager,
                repoStore: deps.repoStore,
              },
              sessionId,
              deps.defaultAgentId,
            ),
          },
          request.params.id,
          {
            text: body.text ?? "",
            ...(body.agentInterface !== undefined ? { agentInterface: body.agentInterface } : {}),
            ...(body.activity !== undefined ? { activity: body.activity } : {}),
            ...(body.permissionMode !== undefined ? { permissionMode: body.permissionMode } : {}),
            ...(body.images !== undefined ? { images: body.images } : {}),
            ...(body.files !== undefined ? { files: body.files } : {}),
            ...(body.uploads !== undefined ? { uploads: body.uploads } : {}),
          },
        );
        reply.send(result);
      } catch (err) {
        if (err instanceof AgentTurnAdmissionError) {
          reply.code(err.statusCode).send({ error: err.message, code: err.code, sessionId: err.sessionId });
          return;
        }
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
  //
  // docs/261 reqs 6 + 7 — the body carries the spawn TARGET: either `role`, or
  // all five explicit fields. `parseSubAgentSpawnTarget` is the authority on
  // which (the shim's own check only buys a better message), and it refuses an
  // incomplete explicit call rather than completing it. The four model fields
  // are new here: until this phase the route declared `{agentId, prompt, depth}`
  // only, so the shim's `--model` was parsed and then silently dropped.
  app.post<{
    Params: { id: string };
    Body: {
      prompt?: string;
      depth?: number;
      role?: string;
      agentId?: AgentId;
      serviceId?: string;
      billingMode?: string;
      modelId?: string;
      reasoningEffort?: string;
    };
  }>(
    "/api/sessions/:id/agent/spawn",
    { config: { containerAccessible: true } },
    async (request, reply) => {
      try {
        const body = request.body ?? {};
        const target = parseSubAgentSpawnTarget(body);
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
            // planning#301 — lets the service commit work a backgrounded consult left
            // behind once its parent turn has already ended.
            createGitManager: deps.createGitManager,
          },
          request.params.id,
          {
            target,
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

  // GET /api/sessions/:id/agent/roles — docs/264 req 12, the first of the two
  // reads: the roles this install has, so the agent can map an intent onto one
  // (req 3), tell the user what exists, and name one it knows is there rather
  // than guessing at a name the refusal would then have to correct.
  //
  // Session-scoped like every other agent-ops route (the worker injects the
  // trusted SESSION_ID), though the answer is global: roles are a ShipIt-wide
  // setting. The scoping is the container-access contract, not a filter.
  app.get<{ Params: { id: string } }>(
    "/api/sessions/:id/agent/roles",
    { config: { containerAccessible: true } },
    async (request, reply) => {
      const session = deps.sessionManager.get(request.params.id);
      if (!session) {
        reply.code(404).send({ error: "Session not found" });
        return;
      }
      reply.send({
        roles: listRolesForAgent({
          credentialStore: deps.credentialStore,
          ...(deps.providerAccountManager ? { providerAccountManager: deps.providerAccountManager } : {}),
        }),
      });
    },
  );

  // GET /api/sessions/:id/agent/params — docs/264 req 12's second read: the
  // parameters an override may name (req 10), for THIS install — the harnesses
  // it installed, each one's reasoning levels, and the models it holds a
  // credential for.
  //
  // The two ship together deliberately: an agent allowed to override a parameter
  // but unable to see which parameters exist would fill the gap from memory, and
  // a remembered model is indistinguishable from a supplied one by the time it
  // reaches ShipIt.
  app.get<{ Params: { id: string } }>(
    "/api/sessions/:id/agent/params",
    { config: { containerAccessible: true } },
    async (request, reply) => {
      const session = deps.sessionManager.get(request.params.id);
      if (!session) {
        reply.code(404).send({ error: "Session not found" });
        return;
      }
      reply.send(listSpawnParameters(deps.agentRegistry));
    },
  );

  // GET /api/sessions/:id/agent/result?spawnId=…[&wait=true&timeout=N&segment=S]
  //
  // planning#247. Re-read a completed spawn's persisted consult card (the artifact
  // the UI renders) so the invoking agent can verify parity, or recover output
  // whose delivery was lost when its `shipit agent run` was killed mid-flight.
  // Reached via the worker's `/agent-ops/agent/result` broker, which injects the
  // trusted SESSION_ID. No spawnId ⇒ the session's most recent run.
  //
  // docs/248 — with `wait=true` the call resolves when the run reaches a
  // terminal status. `segment` (seconds) bounds a single server poll: still
  // pending when it elapses ⇒ 200 with `outcome: "pending"` ("poll again")
  // rather than a held socket, so the shim owns the overall deadline and a
  // reset costs one segment. Same contract as the child-session wait.
  app.get<{
    Params: { id: string };
    Querystring: { spawnId?: string; wait?: string; timeout?: string; segment?: string };
  }>(
    "/api/sessions/:id/agent/result",
    { config: { containerAccessible: true } },
    async (request, reply) => {
      try {
        const spawnId = request.query.spawnId?.trim();
        if (request.query.wait === "true") {
          const requestedTimeoutSecs = Number(request.query.timeout);
          const timeoutMs = Number.isFinite(requestedTimeoutSecs) && requestedTimeoutSecs > 0
            ? Math.min(Math.floor(requestedTimeoutSecs * 1000), MAX_SUB_AGENT_WAIT_MS)
            : DEFAULT_SUB_AGENT_WAIT_MS;
          const requestedSegmentSecs = Number(request.query.segment);
          // A caller may not ask for a segment longer than the time it is
          // willing to wait overall.
          const segmentMs = Number.isFinite(requestedSegmentSecs) && requestedSegmentSecs > 0
            ? Math.min(Math.floor(requestedSegmentSecs * 1000), timeoutMs)
            : timeoutMs;
          const result = await waitForSubAgentResult(
            { chatHistoryManager: deps.chatHistoryManager },
            request.params.id,
            { ...(spawnId ? { spawnId } : {}), segmentMs },
          );
          reply.send({ ...result.card, outcome: result.outcome });
          return;
        }
        const card = getSubAgentResult(
          { chatHistoryManager: deps.chatHistoryManager },
          request.params.id,
          spawnId || undefined,
        );
        reply.send(card);
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Sub-agent result lookup failed: ${getErrorMessage(err)}` });
      }
    },
  );
}
