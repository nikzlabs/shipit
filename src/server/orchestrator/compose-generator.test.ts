import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  parseComposeFile,
  generateComposeOverride,
  writeComposeOverride,
  ComposeValidationError,
} from "./compose-generator.js";

describe("parseComposeFile", () => {
  let tmpDir: string;

  function setup() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "compose-gen-"));
    return tmpDir;
  }

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeCompose(dir: string, content: string): string {
    const p = path.join(dir, "docker-compose.yml");
    fs.writeFileSync(p, content);
    return p;
  }

  it("parses basic service definitions", () => {
    const dir = setup();
    const p = writeCompose(dir, `
services:
  web:
    image: node:20
    ports: ["5173:5173"]
  db:
    image: postgres:16
    ports: ["5432:5432"]
`);
    const services = parseComposeFile(p, { dockerSocket: false });
    expect(services).toHaveLength(2);
    expect(services[0].name).toBe("web");
    expect(services[0].ports).toEqual(["5173:5173"]);
    expect(services[1].name).toBe("db");
  });

  it("extracts x-shipit-preview values", () => {
    const dir = setup();
    const p = writeCompose(dir, `
services:
  web:
    image: node:20
    x-shipit-preview: auto
  db:
    image: postgres:16
    x-shipit-preview: manual
`);
    const services = parseComposeFile(p, { dockerSocket: false });
    expect(services[0].shipitPreview).toBe("auto");
    expect(services[1].shipitPreview).toBe("manual");
  });

  // ---- x-shipit-depends-on-install (docs/137) ----

  it("defaults dependsOnInstall to true for auto-preview services", () => {
    const dir = setup();
    const p = writeCompose(dir, `
services:
  web:
    image: node:20
    x-shipit-preview: auto
`);
    const services = parseComposeFile(p, { dockerSocket: false });
    expect(services[0].dependsOnInstall).toBe(true);
  });

  it("defaults dependsOnInstall to true for services with ports (implicit auto)", () => {
    const dir = setup();
    const p = writeCompose(dir, `
services:
  web:
    image: node:20
    ports: ["5173:5173"]
`);
    const services = parseComposeFile(p, { dockerSocket: false });
    expect(services[0].dependsOnInstall).toBe(true);
  });

  it("defaults dependsOnInstall to false for manual-preview services", () => {
    const dir = setup();
    const p = writeCompose(dir, `
services:
  db:
    image: postgres:16
    x-shipit-preview: manual
`);
    const services = parseComposeFile(p, { dockerSocket: false });
    expect(services[0].dependsOnInstall).toBe(false);
  });

  it("defaults dependsOnInstall to false for portless services (implicit manual)", () => {
    const dir = setup();
    const p = writeCompose(dir, `
services:
  db:
    image: postgres:16
`);
    const services = parseComposeFile(p, { dockerSocket: false });
    expect(services[0].dependsOnInstall).toBe(false);
  });

  it("honors explicit x-shipit-depends-on-install: false on an auto service", () => {
    const dir = setup();
    const p = writeCompose(dir, `
services:
  web:
    image: node:20
    x-shipit-preview: auto
    x-shipit-depends-on-install: false
`);
    const services = parseComposeFile(p, { dockerSocket: false });
    expect(services[0].dependsOnInstall).toBe(false);
  });

  it("honors explicit x-shipit-depends-on-install: true on a manual service", () => {
    const dir = setup();
    const p = writeCompose(dir, `
services:
  worker:
    image: node:20
    x-shipit-preview: manual
    x-shipit-depends-on-install: true
`);
    const services = parseComposeFile(p, { dockerSocket: false });
    expect(services[0].dependsOnInstall).toBe(true);
  });

  it("extracts user-defined profiles", () => {
    const dir = setup();
    const p = writeCompose(dir, `
services:
  debug:
    image: node:20
    profiles: [debug, testing]
`);
    const services = parseComposeFile(p, { dockerSocket: false });
    expect(services[0].profiles).toEqual(["debug", "testing"]);
  });

  // ---- Security validation ----

  it("rejects privileged: true", () => {
    const dir = setup();
    const p = writeCompose(dir, `
services:
  web:
    image: node:20
    privileged: true
`);
    expect(() => parseComposeFile(p, { dockerSocket: false })).toThrow(ComposeValidationError);
    expect(() => parseComposeFile(p, { dockerSocket: false })).toThrow("privileged");
  });

  it("rejects network_mode: host", () => {
    const dir = setup();
    const p = writeCompose(dir, `
services:
  web:
    image: node:20
    network_mode: host
`);
    expect(() => parseComposeFile(p, { dockerSocket: false })).toThrow("network_mode: host");
  });

  it("rejects Docker socket mount when docker-socket is false", () => {
    const dir = setup();
    const p = writeCompose(dir, `
services:
  web:
    image: node:20
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
`);
    expect(() => parseComposeFile(p, { dockerSocket: false })).toThrow("Docker socket");
  });

  it("explains when the ops proxy is missing the server-side ops flag", () => {
    const dir = setup();
    const p = writeCompose(dir, `
services:
  docker-socket-proxy:
    image: tecnativa/docker-socket-proxy:0.3.0
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
`);
    expect(() => parseComposeFile(p, { dockerSocket: false }))
      .toThrow("server-created ops sessions");
  });

  it("allows Docker socket mount when docker-socket is true", () => {
    const dir = setup();
    const p = writeCompose(dir, `
services:
  web:
    image: node:20
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
`);
    const services = parseComposeFile(p, { dockerSocket: true });
    expect(services).toHaveLength(1);
  });

  it("rejects absolute bind mount paths", () => {
    const dir = setup();
    const p = writeCompose(dir, `
services:
  web:
    image: node:20
    volumes:
      - /etc/passwd:/etc/passwd
`);
    expect(() => parseComposeFile(p, { dockerSocket: false })).toThrow("Absolute bind mount");
  });

  it("rejects path traversal in volumes", () => {
    const dir = setup();
    const p = writeCompose(dir, `
services:
  web:
    image: node:20
    volumes:
      - ../secret:/data
`);
    expect(() => parseComposeFile(p, { dockerSocket: false })).toThrow("Path traversal");
  });

  it("handles long-syntax port definitions", () => {
    const dir = setup();
    const p = writeCompose(dir, `
services:
  web:
    image: node:20
    ports:
      - published: 8080
        target: 80
`);
    const services = parseComposeFile(p, { dockerSocket: false });
    expect(services[0].ports).toEqual(["8080:80"]);
  });

  it("rejects unsupported port entry types", () => {
    const dir = setup();
    const p = writeCompose(dir, `
services:
  web:
    image: node:20
    ports:
      - published: 8080
`);
    expect(() => parseComposeFile(p, { dockerSocket: false })).toThrow("unsupported ports");
  });

  it("rejects object-form volume with path traversal", () => {
    const dir = setup();
    const p = writeCompose(dir, `
services:
  web:
    image: node:20
    volumes:
      - type: bind
        source: ../secret
        target: /data
`);
    expect(() => parseComposeFile(p, { dockerSocket: false })).toThrow("Path traversal");
  });

  it("allows named volume in object form", () => {
    const dir = setup();
    const p = writeCompose(dir, `
services:
  web:
    image: node:20
    volumes:
      - type: volume
        source: mydata
        target: /data
`);
    const services = parseComposeFile(p, { dockerSocket: false });
    expect(services).toHaveLength(1);
  });

  it("throws for missing compose file", () => {
    expect(() => parseComposeFile("/nonexistent/file.yml", { dockerSocket: false }))
      .toThrow("Cannot read compose file");
  });

  it("throws for compose file without services", () => {
    const dir = setup();
    const p = writeCompose(dir, "version: '3'\n");
    expect(() => parseComposeFile(p, { dockerSocket: false })).toThrow("must have a `services` section");
  });

  it("wraps YAML parse errors as ComposeValidationError (e.g. mid-merge conflict markers)", () => {
    const dir = setup();
    // Simulates a real-world case where the user is mid-merge and the
    // compose file contains git conflict markers. The orchestrator's
    // file-change → reconcile path catches this and we want it logged as
    // a one-line ComposeValidationError, not a YAMLParseError stack.
    const p = writeCompose(dir, `services:
  web:
    image: node:20
<<<<<<< HEAD
    ports: ["5173:5173"]
=======
    ports: ["3000:3000"]
>>>>>>> feature
`);
    expect(() => parseComposeFile(p, { dockerSocket: false }))
      .toThrow(ComposeValidationError);
    expect(() => parseComposeFile(p, { dockerSocket: false }))
      .toThrow(/not valid YAML/);
  });
});

