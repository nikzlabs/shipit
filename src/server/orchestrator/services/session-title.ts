/**
 * docs/250 — session title provenance and the agent-driven rename.
 *
 * A session's title used to be written once, at graduation, from its first
 * message: `graduateSession` sets a placeholder and `scheduleSessionNaming`
 * replaces it with an AI-generated name derived from that same first message.
 * After that the only writer was the user's sidebar rename, so a session that
 * went on to ship three PRs kept a title describing the first one (requirement 1).
 *
 * This module owns the two things that fixes:
 *   - {@link isTitleLockedAgainst} — the ONE place precedence is expressed, so
 *     the agent path and the AI namer can't drift apart.
 *   - {@link renameSessionByAgent} — `shipit session rename`, own-session only.
 *
 * Precedence (requirements 4, 7, 8): a hand rename by the user is final; an
 * agent rename can be overwritten by the user but not by the AI namer; anything
 * automatic or born-with (the placeholder, the namer, an `explicitTitle` from
 * the seeding issue or a parent agent) is freely replaceable.
 *
 * Renaming NEVER touches the git branch (requirement 10). The AI namer renames
 * both; this path deliberately does not, because by the time the agent wants to
 * rename there is usually a PR open on that branch and moving it underneath
 * would strand the PR. There is no path from here to `setBranch`/`renameBranch`,
 * and a test asserts the git manager is never even constructed.
 */

import { randomUUID } from "node:crypto";
import type { SessionInfo, SessionRenamedCard, SessionTitleSource } from "../../shared/types.js";
import type { SessionManager } from "../sessions.js";
import type { SessionRunnerRegistry } from "../session-runner.js";
import { emitChatCard, type InProgressPersister } from "../chat-card-persistence.js";
import { ServiceError } from "./types.js";

/**
 * Max title length. Matches the cap `generateSessionName` applies to the AI
 * name, so an agent-set title can't be visually longer than an automatic one.
 * Enforced by REJECTION rather than truncation: silently cutting a title leaves
 * the agent believing it set something it didn't, and it has no way to find out.
 */
export const MAX_SESSION_TITLE_LENGTH = 60;

export interface RenameSessionByAgentDeps {
  sessionManager: SessionManager;
  runnerRegistry: SessionRunnerRegistry;
  chatHistoryManager: InProgressPersister;
  sseBroadcast: (event: string, data: unknown) => void;
}

export interface RenameSessionByAgentResult {
  sessionId: string;
  /** The title before this rename — echoed so the shim can show `from → to`. */
  previousTitle: string;
  title: string;
}

/**
 * True when `session`'s current title must not be overwritten by a writer whose
 * provenance is `source`.
 *
 * The whole precedence rule, in one predicate:
 *   - a `"user"` title is locked against everything (requirement 4);
 *   - an `"agent"` title is locked against automatic naming but not against the
 *     user (requirement 8);
 *   - an absent source is locked against nothing (requirement 7).
 *
 * `source` is what the *would-be writer* is, so `undefined` means "the automatic
 * namer" — the most restricted writer, not the least.
 */
export function isTitleLockedAgainst(
  session: Pick<SessionInfo, "titleSource">,
  source: SessionTitleSource | undefined,
): boolean {
  // The user overrides everything, so a user write is never blocked.
  if (source === "user") return false;
  if (session.titleSource === "user") return true;
  // Automatic naming (no source) must not clobber a deliberate agent rename.
  if (session.titleSource === "agent") return source !== "agent";
  return false;
}

/**
 * Validate an agent-supplied title. Returns the trimmed value or throws a
 * `ServiceError` whose message is written for the agent to act on (it is
 * surfaced verbatim by the shim).
 */
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

/**
 * Rename the session the calling agent is running in (`shipit session rename`).
 *
 * `sessionId` is injected by the worker from the container's own `SESSION_ID`,
 * so an agent can only ever rename itself (requirement 3) — this function is
 * never handed an id the caller chose.
 *
 * Refuses when the user has renamed by hand (requirement 4). That is a 409 with
 * an explanatory message rather than a silent no-op: a silent success would have
 * the agent report a rename that didn't happen.
 */
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
  // Nothing changed — don't emit a card claiming a rename happened. Still a
  // success: the agent asked for a state that now holds.
  if (previousTitle === title) {
    return { sessionId, previousTitle, title };
  }

  const updated = deps.sessionManager.rename(sessionId, title, "agent");
  if (!updated) throw new ServiceError(404, "Session not found");

  // The sidebar entry, for every viewer including other tabs. The agent has no
  // client doing an optimistic store update, so without this the rename would be
  // invisible until a reload.
  deps.sseBroadcast("session_renamed", { session: updated });

  // The transcript row (requirement 9). The rename relays over HTTP mid-turn,
  // i.e. off the agent-event stream, which is exactly the side-channel shape
  // CLAUDE.md's persistence invariant covers — so it goes through `emitChatCard`,
  // which emits, records in-band and persists in one call (and picks the
  // post-turn append path itself when no turn is running). Best-effort: the
  // rename itself already happened, and no runner means nobody is watching.
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
