/**
 * Fetch endpoints for the bodies the docs/244 projection strips from the
 * transcript payload (SHI-267). Each one is hit when the user opens the view
 * that actually shows the body — "Show all N lines", the diff modal, or an
 * image — so the transcript itself never carries them.
 *
 * These read `ChatHistoryManager.load()` directly rather than the projected
 * `getChatHistory`, because the whole point is to return what the projection
 * removed.
 *
 * A 404 here is not a state the UI designs around. A chat rewind deletes the
 * rows (`ChatHistoryManager.truncate`) and the client drops the same rows from
 * the transcript in the same handler, so the affordance disappears with the
 * row; a code rewind only sets `rolled_back = 1` and deletes nothing. A visible
 * row therefore always has a fetchable body, and a miss is an ordinary error.
 */

import type { FastifyInstance } from "fastify";
import type { ApiDeps } from "./api-routes.js";
import type { PersistedMessage } from "./chat-history.js";
import { imageHash } from "./transcript-projection.js";
import type { ToolResultEntry } from "./session-runner.js";

/** Every tool result in a message, including those nested under a subagent. */
function* allToolResults(msg: PersistedMessage): Generator<ToolResultEntry> {
  for (const r of msg.toolResults ?? []) yield r;
  for (const ev of msg.subagentEvents ?? []) {
    if (ev.kind === "tool_result") for (const r of ev.toolResults) yield r;
  }
}

/** Every tool_use block in a message, including those nested under a subagent. */
function* allToolUses(msg: PersistedMessage): Generator<{ id: string; name: string; input: Record<string, unknown> }> {
  for (const t of msg.toolUse ?? []) yield t;
  for (const ev of msg.subagentEvents ?? []) {
    if (ev.kind === "assistant") for (const t of ev.toolUse ?? []) yield t;
  }
}

/**
 * Every base64 image in a message — user-attached rows and the image blocks
 * inside MCP tool results (Playwright screenshots), which are stored as a JSON
 * array of content blocks.
 */
function* allImages(msg: PersistedMessage): Generator<{ data: string; mediaType: string }> {
  for (const img of msg.images ?? []) {
    if (img.data) yield { data: img.data, mediaType: img.mediaType };
  }
  for (const r of allToolResults(msg)) {
    // Cheap pre-filter, and it must match what the PROJECTION treats as an
    // image — which is any block with `source.data`, regardless of whether
    // `source.type` says "base64". Filtering on the literal text "base64" (the
    // previous guard) skipped exactly the shapes that omit that field, so the
    // projection would hand the client an `/images/:hash` URL that this lookup
    // then permanently 404'd. Keyed on the block type instead, which
    // `JSON.stringify` always emits for an image block.
    if (!r.content.startsWith("[") || !r.content.includes("\"image\"")) continue;
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

  // GET /api/sessions/:id/tool-results/:toolUseId — the full result body.
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
            reply.send({ content: r.content, isError: r.isError ?? false });
            return;
          }
        }
      }
      reply.code(404).send({ error: "Tool result not found" });
    },
  );

  // GET /api/sessions/:id/tool-inputs/:toolUseId — the stripped Edit/Write body.
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
            reply.send({
              content: (t.input.content as string) ?? undefined,
              oldString: (t.input.old_string as string) ?? undefined,
              newString: (t.input.new_string as string) ?? undefined,
            });
            return;
          }
        }
      }
      reply.code(404).send({ error: "Tool input not found" });
    },
  );

  // GET /api/sessions/:id/images/:hash — the image at its stored resolution.
  //
  // Content-addressed, so the response is immutable by construction: the hash
  // IS the content. That is what makes the scan below affordable — each
  // distinct image is fetched at most once per browser, and a screenshot that
  // appears in twenty rows is one request, not twenty.
  app.get<{ Params: { id: string; hash: string } }>(
    "/api/sessions/:id/images/:hash",
    async (request, reply) => {
      const messages = messagesFor(request.params.id);
      if (!messages) {
        reply.code(404).send({ error: "Session not found" });
        return;
      }
      // The 304 short-circuit must come AFTER proving the hash resolves —
      // matching on the request's own ETag alone would answer "not modified"
      // for an image that does not exist, turning a 404 into a hit.
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
