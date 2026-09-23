import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { ApiDeps } from "./api-routes.js";
import { emitChatCard, persistCardTransition } from "./chat-card-persistence.js";
import type { SessionInfo, SessionMessageProposalCard } from "../shared/types.js";
import { validateSessionMessageProposal } from "../shared/session-message-proposal-validation.js";
import { deliverSessionMessage, ServiceError } from "./services/index.js";
import { getErrorMessage } from "./validation.js";
import type { SessionRunnerInterface } from "./session-runner.js";
import type { SessionManager } from "./sessions.js";

/**
 * docs/314 — the agent proposes a message for a session it cannot address; the
 * user's click is what delivers it.
 *
 * The two routes here are deliberately asymmetric. The propose route is
 * `containerAccessible` and writes nothing but a card. The deliver route is NOT
 * container-accessible, so the only way a message reaches a session that is not
 * the caller's direct child is a human clicking (req 7). Nothing in this file
 * relaxes `assertChildOfParent`.
 */

/** Refuse at CALL time, so a bad address fails back to the agent (req 8). */
function resolveTarget(
  sessionManager: SessionManager,
  isRepoTrusted: (remoteUrl: string) => boolean,
  proposingSessionId: string,
  targetSessionId: string,
): { session: SessionInfo } | { error: string; code: number } {
  const target = sessionManager.get(targetSessionId);
  if (!target) {
    return {
      code: 404,
      error:
        `No session on this host has the id ${targetSessionId}. `
        + "The id has to come from the prompt you were given; check it there.",
    };
  }
  if (targetSessionId === proposingSessionId) {
    return {
      code: 400,
      error:
        "That is this session. A message to yourself is your own next turn, not a proposal.",
    };
  }
  if (target.parentSessionId === proposingSessionId) {
    return {
      code: 400,
      error:
        `${target.title} is a session you spawned, so you can already reach it directly: `
        + `run \`shipit session message ${targetSessionId} -m "…"\`. `
        + "A proposal card is for a session you cannot address.",
    };
  }
  // The parent channel already wakes this target without a card (req 9), so a
  // proposal here would add approval friction to a delivery that needs none.
  const proposer = sessionManager.get(proposingSessionId);
  if (proposer?.parentSessionId === targetSessionId) {
    return {
      code: 400,
      error:
        `${target.title} is the session that spawned you, so you can already reach it directly: `
        + "run `shipit session report --body-file -`. "
        + "A proposal card is for a session you cannot address.",
    };
  }
  // A pooled empty session is not work the user is following; a turn dispatched
  // into one would claim it for a conversation they never started.
  if (target.warm) {
    return {
      code: 400,
      error: "That id belongs to an unused session from ShipIt's warm pool, not to work in progress.",
    };
  }
  if (target.archived || target.userArchived) {
    return {
      code: 400,
      error: `${target.title} is archived and cannot take a turn, so there is nothing to approve.`,
    };
  }
  if (!target.workspaceDir) {
    return {
      code: 400,
      error: `${target.title} has no workspace and cannot take a turn, so there is nothing to approve.`,
    };
  }
  // The same admission `dispatch` applies (`assertSessionCanDispatch`). Without
  // it the card is approvable and the delivery is not, which is what req 8 exists
  // to prevent.
  if (target.kind !== "ops" && target.kind !== "sandbox"
    && target.remoteUrl && !isRepoTrusted(target.remoteUrl)) {
    return {
      code: 403,
      error:
        `${target.title} is on a repository the user has not trusted, so no turn can start there. `
        + "Tell the user to trust it in ShipIt before this message can be delivered.",
    };
  }
  return { session: target };
}

