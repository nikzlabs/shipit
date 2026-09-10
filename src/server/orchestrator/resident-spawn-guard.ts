import type { AgentProcess } from "../shared/types.js";
import type { SessionRunnerInterface } from "./session-runner.js";

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
