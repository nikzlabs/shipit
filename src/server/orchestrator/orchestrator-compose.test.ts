import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parse as parseYaml } from "yaml";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
// Where a compose file that runs the orchestrator can live. Discovered rather than listed, so a
// fourth deployment stack cannot ship without the shim; anchored on the orchestrator Dockerfiles,
// which no other service builds from.
const SEARCH_DIRS = ["deployment", "docker"];
const ORCHESTRATOR_DOCKERFILES = ["docker/Dockerfile.prod", "docker/Dockerfile.dev"];

interface ComposeDoc {
  services?: Record<string, { init?: boolean; build?: { dockerfile?: string } | string }>;
}

function composeFiles(): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.ya?ml$/.test(entry.name)) found.push(full);
    }
  };
  for (const dir of SEARCH_DIRS) walk(path.join(REPO_ROOT, dir));
  for (const name of fs.readdirSync(REPO_ROOT)) {
    if (/^docker-compose.*\.ya?ml$/.test(name)) found.push(path.join(REPO_ROOT, name));
  }
  return found;
}

function orchestratorServices(): { file: string; service: string; init?: boolean }[] {
  const out: { file: string; service: string; init?: boolean }[] = [];
  for (const file of composeFiles()) {
    let doc: ComposeDoc;
    try {
      doc = parseYaml(fs.readFileSync(file, "utf-8")) as ComposeDoc;
    } catch {
      continue;
    }
    for (const [service, def] of Object.entries(doc?.services ?? {})) {
      const dockerfile = typeof def?.build === "object" ? def.build.dockerfile : undefined;
      if (dockerfile && ORCHESTRATOR_DOCKERFILES.includes(dockerfile)) {
        out.push({ file: path.relative(REPO_ROOT, file), service, init: def?.init });
      }
    }
  }
  return out;
}

describe("orchestrator compose services declare an init shim (planning#613)", () => {
  const services = orchestratorServices();

  // A discovery that silently found nothing would pass every assertion below.
  it("finds the known orchestrator services", () => {
    expect(services.map((s) => s.file).sort()).toEqual([
      "deployment/vps/docker-compose.yml",
      "docker/local/dev/compose.yml",
      "docker/local/prod/compose.yml",
    ]);
  });

  it.each(services)("$file ($service) reaps orphans adopted by PID 1", ({ init }) => {
    // Whatever occupies PID 1 — node in prod, the entrypoint's npm in dev — reaps only its own
    // children, so a git reparented onto it stays a zombie for the container's life. Session
    // containers set the same flag (container-lifecycle.ts).
    expect(init).toBe(true);
  });
});