export async function registerProposeSessionMessageRoutes(
  app: FastifyInstance,
  deps: ApiDeps,
): Promise<void> {
  app.post<{
    Params: { sessionId: string };
    Body: { sessionId?: unknown; message?: unknown };
  }>(
    "/api/sessions/:sessionId/propose-session-message",
    { config: { containerAccessible: true } },
    async (request, reply: FastifyReply) => {
      const { sessionId } = request.params;

      const validated = validateSessionMessageProposal(request.body ?? {});
      if ("error" in validated) {
        reply.code(400).send({ error: validated.error });
        return;
      }

      if (!deps.sessionManager.get(sessionId)) {
        reply.code(404).send({ error: "Session not found" });
        return;
      }

      const resolved = resolveTarget(
        deps.sessionManager,
        (url) => deps.repoStore.isTrusted(url),
        sessionId,
        validated.sessionId,
      );
      if ("error" in resolved) {
        reply.code(resolved.code).send({ error: resolved.error });
        return;
      }

      const runner = deps.runnerRegistry.get(sessionId);
      if (!runner) {
        reply.code(409).send({ error: "Session is not active — open it to propose a message." });
        return;
      }

      const card: SessionMessageProposalCard = {
        cardId: `session-message-${randomUUID()}`,
        targetSessionId: resolved.session.id,
        targetTitle: resolved.session.title,
        message: validated.message,
        createdAt: new Date().toISOString(),
      };

      emitChatCard(
        runner,
        { type: "session_message_proposal_card", sessionId, card },
        { role: "assistant", text: "", sessionMessageProposal: card },
        { chatHistoryManager: deps.chatHistoryManager, sessionId },
      );

      return { ok: true, cardId: card.cardId, targetTitle: card.targetTitle };
    },
  );

  /**
   * Two fast clicks would both read a non-terminal card and dispatch twice, so
   * the claim is synchronous and process-lived. A persisted `delivering` alone
   * cannot serve: it is deliberately retryable, because an orchestrator that
   * stopped mid-delivery leaves one behind and the card must not spin forever.
   */
  const deliveriesInFlight = new Set<string>();

  // The user's click. Not container-accessible: the agent proposes, the user delivers.
  app.post<{ Params: { sessionId: string; cardId: string } }>(
    "/api/sessions/:sessionId/session-message-proposals/:cardId/deliver",
    async (request, reply: FastifyReply) => {
      const { sessionId, cardId } = request.params;

      if (deliveriesInFlight.has(cardId)) {
        reply.code(409).send({ error: "That message is already being delivered." });
        return;
      }

      const card = deps.chatHistoryManager.findSessionMessageProposalCard(sessionId, cardId);
      if (!card) {
        reply.code(404).send({ error: "That proposal is no longer in this session's history." });
        return;
      }
      // Delivery is once (req 5): a second click would start a second turn.
      if (card.state === "delivered") {
        reply.code(409).send({ error: "That message was already delivered." });
        return;
      }

      const runner = deps.runnerRegistry.get(sessionId);

      const patch = (fields: Partial<SessionMessageProposalCard>): void => {
        if (runner) {
          runner.emitMessage({
            type: "session_message_proposal_update",
            sessionId,
            cardId,
            state: fields.state ?? "delivering",
            ...(fields.deliveredAt ? { deliveredAt: fields.deliveredAt } : {}),
            ...(fields.queued !== undefined ? { queued: fields.queued } : {}),
            ...(fields.errorMessage ? { errorMessage: fields.errorMessage } : {}),
          });
        }
        persistSessionMessageProposalTransition(deps, runner, sessionId, cardId, fields);
      };

      deliveriesInFlight.add(cardId);
      // Dispatch is the point of no return: once it has happened the message is
      // in the target, so a later throw must never mark the card retryable.
      let dispatched = false;
      try {
        patch({ state: "delivering", errorMessage: undefined });

        // Re-resolved: the target may have been archived since the card was written.
        const resolved = resolveTarget(
          deps.sessionManager,
          (url) => deps.repoStore.isTrusted(url),
          sessionId,
          card.targetSessionId,
        );
        if ("error" in resolved) {
          throw new ServiceError(resolved.code, resolved.error);
        }

        const proposer = deps.sessionManager.get(sessionId);
        const result = await deliverSessionMessage(
          deps.sessionManager,
          deps.runnerRegistry,
          resolved.session,
          card.message,
          {
            sessionId,
            sessionTitle: proposer?.title ?? "Another session",
            relation: "proposed",
          },
          deps.defaultAgentId,
          deps.credentialsDir,
          deps.credentialStore,
          deps.providerAccountManager,
          deps.containerManager,
        );
        dispatched = true;

        // The dispatch's own admission, not a guess from the runner's state: a
        // steered message reaches a RUNNING target immediately, and an idle one
        // under a merge hold is queued.
        const queued = result.admitted === "queued";
        const deliveredAt = new Date().toISOString();
        patch({ state: "delivered", deliveredAt, queued });
        return { ok: true, deliveredAt, queued, queuePosition: result.queuePosition };
      } catch (err) {
        const message = err instanceof ServiceError
          ? err.message
          : `Could not deliver the message to ${card.targetTitle}: ${getErrorMessage(err)}`;
        if (dispatched) {
          // The message landed and only the acknowledgement failed. Marking this
          // failed would offer a Try again that delivers it a second time.
          console.error(
            `[session-message-proposal] ${cardId} was delivered but could not be acknowledged:`,
            err,
          );
          reply.code(500).send({ error: message, delivered: true });
          return;
        }
        patch({ state: "failed", errorMessage: message });
        const statusCode = err instanceof ServiceError
          ? err.statusCode
          : typeof (err as { statusCode?: unknown }).statusCode === "number"
            ? (err as { statusCode: number }).statusCode
            : 500;
        reply.code(statusCode).send({ error: message });
        return;
      } finally {
        deliveriesInFlight.delete(cardId);
      }
    },
  );
}

function persistSessionMessageProposalTransition(
  deps: ApiDeps,
  runner: SessionRunnerInterface | undefined,
  sessionId: string,
  cardId: string,
  patch: Partial<SessionMessageProposalCard>,
): void {
  const write = () => deps.chatHistoryManager.updateSessionMessageProposalCard(sessionId, cardId, patch);
  if (!runner) {
    write();
    return;
  }
  persistCardTransition(
    runner,
    { chatHistoryManager: deps.chatHistoryManager, sessionId },
    (m) => m.sessionMessageProposal?.cardId === cardId,
    (m) => ({ ...m, sessionMessageProposal: { ...m.sessionMessageProposal!, ...patch } }),
    write,
  );
}
