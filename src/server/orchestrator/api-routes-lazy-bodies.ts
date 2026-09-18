import type { FastifyInstance } from "fastify";
import type { ApiDeps } from "./api-routes.js";
import type { PersistedMessage } from "./chat-history.js";
import type { SubAgentConsultCard } from "../shared/types.js";
import { imageHash, substituteResultImages } from "./transcript-projection.js";
import type { ToolResultEntry } from "./session-runner.js";

function* allToolResults(msg: PersistedMessage): Generator<ToolResultEntry> {
  for (const r of msg.toolResults ?? []) yield r;
  for (const ev of msg.subagentEvents ?? []) {
    if (ev.kind === "tool_result") for (const r of ev.toolResults) yield r;
  }
}

function* allToolUses(msg: PersistedMessage): Generator<{ id: string; name: string; input: Record<string, unknown> }> {
  for (const t of msg.toolUse ?? []) yield t;
  for (const ev of msg.subagentEvents ?? []) {
    if (ev.kind === "assistant") for (const t of ev.toolUse ?? []) yield t;
  }
}

function* allImages(msg: PersistedMessage): Generator<{ data: string; mediaType: string }> {
  for (const img of msg.images ?? []) {
    if (img.data) yield { data: img.data, mediaType: img.mediaType };
  }
  for (const r of allToolResults(msg)) {
    // Match the projection's parsed image test; text filters miss valid JSON encodings.
    if (!r.content.startsWith("[")) continue;
    let blocks: unknown;
    try {
      blocks = JSON.parse(r.content);
    } catch {
      continue;
    }
    if (!Array.isArray(blocks)) continue;
    for (const block of blocks) {
      if (typeof block !== "object" || block === null) continue;
      const b = block as Record<string, unknown>;
      if (b.type !== "image") continue;
      const source = b.source as Record<string, unknown> | undefined;
      if (source && typeof source.data === "string" && source.data) {
        yield { data: source.data, mediaType: (source.media_type as string) ?? "image/png" };
      }
    }
  }
}

export function registerLazyBodyRoutes(app: FastifyInstance, deps: ApiDeps): void {
  const messagesFor = (sessionId: string): PersistedMessage[] | null => {
    if (!deps.sessionManager.get(sessionId)) return null;
    return deps.chatHistoryManager.load(sessionId);
  };

  app.get<{ Params: { id: string; toolUseId: string } }>(
    "/api/sessions/:id/tool-results/:toolUseId",
    async (request, reply) => {
      const messages = messagesFor(request.params.id);
      if (!messages) {
        reply.code(404).send({ error: "Session not found" });
        return;
      }
      for (const msg of messages) {
        for (const r of allToolResults(msg)) {
          if (r.toolUseId === request.params.toolUseId) {
            reply.send({
              content: substituteResultImages(request.params.id, r.content),
              isError: r.isError ?? false,
            });
            return;
          }
        }
      }
      reply.code(404).send({ error: "Tool result not found" });
    },
  );

  app.get<{ Params: { id: string; toolUseId: string } }>(
    "/api/sessions/:id/tool-inputs/:toolUseId",
    async (request, reply) => {
      const messages = messagesFor(request.params.id);
      if (!messages) {
        reply.code(404).send({ error: "Session not found" });
        return;
      }
      for (const msg of messages) {
        for (const t of allToolUses(msg)) {
          if (t.id === request.params.toolUseId) {
            reply.send({ input: t.input });
            return;
          }
        }
      }
      reply.code(404).send({ error: "Tool input not found" });
    },
  );

  app.get<{ Params: { id: string; cardId: string } }>(
    "/api/sessions/:id/sub-agent-consults/:cardId",
    async (request, reply) => {
      if (!deps.sessionManager.get(request.params.id)) {
        reply.code(404).send({ error: "Session not found" });
        return;
      }
      // Older sessions can hold duplicate cards; prefer a completed copy.
      const copies = deps.chatHistoryManager
        .listSubAgentConsultCards(request.params.id)
        .filter((c: SubAgentConsultCard) => c.cardId === request.params.cardId);
      let card = copies[0];
      for (const copy of copies) if (copy.status !== "pending") card = copy;
      if (!card) {
        reply.code(404).send({ error: "Sub-agent consult not found" });
        return;
      }
      reply.send({ outputMarkdown: card.outputMarkdown ?? "" });
    },
  );

  app.get<{ Params: { id: string; hash: string } }>(
    "/api/sessions/:id/images/:hash",
    async (request, reply) => {
      const messages = messagesFor(request.params.id);
      if (!messages) {
        reply.code(404).send({ error: "Session not found" });
        return;
      }
      // Verify the image exists before returning 304 for its ETag.
      const revalidating = request.headers["if-none-match"] === `"${request.params.hash}"`;
      for (const msg of messages) {
        for (const img of allImages(msg)) {
          if (imageHash(img.data) !== request.params.hash) continue;
          if (revalidating) {
            reply.code(304).send();
            return;
          }
          reply
            .header("Content-Type", img.mediaType)
            .header("Cache-Control", "public, max-age=31536000, immutable")
            .header("ETag", `"${request.params.hash}"`)
            .send(Buffer.from(img.data, "base64"));
          return;
        }
      }
      reply.code(404).send({ error: "Image not found" });
    },
  );
}
