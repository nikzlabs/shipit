import { randomUUID } from "node:crypto";
import type { SessionInfo, SessionRenamedCard, SessionTitleSource } from "../../shared/types.js";
import type { SessionManager } from "../sessions.js";
import type { SessionRunnerRegistry } from "../session-runner.js";
import { emitChatCard, type InProgressPersister } from "../chat-card-persistence.js";
import { ServiceError } from "./types.js";

export const MAX_SESSION_TITLE_LENGTH = 60;

export interface RenameSessionByAgentDeps {
  sessionManager: SessionManager;
  runnerRegistry: SessionRunnerRegistry;
  chatHistoryManager: InProgressPersister;
  sseBroadcast: (event: string, data: unknown) => void;
}

export interface RenameSessionByAgentResult {
  sessionId: string;
  previousTitle: string;
  title: string;
}

/** An undefined source is the automatic namer, not a user or agent rename. */
export function isTitleLockedAgainst(
  session: Pick<SessionInfo, "titleSource">,
  source: SessionTitleSource | undefined,
): boolean {
  if (source === "user") return false;
  if (session.titleSource === "user") return true;
  if (session.titleSource === "agent") return source !== "agent";
  return false;
}

function validateTitle(raw: string | undefined): string {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) throw new ServiceError(400, "A title is required: shipit session rename --title \"<new title>\"");
  if (trimmed.length > MAX_SESSION_TITLE_LENGTH) {
    throw new ServiceError(
      400,
      `Title is ${trimmed.length} characters; the maximum is ${MAX_SESSION_TITLE_LENGTH}. `
        + "Shorten it and try again (it is not truncated for you).",
    );
  }
  return trimmed;
}

export function renameSessionByAgent(
  deps: RenameSessionByAgentDeps,
  sessionId: string,
  rawTitle: string | undefined,
): RenameSessionByAgentResult {
  const title = validateTitle(rawTitle);

  const session = deps.sessionManager.get(sessionId);
  if (!session) throw new ServiceError(404, "Session not found");

  if (isTitleLockedAgainst(session, "agent")) {
    throw new ServiceError(
      409,
      `This session was renamed by the user ("${session.title}"), so it keeps that name. `
        + "Leave it as it is — do not try to work around this.",
    );
  }

  const previousTitle = session.title;
  if (previousTitle === title) {
    return { sessionId, previousTitle, title };
  }

  const updated = deps.sessionManager.rename(sessionId, title, "agent");
  if (!updated) throw new ServiceError(404, "Session not found");

  deps.sseBroadcast("session_renamed", { session: updated });

  const runner = deps.runnerRegistry.get(sessionId);
  if (runner) {
    const card: SessionRenamedCard = {
      cardId: `session-renamed-${randomUUID()}`,
      from: previousTitle,
      to: title,
      createdAt: new Date().toISOString(),
    };
    emitChatCard(
      runner,
      { type: "session_renamed_card", sessionId, card },
      { role: "assistant", text: "", sessionRenamed: card },
      { chatHistoryManager: deps.chatHistoryManager, sessionId },
    );
  }

  return { sessionId, previousTitle, title };
}
