import { describe, it, expect } from "vitest";
import fs from "node:fs";

import { parse as parseYaml } from "yaml";

// Every compose file that runs the orchestrator as its container's main process. The dogfood
// docker-compose.yml is absent because its `dev` service runs the orchestrator as a child of the
// service command, so docker-init (which that service already sets) is PID 1 rather than node.
const COMPOSE_FILES = [
  "../../../deployment/vps/docker-compose.yml",
  "../../../docker/local/prod/compose.yml",
  "../../../docker/local/dev/compose.yml",
];

describe("orchestrator compose files declare an init shim (planning#613)", () => {
  it.each(COMPOSE_FILES)("%s reaps orphans adopted by the orchestrator", (rel) => {
    const raw = fs.readFileSync(new URL(rel, import.meta.url), "utf-8");
    const doc = parseYaml(raw) as { services?: Record<string, { init?: boolean }> };
    // Node reaps only the children it spawned; a git reparented onto PID 1 stays a zombie for the
    // life of the process. Session containers set the same flag (container-lifecycle.ts).
    expect(doc.services?.shipit?.init).toBe(true);
  });
});
