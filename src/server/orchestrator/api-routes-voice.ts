/**
 * Voice API routes (docs/144).
 *
 * Surface:
 *   POST   /api/voice/credentials         { provider, apiKey } set a key (server-only)
 *   DELETE /api/voice/credentials         { provider } clear it
 *   GET    /api/voice/credentials/status  { configured: string[] } — never the key
 *   GET    /api/voice/cleanup/status      { provider } — which cleanup path runs
 *   POST   /api/voice/transcribe          multipart audio (+ sttProvider) → { text, rawText, ... }
 *   POST   /api/voice/speak               { text, voice, speed, provider } → audio | 204
 *
 * Keys live only on the server; audio flows browser→orchestrator→provider in
 * both directions so the browser never opens an authenticated provider
 * connection (plan threat model).
 */

import path from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { ApiDeps } from "./api-routes.js";
import { getErrorMessage } from "./validation.js";
import { ServiceError } from "./services/index.js";
import {
  setVoiceKey,
  clearVoiceKey,
  getVoiceCredentialStatus,
  getCleanupStatus,
  transcribeVoice,
  speakVoice,
} from "./services/voice.js";
import { TtsCache } from "./voice/index.js";

export async function registerVoiceRoutes(app: FastifyInstance, deps: ApiDeps): Promise<void> {
  const { credentialStore, authManager } = deps;
  const cacheDir = path.join(deps.stateDir ?? deps.workspaceDir, ".voice-cache");
  const ttsCache = new TtsCache(cacheDir);

  function handleError(reply: FastifyReply, err: unknown, genericMsg: string): void {
    if (err instanceof ServiceError) {
      reply.code(err.statusCode).send({ error: err.message });
      return;
    }
    reply.code(500).send({ error: `${genericMsg}: ${getErrorMessage(err)}` });
  }

  // ---- Credentials ----

  app.post<{ Body: { provider?: string; apiKey?: string } }>(
    "/api/voice/credentials",
    async (request, reply) => {
      try {
        return setVoiceKey(credentialStore, request.body?.provider ?? "openai", request.body?.apiKey ?? "");
      } catch (err) {
        handleError(reply, err, "Failed to set voice key");
      }
    },
  );

  app.delete<{ Body: { provider?: string } }>("/api/voice/credentials", async (request, reply) => {
    try {
      return clearVoiceKey(credentialStore, request.body?.provider ?? "openai");
    } catch (err) {
      handleError(reply, err, "Failed to clear voice key");
    }
  });

  app.get("/api/voice/credentials/status", async () => {
    return getVoiceCredentialStatus(credentialStore);
  });

  app.get("/api/voice/cleanup/status", async () => {
    return getCleanupStatus(credentialStore, authManager);
  });

  // ---- Transcription (STT + cleanup) ----

  app.post("/api/voice/transcribe", async (request, reply) => {
    let audio: Buffer | null = null;
    let mimeType: string | undefined;
    let language: string | undefined;
    let sttProvider: string | undefined;
    let cleanup = true;

    try {
      if (request.isMultipart()) {
        for await (const part of request.parts()) {
          if (part.type === "file") {
            audio = await part.toBuffer();
            mimeType = part.mimetype;
            continue;
          }
          const value = typeof part.value === "string" ? part.value : "";
          if (part.fieldname === "language") language = value;
          else if (part.fieldname === "sttProvider") sttProvider = value;
          else if (part.fieldname === "cleanup") cleanup = value !== "false";
        }
      } else {
        reply.code(400).send({ error: "Expected multipart/form-data with an audio file" });
        return;
      }
    } catch (err) {
      reply.code(400).send({ error: `Invalid multipart body: ${getErrorMessage(err)}` });
      return;
    }

    if (!audio) {
      reply.code(400).send({ error: "Missing audio file" });
      return;
    }

    try {
      return await transcribeVoice(credentialStore, authManager, {
        audio,
        cleanup,
        ...(mimeType ? { mimeType } : {}),
        ...(language ? { language } : {}),
        ...(sttProvider ? { sttProvider } : {}),
      });
    } catch (err) {
      handleError(reply, err, "Failed to transcribe");
    }
  });

  // ---- Speech (TTS) ----

  app.post<{ Body: { text?: string; voice?: string; speed?: number; provider?: string } }>(
    "/api/voice/speak",
    async (request, reply) => {
      const text = request.body?.text ?? "";
      const voice = request.body?.voice ?? "alloy";
      const speed = typeof request.body?.speed === "number" ? request.body.speed : 1;
      const provider = request.body?.provider ?? "openai";
      if (!text.trim()) {
        reply.code(400).send({ error: "text is required" });
        return;
      }
      try {
        const result = await speakVoice(credentialStore, ttsCache, { text, voice, speed, provider });
        if (!result) {
          reply.code(204).send();
          return;
        }
        reply.header("Content-Type", result.contentType);
        reply.header("Cache-Control", "no-store");
        reply.send(result.audio);
      } catch (err) {
        handleError(reply, err, "Failed to synthesize speech");
      }
    },
  );

  // ---- Voice-note delivery (docs/163) ----

  // Webhook config: URL + bearer token (server-side only, never echoed back).
  app.post<{ Body: { url?: string; token?: string } }>(
    "/api/voice/webhook",
    async (request, reply) => {
      const url = (request.body?.url ?? "").trim();
      const token = (request.body?.token ?? "").trim();
      if (!url) {
        reply.code(400).send({ error: "url is required" });
        return;
      }
      if (!/^https?:\/\//i.test(url)) {
        reply.code(400).send({ error: "url must be an http(s) URL" });
        return;
      }
      credentialStore.setVoiceWebhook(url, token);
      return { ok: true };
    },
  );

  app.delete("/api/voice/webhook", async () => {
    credentialStore.clearVoiceWebhook();
    return { ok: true };
  });

  app.get("/api/voice/webhook/status", async () => {
    const wh = credentialStore.getVoiceWebhook();
    // Never return the token; only whether it's configured and the URL host.
    return { configured: !!wh, url: wh?.url ?? null };
  });

  // Built-in voice_note tool write-back. The mcp-voice-bridge → worker
  // `/agent-ops/voice/note` relays here with the trusted session id.
  //
  // docs/163 — delivery (the native card + the webhook) is driven entirely by
  // the orchestrator's OBSERVATION of the `voice_note` tool call in the agent
  // event stream (`agent-listeners.ts`): the card is built from the tool INPUT,
  // and observation is guaranteed and on the same fast channel as the rest of
  // the turn. This relay therefore does NOT deliver — it exists only to give
  // the agent's MCP tool call a return value. We report whether an active
  // runner exists to receive the note (a torn-down turn can't); a subagent's
  // call isn't observed at the top level and so won't render — by design, a
  // subagent shouldn't be paging the user.
  app.post<{
    Params: { sessionId: string };
    Body: { summary?: string; needsAttention?: boolean; context?: unknown };
  }>(
    "/api/sessions/:sessionId/voice-note",
    async (request, reply) => {
      const { sessionId } = request.params;
      const summary = typeof request.body?.summary === "string" ? request.body.summary.trim() : "";
      if (!summary) {
        reply.code(400).send({ error: "summary is required" });
        return;
      }

      const runner = deps.runnerRegistry.get(sessionId);
      return { delivered: !!runner };
    },
  );
}
