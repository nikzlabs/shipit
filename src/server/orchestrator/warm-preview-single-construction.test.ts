// Source guards check construction sites and ordering, not runtime behavior.

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function productionSources(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) productionSources(full, out);
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

describe("one ServiceManager construction site (docs/288)", () => {
  it("is constructed exactly once, in one production file", () => {
    const sites: Record<string, number> = {};
    for (const file of productionSources(SERVER_DIR)) {
      const count = fs.readFileSync(file, "utf8").split("new ServiceManager(").length - 1;
      if (count > 0) sites[path.relative(SERVER_DIR, file)] = count;
    }
    expect(sites).toEqual({ "orchestrator/service-manager-setup.ts": 1 });
  });

  it("the warm pre-start builds no manager of its own", () => {
    const src = fs.readFileSync(
      path.join(SERVER_DIR, "orchestrator/warm-preview.ts"), "utf8",
    );
    expect(src).not.toContain("new ServiceManager(");
    expect(src).toContain("deps.createManager ?? buildServiceManager");
  });
});

describe("warm pre-start placement (docs/288 reqs 2, 3)", () => {
  const src = fs.readFileSync(
    path.join(SERVER_DIR, "orchestrator/warm-pool-manager.ts"), "utf8",
  );

  it("sits after the trust gate and after the pre-install", () => {
    const trustGate = src.indexOf("if (!repoStore.isTrusted(repoUrl))");
    const preInstall = src.indexOf("await runPreInstall(");
    const preStart = src.indexOf("await preStartPreview?.(");
    expect(trustGate).toBeGreaterThan(-1);
    expect(preInstall).toBeGreaterThan(trustGate);
    expect(preStart).toBeGreaterThan(preInstall);
  });

  it("declines the pre-start unless the pre-install actually settled", () => {
    const settledCheck = src.indexOf("if (!install.settled)");
    const preStart = src.indexOf("await preStartPreview?.(");
    expect(settledCheck).toBeGreaterThan(-1);
    expect(preStart).toBeGreaterThan(settledCheck);
  });

  it("rides the fire-and-forget standby continuation", () => {
    expect(src).toContain("void ensureStandbyForWarmSession({");
  });
});

describe("every path that ends a warm session drops its stack", () => {
  it("repo delete stops the warm preview before destroying the container", () => {
    const src = fs.readFileSync(
      path.join(SERVER_DIR, "orchestrator/api-routes-session-repos.ts"), "utf8",
    );
    const stop = src.indexOf("stopWarmPreview(deps.serviceManagers, repo.warmSessionId");
    const destroy = src.indexOf("containerManager?.destroy(repo.warmSessionId)");
    expect(stop).toBeGreaterThan(-1);
    expect(destroy).toBeGreaterThan(stop);
  });
});