describe("generateComposeOverride", () => {
  const baseOpts = {
    sessionId: "test-session-123",
    composeConfig: { file: "docker-compose.yml", dockerSocket: false },
  };

  it("generates override with labels and network", () => {
    const override = generateComposeOverride(
      [{ name: "web", ports: ["5173:5173"] }],
      baseOpts,
    );
    expect(override).toContain("shipit-parent-session: test-session-123");
    expect(override).toContain("shipit-service-name: web");
    expect(override).toContain("shipit-session");
    expect(override).toContain("shipit-session-test-session-123");
    expect(override).toContain("NET_RAW");
  });

  it("labels manual services without adding profiles", () => {
    const override = generateComposeOverride(
      [{ name: "db", shipitPreview: "manual" }],
      baseOpts,
    );
    expect(override).toContain("shipit-preview-mode: manual");
    // Profiles are no longer used — manual services stay in the project
    // so depends_on references resolve correctly
    expect(override).not.toContain("profiles");
  });

  it("defaults services with ports to auto", () => {
    const override = generateComposeOverride(
      [{ name: "web", ports: ["3000:3000"] }],
      baseOpts,
    );
    expect(override).toContain("shipit-preview-mode: auto");
  });

  it("defaults services without ports to manual", () => {
    const override = generateComposeOverride(
      [{ name: "redis" }],
      baseOpts,
    );
    expect(override).toContain("shipit-preview-mode: manual");
  });

  it("strips ports with !reset sentinel", () => {
    const override = generateComposeOverride(
      [{ name: "web", ports: ["5173:5173"] }],
      baseOpts,
    );
    expect(override).toContain("!reset []");
  });

  it("rewrites workspace volumes when workspaceVolume is set", () => {
    const override = generateComposeOverride(
      [{ name: "web", ports: ["5173:5173"], volumes: [".:/app"] }],
      { ...baseOpts, workspaceVolume: "shipit-ws-vol", workspaceSubpath: "sessions/abc/workspace" },
    );
    expect(override).toContain("source: shipit-workspace");
    expect(override).toContain("target: /app");
    expect(override).toContain("subpath: sessions/abc/workspace");
    expect(override).toContain("shipit-workspace");
    expect(override).toContain("external: true");
  });

  it("rewrites subdirectory volumes with combined subpath", () => {
    const override = generateComposeOverride(
      [{ name: "api", volumes: ["./backend:/app"] }],
      { ...baseOpts, workspaceVolume: "shipit-ws-vol", workspaceSubpath: "sessions/abc/workspace" },
    );
    expect(override).toContain("subpath: sessions/abc/workspace/backend");
    expect(override).toContain("target: /app");
  });

  it("preserves read-only mode on rewritten volumes", () => {
    const override = generateComposeOverride(
      [{ name: "web", volumes: [".:/app:ro"] }],
      { ...baseOpts, workspaceVolume: "shipit-ws-vol" },
    );
    expect(override).toContain("read_only: true");
  });

  it("leaves non-workspace volumes untouched", () => {
    const override = generateComposeOverride(
      [{ name: "db", volumes: ["pgdata:/var/lib/postgresql/data"] }],
      { ...baseOpts, workspaceVolume: "shipit-ws-vol" },
    );
    // Non-workspace volume should pass through as-is
    expect(override).toContain("pgdata:/var/lib/postgresql/data");
  });

  it("rewrites object-form workspace volumes", () => {
    const override = generateComposeOverride(
      [{ name: "web", volumes: [{ type: "bind", source: ".", target: "/app" }] }],
      { ...baseOpts, workspaceVolume: "shipit-ws-vol", workspaceSubpath: "ws/dir" },
    );
    expect(override).toContain("source: shipit-workspace");
    expect(override).toContain("subpath: ws/dir");
  });
});

