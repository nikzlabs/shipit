import type { AgentProcess } from "../shared/types.js";
import type { SessionRunnerInterface } from "./session-runner.js";
import { forgetStatusCardSpawn, statusCardSpawnValue } from "./session-status-spawn-record.js";

// Clearing the slot bypasses displacement handling. Settle before removing its listeners.
function resolveResidentToRetire(runner: SessionRunnerInterface): AgentProcess | null {
  const resident = runner.getAgent();
  if (resident) resident.emit("superseded");
  return resident;
}

// Model, endpoint and credentials are fixed at spawn; changes require a new process.
export function releaseResidentOnSpawnChange(
  runner: SessionRunnerInterface | null | undefined,
  desiredIdentity: string | undefined,
): boolean {
  if (!runner) return false;
  const applied = runner.appliedSpawnIdentity;
  // Adopted processes can have an unknown identity; do not respawn them every turn.
  if (applied === undefined || applied === desiredIdentity) return false;
  const resident = resolveResidentToRetire(runner);
  if (!resident) return false;

  // Prevent kill's done event from repeating the previous turn's terminal flow.
  try {
    resident.removeAllListeners();
  } catch {
    // Best-effort listener cleanup.
  }
  try {
    resident.kill();
  } catch {
    // Already gone.
  }
  if (runner.getAgent() === resident) runner.setAgent(null);
  runner.isStreamingActive = false;
  runner.appliedSpawnIdentity = undefined;
  // The exiting CLI reaps its tasks; stale counts would prevent idle reclamation.
  runner.clearBackgroundTasks();
  console.log(
    `[spawn-switch] released resident agent for ${runner.sessionId}: `
    + `spawned as ${applied}, session now selects ${desiredIdentity ?? "the agent default"}`,
  );
  return true;
}

/**
 * docs/303 req 21 — a resident spawned with the other value of the setting holds
 * the wrong tool list and the wrong prompt for this turn, so it is retired and
 * the turn spawns fresh. The value each session was spawned with is recorded in
 * `session-status-spawn-record.ts`, at the one place it is decided.
 */
export function releaseResidentOnStatusCardChange(
  runner: SessionRunnerInterface | null | undefined,
  sessionStatusCard: boolean,
): boolean {
  if (!runner) return false;
  const applied = statusCardSpawnValue(runner.sessionId);
  // An adopted process, or one from before a restart, has no record; the next
  // spawn writes one rather than this retiring it every turn.
  if (applied === undefined || applied === sessionStatusCard) return false;
  const resident = resolveResidentToRetire(runner);
  if (!resident) return false;

  try {
    resident.removeAllListeners();
  } catch {
    // Best-effort listener cleanup.
  }
  try {
    resident.kill();
  } catch {
    // Already gone.
  }
  if (runner.getAgent() === resident) runner.setAgent(null);
  runner.isStreamingActive = false;
  runner.appliedSpawnIdentity = undefined;
  runner.clearBackgroundTasks();
  // The record is rewritten by the spawn this turn makes; forgetting it keeps a
  // failed spawn from retiring the next process on a value it never had.
  forgetStatusCardSpawn(runner.sessionId);
  console.log(
    `[spawn-switch] released resident agent for ${runner.sessionId}: `
    + `spawned with the session status card ${applied ? "on" : "off"}, `
    + `the setting is now ${sessionStatusCard ? "on" : "off"}`,
  );
  return true;
}

/**
 * docs/303 req 21 — the setting can only change through a running orchestrator,
 * so the toggle itself is where every session is brought in line: each idle
 * resident is retired, and the turn after spawns with the other tool list and
 * the other prompt. A resident whose session is mid-turn is left alone and is
 * caught by `releaseResidentOnStatusCardChange` when that session's next
 * interactive turn starts. This covers a resident adopted after a restart too,
 * which has no recorded spawn value to compare.
 */
export function releaseResidentsOnStatusCardToggle(
  registry: {
    listActive(): string[];
    get(sessionId: string): SessionRunnerInterface | undefined;
  },
  enabled: boolean,
): number {
  let released = 0;
  for (const sessionId of registry.listActive()) {
    const runner = registry.get(sessionId);
    if (!runner) continue;
    if (releaseResidentForToggle(runner)) released += 1;
  }
  if (released > 0) {
    console.log(
      `[spawn-switch] released ${released} idle resident agent(s): the session status card `
      + `setting is now ${enabled ? "on" : "off"}`,
    );
  }
  return released;
}

function releaseResidentForToggle(runner: SessionRunnerInterface): boolean {
  // Killing a process mid-turn would lose the turn; that session waits for its
  // next turn, where the recorded spawn value is compared instead.
  if (runner.running) return false;
  if (runner.backgroundWorkDescriptions.length > 0) return false;
  const resident = resolveResidentToRetire(runner);
  if (!resident) return false;
  try {
    resident.removeAllListeners();
  } catch {
    // Best-effort listener cleanup.
  }
  try {
    resident.kill();
  } catch {
    // Already gone.
  }
  if (runner.getAgent() === resident) runner.setAgent(null);
  runner.isStreamingActive = false;
  runner.appliedSpawnIdentity = undefined;
  runner.clearBackgroundTasks();
  forgetStatusCardSpawn(runner.sessionId);
  return true;
}

// Key rotation does not change route identity. Defer retirement while work is active.
export function releaseResidentForCredentialChange(
  runner: SessionRunnerInterface | null | undefined,
): boolean {
  if (!runner || runner.running) return false;
  if (runner.backgroundWorkDescriptions.length > 0) return false;
  const resident = resolveResidentToRetire(runner);
  if (!resident) return false;
  try {
    resident.removeAllListeners();
  } catch {
    // Best-effort listener cleanup.
  }
  try {
    resident.kill();
  } catch {
    // Already gone.
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
