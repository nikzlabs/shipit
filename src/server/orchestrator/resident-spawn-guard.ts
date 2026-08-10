/**
 * Release a resident streaming agent process whose spawn identity no longer
 * matches what the session now selects.
 *
 * Live steering (docs/140) keeps ONE CLI process resident across turns: after
 * the first turn every subsequent message is injected with `sendUserMessage`
 * instead of spawning a new agent. Everything that shapes a spawn, however, is
 * fixed at spawn time — the model (`--model` for Claude, the `turn/start` model
 * for Codex's first turn), and now the endpoint and the credential too. There is
 * no mid-stream control_request ShipIt pushes for any of them, the way it pushes
 * `set_permission_mode` when the permission chip changes between turns.
 *
 * So a mid-session change was silently a no-op. `set_model` moved
 * `SessionInfo.model` (which is what the picker's checkmark reads) while every
 * following turn still ran on the OLD process — and the CLI's `agent_init`
 * reported that old model back, which is what the picker's trigger label reads.
 * The two disagreed forever: "I switched Fable → Opus, the dropdown says Opus,
 * the button says Fable."
 *
 * The fix is to make the spawn boundary real. When the session's spawn identity
 * no longer matches what the resident process was spawned with, kill the
 * process; the turn then spawns a fresh one with the new shaping and
 * `--resume <session>`, which is the same kill-and-resume the auth-heal and
 * quota-failover retries already rely on for conversation continuity
 * (`turn-executor.ts`). Such a change is rare and user-initiated, so paying one
 * respawn for it is cheaper — and far less machinery — than plumbing a
 * mid-stream switch through the worker HTTP surface for every backend.
 *
 * **docs/252 phase 3 widened the identity from a model string to the whole
 * spawn-relevant tuple**, and sequencing that later would have been a bug rather
 * than a deferral. A model id does not identify a service (req 5): the same
 * `deepseek-v4-flash` is reachable directly and through a gateway, so under the
 * old string comparison a switch between them looked like no change at all —
 * no kill, and the next turn ran on the previous service's endpoint and
 * credential, billing the wrong account (req 11). Phase 3 is the phase that
 * makes that switch reachable, so it is the phase that has to close it.
 * `sessionSpawnIdentity` (`service-routing.ts`) is the tuple; this module only
 * compares it.
 */

import type { AgentProcess } from "../shared/types.js";
import type { SessionRunnerInterface } from "./session-runner.js";

/**
 * planning#318 — read the resident process and, if one is there, SETTLE the turn it
 * still belongs to before either helper below retires it.
 *
 * Both helpers retire by clearing the slot (`kill(); setAgent(null)`), so the
 * turn that spawns next installs its proxy over an EMPTY slot and
 * `ContainerSessionRunner.supersedeDisplacedAgent` — which fires only for a slot
 * REPLACEMENT — never sees the displacement. Nothing else settles the retired
 * turn either: its own `agent_done` carries the previous spawn's `runToken` and
 * is dropped by the docs/146 stale-spawn guard, the runner is alive so there is
 * no `disposed`, and the worker truthfully reports an agent running so there is
 * no `turn_abandoned`. That is how a merge-wake turn stayed pending at
 * `merge-observed` until planning#260's supervisor re-sent it (see
 * `dispatched-turn.ts`'s `supersedeRetiredTurn`, the same fix at the two
 * retirement sites in `runOnce`).
 *
 * SETTLEMENT ONLY, and it must run BEFORE `removeAllListeners()` — the
 * settlement travels on one of those listeners. The `superseded` handler in
 * `turn-executor.ts` runs no teardown by contract, and a turn that already
 * settled latches, so this is a no-op for every ordinary release.
 */
function resolveResidentToRetire(runner: SessionRunnerInterface): AgentProcess | null {
  const resident = runner.getAgent();
  if (resident) resident.emit("superseded");
  return resident;
}

/**
 * Kill the runner's resident agent when `desiredIdentity` differs from the
 * identity it was spawned with. No-op when there is no resident process, when
 * the identities agree, or when the spawn-time identity is unknown
 * (`appliedSpawnIdentity === undefined`, e.g. a process adopted across an
 * orchestrator restart) — killing on an unknown baseline would respawn on every
 * turn.
 *
 * Returns true when a process was released, so callers can log it.
 */
export function releaseResidentOnSpawnChange(
  runner: SessionRunnerInterface | null | undefined,
  desiredIdentity: string | undefined,
): boolean {
  if (!runner) return false;
  const applied = runner.appliedSpawnIdentity;
  if (applied === undefined || applied === desiredIdentity) return false;
  const resident = resolveResidentToRetire(runner);
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
  runner.appliedSpawnIdentity = undefined;
  // docs/235 — the CLI reaps its background tasks when it exits; a stale count
  // would pin `agentBusy` true and block idle reclaim forever.
  runner.clearBackgroundTasks();
  console.log(
    `[spawn-switch] released resident agent for ${runner.sessionId}: `
    + `spawned as ${applied}, session now selects ${desiredIdentity ?? "the agent default"}`,
  );
  return true;
}

/**
 * docs/252 phase 3 — release a resident agent so its next turn respawns with
 * the credentials the store now holds.
 *
 * A resident CLI reads its credential from the environment it was **spawned**
 * with, and phase 2's propagation updates the worker's environment without
 * touching a process already running in it. So without this, rotating a key in
 * place kept the old one in use — the route id does not change, so the spawn
 * identity does not either — and *deleting* one left it authenticating turns
 * for the rest of that process's life, which defeats the revocation phase 2
 * went to some length to make reach live sessions.
 *
 * **A runner mid-turn is skipped**, deliberately: killing it would abort work
 * the user is waiting on, to shorten a window that closes at the end of that
 * turn anyway. The honest statement is that revocation takes effect at the next
 * spawn boundary, not that it is instantaneous.
 *
 * Returns true when a process was released.
 */
export function releaseResidentForCredentialChange(
  runner: SessionRunnerInterface | null | undefined,
): boolean {
  if (!runner || runner.running) return false;
  // docs/260 req 13 — in-progress background work (a sub-agent review, an
  // agent-started background process) is never killed for a credential
  // change either: the tokens already spent on it outweigh the shortened
  // revocation window, and the process converges at its next clean turn
  // exactly as a mid-turn runner does.
  if (runner.backgroundWorkDescriptions.length > 0) return false;
  const resident = resolveResidentToRetire(runner);
  if (!resident) return false;
  try {
    resident.removeAllListeners();
  } catch {
    // An adapter without listeners is already in the state we want.
  }
  try {
    resident.kill();
  } catch {
    // Already gone is the state we wanted.
  }
  if (runner.getAgent() === resident) runner.setAgent(null);
  runner.isStreamingActive = false;
  runner.appliedSpawnIdentity = undefined;
  runner.clearBackgroundTasks();
  console.log(
    `[credentials] released resident agent for ${runner.sessionId} — a credential changed, `
    + `so the next turn respawns with the credentials the store now holds`,
  );
  return true;
}
