/**
 * Release a resident streaming agent process whose model no longer matches the
 * model selected for the session.
 *
 * Live steering (docs/140) keeps ONE CLI process resident across turns: after
 * the first turn every subsequent message is injected with `sendUserMessage`
 * instead of spawning a new agent. The model, however, is a spawn-time flag
 * (`--model` for Claude, the `turn/start` model for Codex's first turn) — there
 * is no mid-stream control_request ShipIt pushes for it, the way it pushes
 * `set_permission_mode` when the permission chip changes between turns.
 *
 * So a mid-session model change was silently a no-op. `set_model` moved
 * `SessionInfo.model` (which is what the picker's checkmark reads) while every
 * following turn still ran on the OLD process — and the CLI's `agent_init`
 * reported that old model back, which is what the picker's trigger label reads.
 * The two disagreed forever: "I switched Fable → Opus, the dropdown says Opus,
 * the button says Fable."
 *
 * The fix is to make the spawn boundary real. When the selected model no longer
 * matches what the resident process was spawned with, kill the process; the
 * turn then spawns a fresh one with the new `--model` and `--resume <session>`,
 * which is the same kill-and-resume the auth-heal and quota-failover retries
 * already rely on for conversation continuity (`turn-executor.ts`). A model
 * change is rare and user-initiated, so paying one respawn for it is cheaper —
 * and far less machinery — than plumbing a per-agent mid-stream model switch
 * through the worker HTTP surface for every backend.
 */

import type { SessionRunnerInterface } from "./session-runner.js";

/**
 * Kill the runner's resident agent when `desiredModel` differs from the model
 * it was spawned with. No-op when there is no resident process, when the models
 * agree, or when the spawn-time model is unknown (`appliedModel === undefined`,
 * e.g. a process adopted across an orchestrator restart) — killing on an
 * unknown baseline would respawn on every turn.
 *
 * Returns true when a process was released, so callers can log it.
 */
export function releaseResidentOnModelChange(
  runner: SessionRunnerInterface | null | undefined,
  desiredModel: string | undefined,
): boolean {
  if (!runner) return false;
  const applied = runner.appliedModel;
  if (applied === undefined || applied === desiredModel) return false;
  const resident = runner.getAgent();
  if (!resident) return false;

  // Drop the previous turn's listeners BEFORE killing, so the kill's `done`
  // can't re-run that turn's terminal flow (commit / drain / finished SSE)
  // against a turn that already completed. The state `done` would have cleared
  // is cleared here instead.
  try {
    resident.removeAllListeners();
  } catch {
    // Best-effort: an adapter without listeners is already in the state we want.
  }
  try {
    resident.kill();
  } catch {
    // Already gone is the state we wanted.
  }
  if (runner.getAgent() === resident) runner.setAgent(null);
  runner.isStreamingActive = false;
  runner.appliedModel = undefined;
  // docs/235 — the CLI reaps its background tasks when it exits; a stale count
  // would pin `agentBusy` true and block idle reclaim forever.
  runner.clearBackgroundTasks();
  console.log(
    `[model-switch] released resident agent for ${runner.sessionId}: `
    + `spawned with ${applied}, session now selects ${desiredModel ?? "the agent default"}`,
  );
  return true;
}
