import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parse as parseYaml } from "yaml";

import { CONTAINER_BUILD_ID_LABEL } from "./session-container.js";

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

// The orchestrator pins the images it uses at start, so an update that rebuilt only
// another image must still restart it (planning#626).
describe("an update starts the orchestrator with every image it built", () => {
  it.each(["deployment/vps/deploy.sh", "deployment/local/lib.sh"])("%s recreates the orchestrator", (script) => {
    const upLines = fs.readFileSync(path.join(REPO_ROOT, script), "utf-8")
      .split("\n")
      .filter((line) => /docker compose\b.*\sup\s/.test(line));
    expect(upLines.length, `${script} has no start line`).toBeGreaterThan(0);
    for (const line of upLines) expect(line).toMatch(/\s--force-recreate\s/);
  });
});

// Confined Compose runs need the helper image wherever ShipIt ships (docs/318 req 4).
describe("every deployment builds the Compose helper image (docs/318)", () => {
  const DEPLOYMENTS = [
    { compose: "deployment/vps/docker-compose.yml", script: "deployment/vps/deploy.sh" },
    { compose: "docker/local/dev/compose.yml", script: "docker/local/dev.sh" },
    { compose: "docker/local/prod/compose.yml", script: "docker/local/prod.sh" },
    { compose: "docker/local/prod/compose.yml", script: "deployment/local/lib.sh" },
  ];

  interface Service { build?: { dockerfile?: string } | string; image?: string; environment?: string[] }

  it("covers every orchestrator compose file", () => {
    expect(new Set(DEPLOYMENTS.map((d) => d.compose))).toEqual(new Set(orchestratorServices().map((s) => s.file)));
  });

  it.each(DEPLOYMENTS)("$script builds the helper that $compose names", ({ compose, script }) => {
    const services = (parseYaml(fs.readFileSync(path.join(REPO_ROOT, compose), "utf-8")) as {
      services: Record<string, Service>;
    }).services;
    const helper = services["compose-helper"];
    expect(typeof helper?.build === "object" && helper.build.dockerfile).toBe("Dockerfile.compose-helper");
    const orchestrator = Object.values(services).find((svc) =>
      typeof svc.build === "object" && ORCHESTRATOR_DOCKERFILES.includes(svc.build.dockerfile ?? ""));
    expect(orchestrator?.environment).toContain(`SESSION_COMPOSE_HELPER_IMAGE=${helper?.image}`);

    const buildLines = fs.readFileSync(path.join(REPO_ROOT, script), "utf-8")
      .split("\n")
      .filter((line) => /docker compose\b.*\sbuild\s.*\bshipit\b/.test(line));
    expect(buildLines.length, `${script} has no image build line`).toBeGreaterThan(0);
    for (const line of buildLines) expect(line).toMatch(/\bcompose-helper\b/);
  });
});

// A worker whose image has no build id reads as "unknown", never "stale", so an update never
// replaces it while idle (docs/242). A local install once built its worker without one.
describe("every deployment stamps its images with the build id", () => {
  const DEPLOYMENTS = [
    { compose: "deployment/vps/docker-compose.yml", script: "deployment/vps/deploy.sh" },
    { compose: "docker/local/dev/compose.yml", script: "docker/local/dev.sh" },
    { compose: "docker/local/prod/compose.yml", script: "docker/local/prod.sh" },
    { compose: "docker/local/prod/compose.yml", script: "deployment/local/lib.sh" },
  ];

  interface Service {
    build?: { context?: string; dockerfile?: string; args?: Record<string, string> | string[] } | string;
  }

  const composeArg = (args: Record<string, string> | string[] | undefined, name: string): string | undefined =>
    Array.isArray(args) ? args.find((a) => a.startsWith(`${name}=`))?.slice(name.length + 1) : args?.[name];

  const cases = DEPLOYMENTS.flatMap(({ compose, script }) => {
    const composePath = path.join(REPO_ROOT, compose);
    const services = (parseYaml(fs.readFileSync(composePath, "utf-8")) as {
      services: Record<string, Service>;
    }).services;
    const buildLines = fs.readFileSync(path.join(REPO_ROOT, script), "utf-8")
      .split("\n")
      .filter((line) => /docker compose\b.*\sbuild\s/.test(line));
    return Object.entries(services).flatMap(([service, def]) => {
      if (typeof def.build !== "object" || !def.build.dockerfile) return [];
      const dockerfile = path.resolve(path.dirname(composePath), def.build.context ?? ".", def.build.dockerfile);
      if (!/^ARG SHIPIT_BUILD_ID\b/m.test(fs.readFileSync(dockerfile, "utf-8"))) return [];
      const lines = buildLines.filter((line) => new RegExp(`\\s${service}(\\s|$)`).test(line));
      if (lines.length === 0) return [];
      return [{
        compose,
        script,
        service,
        lines,
        dockerfile: path.relative(REPO_ROOT, dockerfile),
        arg: composeArg(def.build.args, "SHIPIT_BUILD_ID"),
      }];
    });
  });

  it("covers every orchestrator compose file", () => {
    expect(new Set(DEPLOYMENTS.map((d) => d.compose))).toEqual(new Set(orchestratorServices().map((s) => s.file)));
  });

  it("finds the stamped worker image in every deployment that builds it", () => {
    expect(cases.filter((c) => c.dockerfile === "docker/Dockerfile.session-worker.prod").map((c) => c.script).sort())
      .toEqual(["deployment/local/lib.sh", "deployment/vps/deploy.sh", "docker/local/prod.sh"]);
  });

  it("labels the final worker stage with the build id the orchestrator reads", () => {
    const final = fs.readFileSync(path.join(REPO_ROOT, "docker/Dockerfile.session-worker.prod"), "utf-8")
      .split(/^FROM\s/m)
      .at(-1);
    expect(final).toMatch(/^ARG SHIPIT_BUILD_ID\b/m);
    expect(final).toMatch(new RegExp(`^LABEL ${CONTAINER_BUILD_ID_LABEL}=\\$\\{SHIPIT_BUILD_ID\\}`, "m"));
  });

  it.each(cases)("$script gives $service in $compose the build id", ({ script, lines, arg }) => {
    const src = fs.readFileSync(path.join(REPO_ROOT, script), "utf-8");
    expect(src, `${script} must take the build id from the commit`)
      .toMatch(/^\s*SHIPIT_BUILD_ID="\$\(git\b[^\n]*rev-parse HEAD/m);
    // Directly on the build line, or through an array the line expands, e.g. "${BUILD_ARGS[@]}".
    const cliArg = `["']?--build-arg["']?\\s+["']?SHIPIT_BUILD_ID=`;
    const onCommandLine = lines.every((line) =>
      new RegExp(cliArg).test(line)
      || [...line.matchAll(/\$\{(\w+)\[@\]\}/g)].some(([, array]) =>
        new RegExp(`^\\s*${array}\\+?=\\(.*${cliArg}`, "m").test(src)));
    if (onCommandLine) return;
    expect(arg, "compose build arg SHIPIT_BUILD_ID").toMatch(/\$\{SHIPIT_BUILD_ID\b/);
    expect(src, `${script} must export SHIPIT_BUILD_ID for compose to read it`).toMatch(/^\s*export SHIPIT_BUILD_ID\b/m);
  });
});
