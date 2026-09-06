/**
 * Source-level guards for docs/288's two structural properties. Both are things
 * a behavioural test cannot see and a reviewer reliably misses.
 *
 * They read source text rather than behaviour on purpose: what is being
 * protected is *where code lives*, and the failure mode in each case is a
 * perfectly working second copy.
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Every non-test `.ts` under `src/server`. */
function productionSources(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) productionSources(full, out);
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

describe("one ServiceManager construction site (docs/288)", () => {
  /**
   * The warm path and the runner path must build the SAME object. A second
   * construction site that drifts from the first is how docs/148 regressed
   * silently for months — a `withStandby` opt-in that exactly one caller
   * forgot — and a warm stack built from a divergent object is worse than no
   * warm stack: it runs, gets adopted, and is quietly wrong.
   *
   * The manager takes a dozen collaborators (both secrets loaders, the plugin
   * credentials loader, the containment hooks, the network join/heal functions,
   * the docker-secrets config, the log store, the topology hook). Nothing tells
   * you at a call site which of them you left out.
   */
  it("is constructed in exactly one production file", () => {
    const sites = productionSources(SERVER_DIR)
      .filter((f) => fs.readFileSync(f, "utf8").includes("new ServiceManager("))
      .map((f) => path.relative(SERVER_DIR, f));
    expect(sites).toEqual(["orchestrator/service-manager-setup.ts"]);
  });

  it("the warm pre-start goes through the shared builder", () => {
    const src = fs.readFileSync(
      path.join(SERVER_DIR, "orchestrator/warm-preview.ts"), "utf8",
    );
    expect(src).toContain("buildServiceManager");
  });
});

describe("warm pre-start placement (docs/288 reqs 2, 3)", () => {
  const src = fs.readFileSync(
    path.join(SERVER_DIR, "orchestrator/warm-pool-manager.ts"), "utf8",
  );

  /**
   * req 2 — starting a dev server runs the repository's own `command:`/`build:`,
   * which is exactly the execution docs/178 defers until the user has trusted
   * the remote once. The pre-start must sit BELOW the `isTrusted` early-return
   * that already gates the pre-install, not beside it.
   *
   * And it must sit AFTER `runPreInstall`: `ServiceManager.start()` partitions
   * the auto services on the install gate, so a stack started while install is
   * in flight comes up HELD, and the claim adopts a stopped preview that looks
   * pre-started.
   */
  it("sits after the trust gate and after the pre-install", () => {
    const trustGate = src.indexOf("if (!repoStore.isTrusted(repoUrl))");
    const preInstall = src.indexOf("await runPreInstall(");
    const preStart = src.indexOf("await preStartPreview?.(");
    expect(trustGate).toBeGreaterThan(-1);
    expect(preInstall).toBeGreaterThan(trustGate);
    expect(preStart).toBeGreaterThan(preInstall);
  });

  /**
   * req 3 — pre-starting a preview must never delay the claim, the session
   * opening, or the user's first turn. The whole continuation is discarded by
   * its caller (`void ensureStandbyForWarmSession(...)`), which is what keeps it
   * off every awaited path.
   */
  it("rides the fire-and-forget standby continuation", () => {
    expect(src).toContain("void ensureStandbyForWarmSession({");
  });
});

describe("every path that ends a warm session drops its stack", () => {
  /**
   * Deleting a repo destroys its warm session's container directly — no runner
   * is ever created, so the `disposed` handler that normally unregisters a
   * ServiceManager never runs. `destroy()` sweeps the compose CONTAINERS, which
   * makes the leak invisible: what is left behind is a manager polling Docker
   * for a session that no longer exists, for the life of the process.
   *
   * Ordering is asserted as well as presence: the stop must be issued while its
   * containers are still there.
   */
  it("repo delete stops the warm preview before destroying the container", () => {
    const src = fs.readFileSync(
      path.join(SERVER_DIR, "orchestrator/api-routes-session-repos.ts"), "utf8",
    );
    const stop = src.indexOf("stopWarmPreview(deps.serviceManagers, repo.warmSessionId)");
    const destroy = src.indexOf("containerManager?.destroy(repo.warmSessionId)");
    expect(stop).toBeGreaterThan(-1);
    expect(destroy).toBeGreaterThan(stop);
  });
});