describe("writeComposeOverride", () => {
  let tmpDir: string;

  function setup() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "compose-write-"));
    return tmpDir;
  }

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes override file to .shipit directory", () => {
    const dir = setup();
    const content = "services: {}\n";
    const result = writeComposeOverride(dir, content);
    expect(result).toBe(path.join(dir, ".shipit", "compose.override.yml"));
    expect(fs.readFileSync(result, "utf-8")).toBe(content);
  });

  it("creates .shipit directory if it doesn't exist", () => {
    const dir = setup();
    writeComposeOverride(dir, "test");
    expect(fs.existsSync(path.join(dir, ".shipit"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// x-shipit-secrets parsing & override env_file injection (Phase 1, feature 087)
// ---------------------------------------------------------------------------

describe("x-shipit-secrets parsing", () => {
  let tmpDir: string;

  function setup() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "compose-secrets-"));
    return tmpDir;
  }

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeCompose(dir: string, content: string): string {
    const p = path.join(dir, "docker-compose.yml");
    fs.writeFileSync(p, content);
    return p;
  }

  it("parses string-form x-shipit-secrets", () => {
    const dir = setup();
    const p = writeCompose(dir, `
services:
  web:
    image: node:20
    x-shipit-secrets:
      - STRIPE_KEY
  api:
    image: node:20
    x-shipit-secrets:
      - DATABASE_URL
      - REDIS_URL
`);
    const services = parseComposeFile(p, { dockerSocket: false });
    const web = services.find(s => s.name === "web");
    const api = services.find(s => s.name === "api");
    expect(web?.secrets).toEqual(["STRIPE_KEY"]);
    expect(api?.secrets).toEqual(["DATABASE_URL", "REDIS_URL"]);
  });

  it("leaves secrets undefined for services that don't declare any", () => {
    const dir = setup();
    const p = writeCompose(dir, `
services:
  web:
    image: node:20
`);
    const services = parseComposeFile(p, { dockerSocket: false });
    expect(services[0].secrets).toBeUndefined();
  });

  it("rejects non-list x-shipit-secrets", () => {
    const dir = setup();
    const p = writeCompose(dir, `
services:
  web:
    image: node:20
    x-shipit-secrets:
      not: a list
`);
    expect(() => parseComposeFile(p, { dockerSocket: false }))
      .toThrow(ComposeValidationError);
  });

  it("rejects invalid env var names", () => {
    const dir = setup();
    const p = writeCompose(dir, `
services:
  web:
    image: node:20
    x-shipit-secrets:
      - "1bad-name"
`);
    expect(() => parseComposeFile(p, { dockerSocket: false }))
      .toThrow("not a valid env var name");
  });

  it("accepts object-form entries with a name (Phase 2 forward-compat)", () => {
    const dir = setup();
    const p = writeCompose(dir, `
services:
  api:
    image: node:20
    x-shipit-secrets:
      - name: DATABASE_URL
        description: PostgreSQL connection string
        required: true
`);
    const services = parseComposeFile(p, { dockerSocket: false });
    expect(services[0].secrets).toEqual(["DATABASE_URL"]);
  });

  it("silently skips object entries without a name", () => {
    const dir = setup();
    const p = writeCompose(dir, `
services:
  api:
    image: node:20
    x-shipit-secrets:
      - description: missing name field
      - VALID_NAME
`);
    const services = parseComposeFile(p, { dockerSocket: false });
    expect(services[0].secrets).toEqual(["VALID_NAME"]);
  });

  // ---- Phase 2: object-form metadata captured into secretRequirements ----

  it("populates secretRequirements with description / required / agent / source", () => {
    const dir = setup();
    const p = writeCompose(dir, `
services:
  api:
    image: node:20
    x-shipit-secrets:
      - SIMPLE_KEY
      - name: DATABASE_URL
        description: PostgreSQL connection string
        required: true
        agent: true
      - name: ANTHROPIC_API_KEY
        source: platform:claude_oauth
`);
    const services = parseComposeFile(p, { dockerSocket: false });
    const reqs = services[0].secretRequirements;
    expect(reqs).toBeDefined();
    expect(reqs).toHaveLength(3);

    const simple = reqs!.find((r) => r.name === "SIMPLE_KEY");
    expect(simple).toEqual({ name: "SIMPLE_KEY" });

    const db = reqs!.find((r) => r.name === "DATABASE_URL");
    expect(db).toEqual({
      name: "DATABASE_URL",
      description: "PostgreSQL connection string",
      required: true,
      agent: true,
    });

    const api = reqs!.find((r) => r.name === "ANTHROPIC_API_KEY");
    expect(api).toEqual({
      name: "ANTHROPIC_API_KEY",
      source: "platform:claude_oauth",
    });
  });

  it("keeps secrets and secretRequirements in lockstep (same order, same names)", () => {
    const dir = setup();
    const p = writeCompose(dir, `
services:
  api:
    image: node:20
    x-shipit-secrets:
      - FIRST
      - name: SECOND
        required: true
      - THIRD
`);
    const services = parseComposeFile(p, { dockerSocket: false });
    expect(services[0].secrets).toEqual(["FIRST", "SECOND", "THIRD"]);
    expect(services[0].secretRequirements?.map((r) => r.name)).toEqual(["FIRST", "SECOND", "THIRD"]);
  });

  it("ignores extra / unknown object fields without breaking parsing", () => {
    const dir = setup();
    const p = writeCompose(dir, `
services:
  api:
    image: node:20
    x-shipit-secrets:
      - name: WITH_EXTRA
        description: kept
        unknown_field: value
        another: 42
`);
    const services = parseComposeFile(p, { dockerSocket: false });
    expect(services[0].secretRequirements?.[0]).toEqual({
      name: "WITH_EXTRA",
      description: "kept",
    });
  });

  it("treats `required: false` (or absent) as not required", () => {
    const dir = setup();
    const p = writeCompose(dir, `
services:
  api:
    image: node:20
    x-shipit-secrets:
      - name: MAYBE
        required: false
      - name: ABSENT
`);
    const services = parseComposeFile(p, { dockerSocket: false });
    const reqs = services[0].secretRequirements!;
    expect(reqs[0].required).toBeUndefined();
    expect(reqs[1].required).toBeUndefined();
  });
});

describe("generateComposeOverride env_file injection", () => {
  const baseOpts = {
    sessionId: "test-session-123",
    composeConfig: { file: "docker-compose.yml", dockerSocket: false },
  };

  it("adds env_file reference for services with declared secrets", () => {
    const override = generateComposeOverride(
      [{ name: "api", secrets: ["DATABASE_URL"] }],
      baseOpts,
    );
    expect(override).toContain("env_file:");
    expect(override).toContain(".shipit/.env.api");
  });

  it("does not add env_file for services without secrets", () => {
    const override = generateComposeOverride(
      [{ name: "redis" }],
      baseOpts,
    );
    expect(override).not.toContain("env_file:");
  });

  it("scopes env_file per service", () => {
    const override = generateComposeOverride(
      [
        { name: "web", secrets: ["STRIPE_KEY"] },
        { name: "api", secrets: ["DATABASE_URL"] },
      ],
      baseOpts,
    );
    expect(override).toContain(".shipit/.env.web");
    expect(override).toContain(".shipit/.env.api");
  });
});

// ---------------------------------------------------------------------------
// Phase 1 follow-up: Docker-secrets mode
// ---------------------------------------------------------------------------

describe("generateComposeOverride — Docker-secrets mode", () => {
  const baseOpts = {
    sessionId: "test-session-123",
    composeConfig: { file: "docker-compose.yml", dockerSocket: false },
  };

  function dockerSecretsOpts(perService: Record<string, string[]>) {
    const allNames = [...new Set(Object.values(perService).flat())].sort();
    return {
      secretNames: allNames,
      perService,
      filePathFor: (name: string) => `/host/secrets/test-session-123/${name}`,
      entrypointWorkspacePath: ".shipit/secrets-entrypoint.sh",
    };
  }

  it("emits top-level secrets block with file references", () => {
    const override = generateComposeOverride(
      [{ name: "api", secrets: ["DATABASE_URL"] }],
      {
        ...baseOpts,
        dockerSecrets: dockerSecretsOpts({ api: ["DATABASE_URL"] }),
      },
    );
    expect(override).toContain("secrets:");
    expect(override).toContain("shipit-DATABASE_URL");
    expect(override).toContain("/host/secrets/test-session-123/DATABASE_URL");
  });

  it("emits per-service secrets references with shipit- prefix", () => {
    const override = generateComposeOverride(
      [
        { name: "web", secrets: ["STRIPE_KEY"] },
        { name: "api", secrets: ["DATABASE_URL", "STRIPE_KEY"] },
      ],
      {
        ...baseOpts,
        dockerSecrets: dockerSecretsOpts({
          web: ["STRIPE_KEY"],
          api: ["DATABASE_URL", "STRIPE_KEY"],
        }),
      },
    );
    expect(override).toContain("shipit-STRIPE_KEY");
    expect(override).toContain("shipit-DATABASE_URL");
  });

  it("does NOT emit env_file when Docker-secrets mode is active", () => {
    const override = generateComposeOverride(
      [{ name: "api", secrets: ["DATABASE_URL"] }],
      {
        ...baseOpts,
        dockerSecrets: dockerSecretsOpts({ api: ["DATABASE_URL"] }),
      },
    );
    expect(override).not.toContain("env_file");
    expect(override).not.toContain(".shipit/.env.api");
  });

  it("sets entrypoint to the wrapper script", () => {
    const override = generateComposeOverride(
      [{ name: "api", secrets: ["DATABASE_URL"] }],
      {
        ...baseOpts,
        dockerSecrets: dockerSecretsOpts({ api: ["DATABASE_URL"] }),
      },
    );
    expect(override).toContain("/shipit/secrets-entrypoint.sh");
  });

  it("does NOT add secrets / entrypoint for services without declared secrets", () => {
    const override = generateComposeOverride(
      [
        { name: "api", secrets: ["DATABASE_URL"] },
        { name: "redis" }, // no secrets
      ],
      {
        ...baseOpts,
        dockerSecrets: dockerSecretsOpts({ api: ["DATABASE_URL"] }),
      },
    );
    // Top-level secrets block exists but the redis service doesn't reference it
    const redisIdx = override.indexOf("redis:");
    const apiIdx = override.indexOf("api:");
    expect(redisIdx).toBeGreaterThan(0);
    expect(apiIdx).toBeGreaterThan(0);
    // redis service block shouldn't contain the entrypoint hijack
    const afterRedis = override.slice(redisIdx, redisIdx + 200);
    expect(afterRedis).not.toContain("secrets-entrypoint");
  });
});
