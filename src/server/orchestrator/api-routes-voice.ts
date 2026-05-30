/**
 * Voice API routes (docs/144).
 *
 * Surface:
 *   POST   /api/voice/credentials         set the OpenAI voice key (server-only)
 *   DELETE /api/voice/credentials         clear it
 *   GET    /api/voice/credentials/status  { configured, provider? } — never the key
 *   GET    /api/voice/cleanup/status      { provider } — which cleanup path runs
 *   POST   /api/voice/transcribe          multipart audio → { text, rawText, ... }
 *   POST   /api/voice/speak               { text, voice, speed } → audio/mpeg | 204
 *
 * The key lives only on the server; audio flows browser→orchestrator→OpenAI in
 * both directions so the browser never opens an authenticated OpenAI
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
        return setVoiceKey(credentialStore, request.body?.apiKey ?? "");
      } catch (err) {
        handleError(reply, err, "Failed to set voice key");
      }
    },
  );

  app.delete("/api/voice/credentials", async (_request, reply) => {
    try {
      return clearVoiceKey(credentialStore);
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
      });
    } catch (err) {
      handleError(reply, err, "Failed to transcribe");
    }
  });

  // ---- Speech (TTS) ----

  app.post<{ Body: { text?: string; voice?: string; speed?: number } }>(
    "/api/voice/speak",
    async (request, reply) => {
      const text = request.body?.text ?? "";
      const voice = request.body?.voice ?? "alloy";
      const speed = typeof request.body?.speed === "number" ? request.body.speed : 1;
      if (!text.trim()) {
        reply.code(400).send({ error: "text is required" });
        return;
      }
      try {
        const result = await speakVoice(credentialStore, ttsCache, { text, voice, speed });
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
}
