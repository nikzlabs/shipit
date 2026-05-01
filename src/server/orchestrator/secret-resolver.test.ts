import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { resolveSecrets, writePerServiceEnvFiles } from "./secret-resolver.js";
import type { ComposeService } from "./compose-generator.js";

describe("resolveSecrets", () => {
  it("returns empty resolution when no service declares secrets", () => {
    const services: ComposeService[] = [
      { name: "web" },
      { name: "db" },
    ];
    const result = resolveSecrets({ services, userSecrets: { STRIPE_KEY: "sk_test" } });
    expect(result.perServiceEnv).toEqual({});
    expect(result.missingByService).toEqual({});
    expect(result.declaredNames).toEqual([]);
  });

  it("produces a per-service env file body when secrets are declared", () => {
    const services: ComposeService[] = [
      { name: "web", secrets: ["STRIPE_KEY"] },
    ];
    const result = resolveSecrets({
      services,
      userSecrets: { STRIPE_KEY: "sk_test_123", UNUSED: "x" },
    });
    expect(result.perServiceEnv.web).toContain("STRIPE_KEY=sk_test_123");
    // Unused user secrets shouldn't appear in any service env file
    expect(result.perServiceEnv.web).not.toContain("UNUSED");
    expect(result.declaredNames).toEqual(["STRIPE_KEY"]);
  });

  it("scopes secrets per service — db doesn't see web's secrets", () => {
    const services: ComposeService[] = [
      { name: "web", secrets: ["STRIPE_KEY"] },
      { name: "api", secrets: ["DATABASE_URL", "REDIS_URL"] },
    ];
    const result = resolveSecrets({
      services,
      userSecrets: {
        STRIPE_KEY: "sk_test",
        DATABASE_URL: "postgres://x",
        REDIS_URL: "redis://x",
      },
    });
    expect(result.perServiceEnv.web).toContain("STRIPE_KEY=");
    expect(result.perServiceEnv.web).not.toContain("DATABASE_URL");
    expect(result.perServiceEnv.web).not.toContain("REDIS_URL");
    expect(result.perServiceEnv.api).toContain("DATABASE_URL=");
    expect(result.perServiceEnv.api).toContain("REDIS_URL=");
    expect(result.perServiceEnv.api).not.toContain("STRIPE_KEY");
  });

  it("reports missing secrets per service without failing", () => {
    const services: ComposeService[] = [
      { name: "api", secrets: ["DATABASE_URL", "REDIS_URL"] },
    ];
    const result = resolveSecrets({
      services,
      userSecrets: { DATABASE_URL: "postgres://x" },
    });
    expect(result.missingByService.api).toEqual(["REDIS_URL"]);
    expect(result.perServiceEnv.api).toContain("DATABASE_URL=");
    expect(result.perServiceEnv.api).not.toContain("REDIS_URL=");
  });

  it("treats empty-string user values as missing (defends against blank fields)", () => {
    const services: ComposeService[] = [
      { name: "api", secrets: ["DATABASE_URL"] },
    ];
    const result = resolveSecrets({
      services,
      userSecrets: { DATABASE_URL: "" },
    });
    expect(result.missingByService.api).toEqual(["DATABASE_URL"]);
  });

  it("sorts keys alphabetically in env files for deterministic output", () => {
    const services: ComposeService[] = [
      { name: "api", secrets: ["ZED", "ALPHA", "MIDDLE"] },
    ];
    const result = resolveSecrets({
      services,
      userSecrets: { ZED: "z", ALPHA: "a", MIDDLE: "m" },
    });
    const lines = result.perServiceEnv.api.trim().split("\n").filter(l => !l.startsWith("#"));
    expect(lines).toEqual(["ALPHA=a", "MIDDLE=m", "ZED=z"]);
  });

  it("de-duplicates within a service if the user repeats a name", () => {
    const services: ComposeService[] = [
      { name: "api", secrets: ["DATABASE_URL", "DATABASE_URL"] },
    ];
    const result = resolveSecrets({
      services,
      userSecrets: { DATABASE_URL: "postgres://x" },
    });
    const matches = result.perServiceEnv.api.match(/DATABASE_URL=/g);
    expect(matches?.length).toBe(1);
  });

  it("skips multi-line values (env_file format can't express them)", () => {
    const services: ComposeService[] = [
      { name: "api", secrets: ["MULTILINE"] },
    ];
    const result = resolveSecrets({
      services,
      userSecrets: { MULTILINE: "line1\nline2" },
    });
    expect(result.perServiceEnv.api).not.toContain("MULTILINE=");
  });

  it("collects unique declared names across services", () => {
    const services: ComposeService[] = [
      { name: "web", secrets: ["STRIPE_KEY"] },
      { name: "api", secrets: ["DATABASE_URL", "STRIPE_KEY"] },
    ];
    const result = resolveSecrets({ services, userSecrets: {} });
    expect(result.declaredNames).toEqual(["DATABASE_URL", "STRIPE_KEY"]);
  });
});

describe("writePerServiceEnvFiles", () => {
  let tmpDir: string;

  function setup() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "secret-resolver-"));
    return tmpDir;
  }

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes files into .shipit/ keyed by service name", () => {
    const dir = setup();
    const written = writePerServiceEnvFiles({
      workspaceDir: dir,
      perServiceEnv: {
        web: "STRIPE_KEY=sk_test\n",
        api: "DATABASE_URL=postgres://x\n",
      },
    });
    expect(written).toContain(".shipit/.env.web");
    expect(written).toContain(".shipit/.env.api");
    expect(fs.readFileSync(path.join(dir, ".shipit/.env.web"), "utf-8")).toContain("STRIPE_KEY=sk_test");
    expect(fs.readFileSync(path.join(dir, ".shipit/.env.api"), "utf-8")).toContain("DATABASE_URL=postgres://x");
  });

  it("removes stale .env.<svc> files for services that no longer declare secrets", () => {
    const dir = setup();
    const shipit = path.join(dir, ".shipit");
    fs.mkdirSync(shipit);
    fs.writeFileSync(path.join(shipit, ".env.removed"), "STALE=1\n");
    fs.writeFileSync(path.join(shipit, ".env.web"), "OLD=1\n");

    writePerServiceEnvFiles({
      workspaceDir: dir,
      perServiceEnv: { web: "NEW=1\n" },
    });

    // Stale file removed
    expect(fs.existsSync(path.join(shipit, ".env.removed"))).toBe(false);
    // web kept and overwritten
    expect(fs.readFileSync(path.join(shipit, ".env.web"), "utf-8")).toContain("NEW=1");
  });

  it("preserves .env.agent (Phase 3 owns it)", () => {
    const dir = setup();
    const shipit = path.join(dir, ".shipit");
    fs.mkdirSync(shipit);
    fs.writeFileSync(path.join(shipit, ".env.agent"), "FROM_AGENT=1\n");

    writePerServiceEnvFiles({
      workspaceDir: dir,
      perServiceEnv: { web: "NEW=1\n" },
    });

    expect(fs.existsSync(path.join(shipit, ".env.agent"))).toBe(true);
  });

  it("creates .shipit/ if missing", () => {
    const dir = setup();
    expect(fs.existsSync(path.join(dir, ".shipit"))).toBe(false);
    writePerServiceEnvFiles({
      workspaceDir: dir,
      perServiceEnv: { web: "X=1\n" },
    });
    expect(fs.existsSync(path.join(dir, ".shipit", ".env.web"))).toBe(true);
  });
});
