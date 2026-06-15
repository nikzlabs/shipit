/**
 * propose-actions API route (docs/207 / SHI-153 — action checklist cards).
 *
 * Surface:
 *   POST /api/sessions/:sessionId/propose-actions   { title?, actions: [...] }
 *
 * The agent's `propose_actions` tool (the `shipit` bridge → worker
 * `/agent-ops/propose-actions` → here) relays a menu of one-or-more INDEPENDENT
 * optional follow-up actions. This route validates the payload, stamps emit-time
 * provenance (branch + HEAD), and emits an `action_checklist_card` into the chat
 * for the user to resolve with a single batched submit.
 *
 * The card is an immutable, reusable message composer — it has NO lifecycle, no
 * terminal state, and nothing to patch server-side on submit (a submit is just a
 * normal user message). So unlike the bug-report card there is no follow-up WS
 * update and no `update*Card` path; the record is written once on emit.
 */

import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { ApiDeps } from "./api-routes.js";
import { resolveSessionDir } from "./api-routes.js";
import { emitChatCard } from "./chat-card-persistence.js";
import type { ActionChecklistCard, ActionChecklistItem } from "../shared/types.js";

/** Validation bounds — mirrored by the tool's fail-fast pre-check. */
export const MAX_ACTIONS = 5;
export const MIN_ACTIONS = 1;
export const MAX_ID_LEN = 64;
export const MAX_LABEL_LEN = 120;
export const MAX_DESC_LEN = 280;
export const MAX_PAYLOAD_LEN = 4000;
export const MAX_TITLE_LEN = 120;

interface RawAction {
  id?: unknown;
  label?: unknown;
  description?: unknown;
  defaultChecked?: unknown;
  payload?: unknown;
}

export interface ValidatedActions {
  title?: string;
  actions: ActionChecklistItem[];
}

/**
 * Validate + normalize a `propose_actions` payload. Returns `{ error }` with a
 * model-readable message on any violation so both the tool's fail-fast check and
 * the authoritative route reject identically. The order of `actions` is
 * preserved exactly (deterministic render order).
 */
export function validateProposeActions(body: {
  title?: unknown;
  actions?: unknown;
}): ValidatedActions | { error: string } {
  const rawActions = body.actions;
  if (!Array.isArray(rawActions) || rawActions.length < MIN_ACTIONS) {
    return { error: `\`actions\` must be a non-empty array (${MIN_ACTIONS}–${MAX_ACTIONS} items).` };
  }
  if (rawActions.length > MAX_ACTIONS) {
    return { error: `Too many actions (${rawActions.length}); cap is ${MAX_ACTIONS}. Propose the most relevant follow-ups only.` };
  }

  const seenIds = new Set<string>();
  const actions: ActionChecklistItem[] = [];
  for (let i = 0; i < rawActions.length; i++) {
    const a = rawActions[i] as RawAction;
    if (typeof a !== "object" || a === null) {
      return { error: `actions[${i}] must be an object with { id, label, payload }.` };
    }
    const id = typeof a.id === "string" ? a.id.trim() : "";
    const label = typeof a.label === "string" ? a.label.trim() : "";
    const payload = typeof a.payload === "string" ? a.payload.trim() : "";
    if (!id) return { error: `actions[${i}].id is required and must be a non-empty string.` };
    if (id.length > MAX_ID_LEN) return { error: `actions[${i}].id exceeds ${MAX_ID_LEN} chars.` };
    if (seenIds.has(id)) return { error: `Duplicate action id "${id}" — ids must be unique within a card.` };
    seenIds.add(id);
    if (!label) return { error: `actions[${i}].label is required and must be a non-empty string.` };
    if (label.length > MAX_LABEL_LEN) return { error: `actions[${i}].label exceeds ${MAX_LABEL_LEN} chars.` };
    if (!payload) return { error: `actions[${i}].payload is required and must be a non-empty string.` };
    if (payload.length > MAX_PAYLOAD_LEN) return { error: `actions[${i}].payload exceeds ${MAX_PAYLOAD_LEN} chars.` };
    const description = typeof a.description === "string" ? a.description.trim() : "";
    if (description.length > MAX_DESC_LEN) return { error: `actions[${i}].description exceeds ${MAX_DESC_LEN} chars.` };

    const item: ActionChecklistItem = { id, label, payload };
    if (description) item.description = description;
    if (a.defaultChecked === true) item.defaultChecked = true;
    actions.push(item);
  }

  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (title.length > MAX_TITLE_LEN) return { error: `\`title\` exceeds ${MAX_TITLE_LEN} chars.` };

  return { ...(title ? { title } : {}), actions };
}

export async function registerProposeActionsRoutes(
  app: FastifyInstance,
  deps: ApiDeps,
): Promise<void> {
  app.post<{
    Params: { sessionId: string };
    Body: { title?: unknown; actions?: unknown };
  }>(
    "/api/sessions/:sessionId/propose-actions",
    { config: { containerAccessible: true } },
    async (request, reply: FastifyReply) => {
      const { sessionId } = request.params;

      const validated = validateProposeActions(request.body ?? {});
      if ("error" in validated) {
        reply.code(400).send({ error: validated.error });
        return;
      }

      // Confirm the session exists (and resolves to a real dir) before doing work.
      const sessionDir = resolveSessionDir(deps.sessionManager, sessionId, reply);
      if (!sessionDir) return;

      const runner = deps.runnerRegistry.get(sessionId);
      if (!runner) {
        // No active runner means there's nowhere to render the card.
        reply.code(409).send({ error: "Session is not active — open it to propose actions." });
        return;
      }

      // Stamp emit-time provenance so the submitted message can tell the agent
      // what the actions were proposed against. Failures here are non-fatal: the
      // card still works as a message composer without branch/HEAD.
      let branch: string | undefined;
      let headSha: string | undefined;
      try {
        const git = deps.createGitManager(sessionDir);
        branch = (await git.getCurrentBranch()) || undefined;
        const head = await git.getHeadHash();
        headSha = head ? head.slice(0, 8) : undefined;
      } catch {
        // No git / detached / fresh repo — provenance is best-effort.
      }

      const card: ActionChecklistCard = {
        cardId: `action-card-${randomUUID()}`,
        ...(validated.title ? { title: validated.title } : {}),
        actions: validated.actions,
        ...(branch ? { branch } : {}),
        ...(headSha ? { headSha } : {}),
        createdAt: new Date().toISOString(),
      };

      // Persist the card in-band with the proposing turn so it survives a session
      // switch / full reload, not just a WS reconnect. `emitChatCard` emits the
      // live card AND records it (anchored where the tool fired, not floating
      // above the whole turn) AND persists the in-progress turn immediately — the
      // single primitive that makes a transcript card impossible to ship
      // emit-only. The card has no lifecycle, so it is never patched after this.
      emitChatCard(
        runner,
        { type: "action_checklist_card", sessionId, card },
        { role: "assistant", text: "", actionChecklist: card },
        { chatHistoryManager: deps.chatHistoryManager, sessionId },
      );

      return { ok: true, cardId: card.cardId, count: card.actions.length };
    },
  );
}
