/**
 * The dogfood inner ShipIt's seed step, as **one** entry point (docs/131).
 *
 * ## Why one script and not three
 *
 * There are three things to seed — credentials, agent roles, repos — and they
 * grew one at a time, so the `dev` service's `command:` grew into a chain of
 * three interpreter invocations with the ordering rationale living in a YAML
 * comment. Nothing required that: the three modules already export
 * dependency-injected functions, so the chain is expressible here, in a file
 * that can say *why* the order is what it is next to the code that depends on
 * it. Compose is left naming one command, and a fourth step is added here rather
 * than by editing a shell string.
 *
 * Each step keeps its own entry block, so any of them can still be run alone
 * while debugging (`npx tsx scripts/seed-inner-roles.ts`).
 *
 * ## The order is load-bearing, twice
 *
 * Credentials first, because they are what decide the rest. A role names a
 * harness and a model (docs/264-agent-roles req 6) and the role seeder resolves
 * those against the models this install can actually run — so planning before
 * the credentials are stored plans against a narrower install and seeds fewer,
 * or no, roles.
 *
 * Repos last, because a cold bare-cache clone takes minutes and neither of the
 * other two should wait behind it. They are seconds of HTTP each.
 *
 * ## Contract (docs/131 reqs 3, 5, 6)
 *
 * Unchanged, and still each step's own: `DOGFOOD_SEED=0` disables everything,
 * each step has its own switch, each skips what is already present, and each
 * exits 0 on failure. This adds one guarantee on top — a step that throws
 * something unexpected is logged and the **remaining steps still run**, so a
 * single entry point cannot become a single point of failure the three separate
 * invocations were not.
 */

import { seedCredentials } from "./seed-inner-credentials.js";
import { seedRoles } from "./seed-inner-roles.js";
// Plain JS, deliberately (it predates the other two and has no dependencies).
// Under `tsx` that is an ordinary import; `seed-inner-sessions.test.ts` already
// imports it the same way.
import { seed as seedRepos } from "./seed-inner-sessions.js";

/** The steps, in the order the comment above justifies. */
export const SEED_STEPS: readonly { name: string; run: () => Promise<unknown> }[] = [
  { name: "credentials", run: () => seedCredentials() },
  { name: "roles", run: () => seedRoles() },
  { name: "repos", run: () => seedRepos() },
];

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Run every step in order, in sequence.
 *
 * Sequential rather than concurrent: the roles step reads what the credentials
 * step wrote, and three concurrent health-wait polls against an orchestrator
 * that is still booting buy nothing anyway.
 */
export async function runAll(
  steps: readonly { name: string; run: () => Promise<unknown> }[] = SEED_STEPS,
  log: (msg: string) => void = (msg) => { console.log(msg); },
): Promise<void> {
  for (const step of steps) {
    try {
      await step.run();
    } catch (err) {
      // Every step already handles its own failures and exits 0; this catches
      // the unexpected, and exists so one step's bug cannot silently cancel the
      // ones after it.
      log(`${step.name}: unexpected failure: ${errorMessage(err)}`);
    }
  }
}

// Entry point. Never exits non-zero: a seeding failure is a degraded dogfood
// loop, not a broken dev service (req 5).
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  void runAll();
}
