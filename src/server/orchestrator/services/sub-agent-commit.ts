import type { GitManager } from "../../shared/git.js";
import type { AgentId } from "../../shared/types.js";
import type { PersistedMessage } from "../chat-history.js";
import type { SessionManager } from "../sessions.js";
import type { SessionRunnerRegistry } from "../session-runner.js";
import { emitNoticePostTurn } from "../chat-card-persistence.js";
import { withWorkspaceLock } from "./marketplace.js";
import { flushPendingTurnCommit } from "./github.js";
import { autoCommitAllowed } from "./auto-commit-gate.js";
import { getErrorMessage } from "../validation.js";

export interface SubAgentCommitDeps {
  sessionManager: SessionManager;
  runnerRegistry: SessionRunnerRegistry;
  createGitManager?: (dir: string) => GitManager;
  chatHistoryManager: { append(sessionId: string, message: PersistedMessage): unknown };
}

export function subAgentCommitSubject(subAgentId: AgentId): string {
  return `Sub-agent consult (${subAgentId}): work committed after the turn ended`;
}

// postTurnCommit would replace the previous turn's commit link. Flush separately
// when a consult finishes after that turn has ended.
export async function commitSubAgentWork(
  deps: SubAgentCommitDeps,
  sessionId: string,
  run: { spawnId: string; subAgentId: AgentId },
): Promise<string | null> {
  try {
    if (!deps.createGitManager) return null;

    const session = deps.sessionManager.get(sessionId);
    if (!session || !autoCommitAllowed(session)) return null;

    const runner = deps.runnerRegistry.get(sessionId);
    if (!runner) return null;

    if (runner.running) return null;

    const subject = subAgentCommitSubject(run.subAgentId);

    const commitHash = await withWorkspaceLock(runner.sessionDir, async () => {
      const git = deps.createGitManager!(runner.sessionDir);
      const flush = await flushPendingTurnCommit(git, {
        sessionId,
        runnerRegistry: deps.runnerRegistry,
        chatHistory: deps.chatHistoryManager,
        summary: subject,
      });
      if (flush.kind === "committed") return flush.commitHash;
      if (flush.kind === "partial-unreadable") return flush.commitHash;
      return null;
    });

    if (!commitHash) return null;

    runner.schedulePostTurnPush();

    console.log(
      `[sub-agent] post-turn-commit session=${sessionId} spawn=${run.spawnId} `
      + `agent=${run.subAgentId} commit=${commitHash.slice(0, 8)}`,
    );

    emitNoticePostTurn(
      (m) => runner.emitMessage(m),
      deps.chatHistoryManager,
      sessionId,
      `Committed changes left by the ${run.subAgentId} consult, which finished after the turn ended (\`${commitHash.slice(0, 8)}\`).`,
      "info",
    );

    return commitHash;
  } catch (err) {
    // Commit failure must not prevent delivery of the consult result.
    console.warn(
      `[sub-agent] post-turn-commit-failed session=${sessionId} spawn=${run.spawnId} `
      + `agent=${run.subAgentId}: ${getErrorMessage(err)}`,
    );
    return null;
  }
}
