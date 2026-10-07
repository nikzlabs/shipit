import type { LogSource } from "../../shared/types.js";
import type { SessionManager } from "../sessions.js";
import type { SessionRunnerInterface } from "../session-runner.js";
import { scheduleInterruptCommit, type PostInterruptCommitDeps } from "./post-interrupt-commit.js";
import { noteUserStop, requestStopDuringSetup } from "../turn-stop-request.js";
import { stopCompactionContinuation } from "./agent-compaction-stop.js";

export interface AgentInterruptDeps {
  sessionManager: Pick<SessionManager, "dropPendingCompactionNote">;
  broadcastLog: (source: LogSource, text: string) => void;
  postInterruptCommitDeps: PostInterruptCommitDeps;
}

/**
 * The chat's stop control: ends the session's turn. Shared with Stop on a scheduled run
 * (docs/324-scheduled-sessions req 33). False when there was no turn or agent to stop.
 */
export function interruptAgentTurn(deps: AgentInterruptDeps, runner: SessionRunnerInterface | null): boolean {
  if (runner) stopCompactionContinuation(deps.sessionManager, runner);
  // The turn has not submitted its prompt, and may not have an agent yet: it ends itself.
  if (runner?.running && requestStopDuringSetup(runner)) {
    runner.wasInterrupted = true;
    noteUserStop(runner);
    deps.broadcastLog("server", "Agent turn stopped by user before it started");
    runner.emitMessage({ type: "agent_interrupted" });
    return true;
  }
  const agent = runner?.getAgent() ?? null;
  if (!agent || !runner) return false;

  runner.wasInterrupted = true;
  noteUserStop(runner);
  // A resident streaming CLI outlives an interrupt, and a background task it still runs
  // wakes it into a turn the user just stopped. A one-shot CLI's interrupt ends it already.
  const kill = runner.isStreamingActive;
  const signal = (): void => {
    if (kill) agent.kill();
    else agent.interrupt();
  };
  // A proxied submission returns before the worker holds the process; signal after it does,
  // and only if this agent is still the runner's, since an interrupt is not targeted.
  const submission = agent.submissionSettled?.();
  if (!submission) {
    signal();
  } else {
    void (async () => {
      try { await submission; } catch { /* a refused start still gets the signal */ }
      if (runner.getAgent() === agent) signal();
    })();
  }
  deps.broadcastLog("server", "Agent process stopped by user");
  runner.emitMessage({ type: "agent_interrupted" });

  // Interrupted streaming turns may emit neither done nor agent_result.
  scheduleInterruptCommit({ deps: deps.postInterruptCommitDeps, runner });
  return true;
}
