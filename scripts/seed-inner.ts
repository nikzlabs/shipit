import { seedCredentials } from "./seed-inner-credentials.js";
import { seedRoles } from "./seed-inner-roles.js";
import { seed as seedRepos } from "./seed-inner-sessions.js";

// Roles need stored credentials. Clone repos last so slow clones do not delay the other steps.
export const SEED_STEPS: readonly { name: string; run: () => Promise<unknown> }[] = [
  { name: "credentials", run: () => seedCredentials() },
  { name: "roles", run: () => seedRoles() },
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
