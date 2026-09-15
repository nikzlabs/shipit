import { seedCredentials } from "./seed-inner-credentials.js";
import { seedRoles } from "./seed-inner-roles.js";
import { seedTranscript } from "./seed-inner-transcript.js";
import { seed as seedRepos } from "./seed-inner-sessions.js";

// Roles need stored credentials, and the transcript needs the database the
// earlier steps waited for. Clone repos last so slow clones delay nothing.
export const SEED_STEPS: readonly { name: string; run: () => Promise<unknown> }[] = [
  { name: "credentials", run: () => seedCredentials() },
  { name: "roles", run: () => seedRoles() },
  { name: "transcript", run: () => seedTranscript() },
  { name: "repos", run: () => seedRepos() },
];

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function runAll(
  steps: readonly { name: string; run: () => Promise<unknown> }[] = SEED_STEPS,
  log: (msg: string) => void = (msg) => { console.log(msg); },
): Promise<void> {
  for (const step of steps) {
    try {
      await step.run();
    } catch (err) {
      log(`${step.name}: unexpected failure: ${errorMessage(err)}`);
    }
  }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  void runAll();
}
