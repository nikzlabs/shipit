import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { SEED_STEPS, runAll } from "./seed-inner.js";

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("the seed step order", () => {
  it("seeds credentials, then roles, then repos", () => {
    // Credentials before roles because a role names a harness and a model, and
    // the role seeder resolves those against the models this install can run —
    // which is exactly what the credential step has just widened. Repos last
    // because a cold clone takes minutes.
    expect(SEED_STEPS.map((s) => s.name)).toEqual(["credentials", "roles", "repos"]);
  });
});

describe("runAll", () => {
  it("runs the steps in order, one at a time", async () => {
    const order: string[] = [];
    await runAll([
      { name: "a", run: async () => { order.push("a"); } },
      { name: "b", run: async () => { order.push("b"); } },
    ]);
    expect(order).toEqual(["a", "b"]);
  });

  it("carries on after a step throws, so one bug cannot cancel the rest (req 5)", async () => {
    // The guarantee a single entry point owes the three separate invocations it
    // replaced: they could not take each other down, and neither may this.
    const order: string[] = [];
    const logged: string[] = [];
    await runAll(
      [
        { name: "boom", run: async () => { throw new Error("nope"); } },
        { name: "after", run: async () => { order.push("after"); } },
      ],
      (msg) => logged.push(msg),
    );
    expect(order).toEqual(["after"]);
    expect(logged[0]).toContain("boom");
    expect(logged[0]).toContain("nope");
  });
});

/**
 * The failure mode no unit test can otherwise see: a seeder that passes every
 * test and is never run at boot.
 *
 * Every step exits 0 on failure by design, so "seeded nothing" and "was never
 * launched" look identical in the `[seed]` logs. This asserts the wiring itself.
 */
describe("the dev service's seed step", () => {
  const compose = parse(readFileSync(path.join(REPO_ROOT, "docker-compose.yml"), "utf8")) as {
    services: Record<string, { command?: string }>;
  };
  const command = compose.services.dev.command ?? "";

  it("runs the seeder", () => {
    expect(command).toContain("scripts/seed-inner.ts");
  });

  it("runs it with tsx, since the seeders import the TypeScript catalogue", () => {
    expect(command).toContain("npx tsx scripts/seed-inner.ts");
  });
});
