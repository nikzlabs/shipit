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
import { routeVoiceNote, sanitizeVoiceContext } from "./voice/voice-note-router.js";

export async function registerVoiceRoutes(app: FastifyInstance, deps: ApiDeps): Promise<void> {
  const { credentialStore, authManager } = deps;
  const cacheDir = path.join(deps.stateDir ?? deps.workspaceDir, ".voice-cache");
  const ttsCache = new TtsCache(cacheDir);

  const cleanupCredentialRoot = (): string | undefined => {
    try {
      const route = deps.providerAccountManager?.selectRouteForTurn("anthropic");
      if (route?.kind !== "account") return undefined;
      return deps.providerAccountManager?.resolveCredentialRoot("claude", route.id);
    } catch {
      return undefined;
    }
  };

  function handleError(reply: FastifyReply, err: unknown, genericMsg: string): void {
    if (err instanceof ServiceError) {
      reply.code(err.statusCode).send({ error: err.message });
      return;
    }
    reply.code(500).send({ error: `${genericMsg}: ${getErrorMessage(err)}` });
  }

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
    return getCleanupStatus(credentialStore, authManager, fetch, cleanupCredentialRoot());
  });

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
      }, fetch, cleanupCredentialRoot());
    } catch (err) {
      handleError(reply, err, "Failed to transcribe");
    }
  });

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
      // The browser cannot read the token; a blank field preserves the stored value.
      const storedToken = credentialStore.getVoiceWebhook()?.token ?? "";
      credentialStore.setVoiceWebhook(url, token || storedToken);
      return { ok: true };
    },
  );

  app.delete("/api/voice/webhook", async () => {
    credentialStore.clearVoiceWebhook();
    return { ok: true };
  });

  app.get("/api/voice/webhook/status", async () => {
    const wh = credentialStore.getVoiceWebhook();
    return { configured: !!wh, url: wh?.url ?? null };
  });

  app.post<{
    Params: { sessionId: string };
    Body: { summary?: string; context?: unknown };
  }>(
    "/api/sessions/:sessionId/voice-note",
    { config: { containerAccessible: true } },
    async (request, reply) => {
      const { sessionId } = request.params;
      const summary = typeof request.body?.summary === "string" ? request.body.summary.trim() : "";
      if (!summary) {
        reply.code(400).send({ error: "summary is required" });
        return;
      }

      const runner = deps.runnerRegistry.get(sessionId);
      if (!runner) return { delivered: false };

      const context = sanitizeVoiceContext(request.body?.context);
      const result = await routeVoiceNote(
        {
          summary,
          ...(context ? { context } : {}),
        },
        {
          runner,
          sessionId,
          credentialStore,
          chatHistoryManager: deps.chatHistoryManager,
          source: "authored",
          authoredPath: "bridge",
        },
      );
      return { delivered: result.native || result.webhook || result.duplicate };
    },
  );
}
