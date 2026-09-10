import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  resolveSecrets,
  collectMcpAgentEnv,
  renderAgentEnvBody,
  writeServiceEnvFilesToRoot,
  removeSessionServiceEnvDir,
  removeSessionSecretsDir,
  writeAgentEnvFile,
  writeIsolatedSecretFiles,
  composeSecretFilePath,
  stageSecretsEntrypoint,
} from "./secret-resolver.js";
import type { ComposeService } from "./compose-generator.js";

describe("collectMcpAgentEnv (docs/088)", () => {
  function stub(opts: {
    agentEnv?: Record<string, string>;
    mcpOAuth?: Record<string, { accessToken: string }>;
  }) {
    return {
      getAllAgentEnv: () => opts.agentEnv ?? {},
      getAllMcpOAuthTokens: () => opts.mcpOAuth ?? {},
    };
  }

  it("returns only mcp__* entries from CredentialStore.agentEnv", () => {
    expect(
      collectMcpAgentEnv(
        stub({
          agentEnv: {
            OPENAI_API_KEY: "sk-test",
            mcp__linear__LINEAR_API_KEY: "lin_api_abc",
            mcp__sentry__SENTRY_AUTH_TOKEN: "sntrys_xyz",
          },
        }),
      ),
    ).toEqual({
      mcp__linear__LINEAR_API_KEY: "lin_api_abc",
      mcp__sentry__SENTRY_AUTH_TOKEN: "sntrys_xyz",
    });
  });

  it("skips empty values and returns {} when there are no mcp__* keys", () => {
    expect(collectMcpAgentEnv(stub({ agentEnv: { OPENAI_API_KEY: "sk" } }))).toEqual({});
    expect(collectMcpAgentEnv(stub({ agentEnv: { mcp__a__B: "" } }))).toEqual({});
  });

  it("is independent of resolveSecrets — does not consult compose declarations", () => {
    const resolution = resolveSecrets({ services: [], userSecrets: {} });
    expect(resolution.agentValues).toEqual({});
    expect(collectMcpAgentEnv(stub({ agentEnv: { mcp__x__KEY: "v" } }))).toEqual({
      mcp__x__KEY: "v",
    });
  });

  describe("MCP OAuth tokens → MCP_PLATFORM_* env vars (docs/088 Phase 2)", () => {
    it("maps each stored mcpOAuth source to MCP_PLATFORM_<UPPER>", () => {
      expect(
        collectMcpAgentEnv(
          stub({
            mcpOAuth: {
              sentry_oauth: { accessToken: "sntry_at" },
              notion_oauth: { accessToken: "ntn_at" },
            },
          }),
        ),
      ).toEqual({
        MCP_PLATFORM_SENTRY_OAUTH: "sntry_at",
        MCP_PLATFORM_NOTION_OAUTH: "ntn_at",
      });
    });

    it("merges mcp__* secrets with MCP_PLATFORM_* tokens in one map", () => {
      expect(
        collectMcpAgentEnv(
          stub({
            agentEnv: { mcp__sentry__SENTRY_AUTH_TOKEN: "sntrys_xyz" },
            mcpOAuth: { notion_oauth: { accessToken: "ntn_at" } },
          }),
        ),
      ).toEqual({
        mcp__sentry__SENTRY_AUTH_TOKEN: "sntrys_xyz",
        MCP_PLATFORM_NOTION_OAUTH: "ntn_at",
      });
    });

    it("skips OAuth entries with no accessToken (defensive)", () => {
      expect(
        collectMcpAgentEnv(
          stub({
            mcpOAuth: {
              // @ts-expect-error — exercising defensive guard
              broken: { refreshToken: "rt_only" },
            },
          }),
        ),
      ).toEqual({});
    });
  });
});

describe("renderAgentEnvBody (docs/088)", () => {
  it("renders sorted KEY=VALUE lines and a ShipIt header", () => {
    const body = renderAgentEnvBody({ B_KEY: "2", A_KEY: "1" });
    expect(body).toContain("A_KEY=1");
    expect(body).toContain("B_KEY=2");
    expect(body.indexOf("A_KEY")).toBeLessThan(body.indexOf("B_KEY"));
  });

  it("returns an empty string for an empty map", () => {
    expect(renderAgentEnvBody({})).toBe("");
  });
});

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

describe("resolveSecrets — Phase 2 extended syntax", () => {
  it("flags missing-required secrets via missingRequiredByService", () => {
    const services: ComposeService[] = [
      {
        name: "api",
        secrets: ["DATABASE_URL", "OPTIONAL_KEY"],
        secretRequirements: [
          { name: "DATABASE_URL", required: true },
          { name: "OPTIONAL_KEY" },
        ],
      },
    ];
    const result = resolveSecrets({ services, userSecrets: {} });
    expect(result.missingByService.api).toEqual(["DATABASE_URL", "OPTIONAL_KEY"]);
    expect(result.missingRequiredByService.api).toEqual(["DATABASE_URL"]);
  });

  it("does not flag a satisfied required secret", () => {
    const services: ComposeService[] = [
      {
        name: "api",
        secrets: ["DATABASE_URL"],
        secretRequirements: [{ name: "DATABASE_URL", required: true }],
      },
    ];
    const result = resolveSecrets({
      services,
      userSecrets: { DATABASE_URL: "postgres://x" },
    });
    expect(result.missingRequiredByService).toEqual({});
    expect(result.missingByService).toEqual({});
  });

  it("aggregates declared secrets across services with merged metadata", () => {
    const services: ComposeService[] = [
      {
        name: "web",
        secrets: ["STRIPE_KEY"],
        secretRequirements: [{ name: "STRIPE_KEY", description: "Stripe publishable key" }],
      },
      {
        name: "api",
        secrets: ["STRIPE_KEY", "DATABASE_URL"],
        secretRequirements: [
          { name: "STRIPE_KEY", required: true },
          { name: "DATABASE_URL", description: "Postgres URL", required: true },
        ],
      },
    ];
    const result = resolveSecrets({ services, userSecrets: {} });
    expect(result.declared).toHaveLength(2);

    const stripe = result.declared.find((d) => d.name === "STRIPE_KEY");
    expect(stripe).toBeDefined();
    expect(stripe?.required).toBe(true);
    expect(stripe?.description).toBe("Stripe publishable key");
    expect(stripe?.services).toEqual(["api", "web"]);

    const db = result.declared.find((d) => d.name === "DATABASE_URL");
    expect(db?.services).toEqual(["api"]);
    expect(db?.required).toBe(true);
  });

  it("preserves agent flag in declared aggregate", () => {
    const services: ComposeService[] = [
      {
        name: "api",
        secrets: ["DATABASE_URL"],
        secretRequirements: [{ name: "DATABASE_URL", agent: true }],
      },
    ];
    const result = resolveSecrets({ services, userSecrets: {} });
    expect(result.declared[0].agent).toBe(true);
  });

  it("preserves source field in declared aggregate", () => {
    const services: ComposeService[] = [
      {
        name: "api",
        secrets: ["ANTHROPIC_API_KEY"],
        secretRequirements: [{ name: "ANTHROPIC_API_KEY", source: "platform:claude_oauth" }],
      },
    ];
    const result = resolveSecrets({ services, userSecrets: {} });
    expect(result.declared[0].source).toBe("platform:claude_oauth");
  });

  it("falls back to legacy string-only secrets when secretRequirements absent", () => {
    const services: ComposeService[] = [
      { name: "api", secrets: ["STRIPE_KEY"] },
    ];
    const result = resolveSecrets({
      services,
      userSecrets: { STRIPE_KEY: "sk_test" },
    });
    expect(result.declared).toEqual([
      { name: "STRIPE_KEY", services: ["api"] },
    ]);
    expect(result.missingRequiredByService).toEqual({});
  });

  it("declared list is sorted alphabetically by name", () => {
    const services: ComposeService[] = [
      { name: "svc", secrets: ["ZED", "ALPHA", "MIDDLE"] },
    ];
    const result = resolveSecrets({ services, userSecrets: {} });
    expect(result.declared.map((d) => d.name)).toEqual(["ALPHA", "MIDDLE", "ZED"]);
  });
});

describe("resolveSecrets — Phase 3 agent injection", () => {
  it("collects values for entries marked agent: true", () => {
    const services: ComposeService[] = [
      {
        name: "api",
        secrets: ["DATABASE_URL", "STRIPE_KEY"],
        secretRequirements: [
          { name: "DATABASE_URL", agent: true },
          { name: "STRIPE_KEY" },
        ],
      },
    ];
    const result = resolveSecrets({
      services,
      userSecrets: { DATABASE_URL: "postgres://u:p@db:5432/app", STRIPE_KEY: "sk_test" },
    });
    expect(result.agentValues).toEqual({ DATABASE_URL: "postgres://u:p@db:5432/app" });
    expect(result.agentEnv).toContain("DATABASE_URL=postgres://u:p@db:5432/app");
    expect(result.agentEnv).not.toContain("STRIPE_KEY");
  });

  it("excludes agent: true entries with no value", () => {
    const services: ComposeService[] = [
      {
        name: "api",
        secrets: ["DATABASE_URL"],
        secretRequirements: [{ name: "DATABASE_URL", agent: true, required: true }],
      },
    ];
    const result = resolveSecrets({ services, userSecrets: {} });
    expect(result.agentValues).toEqual({});
    expect(result.agentEnv).toBe("");
    expect(result.missingRequiredByService.api).toEqual(["DATABASE_URL"]);
  });

  it("returns empty agentEnv string when no agent entries exist", () => {
    const services: ComposeService[] = [
      { name: "api", secrets: ["STRIPE_KEY"] },
    ];
    const result = resolveSecrets({
      services,
      userSecrets: { STRIPE_KEY: "sk_test" },
    });
    expect(result.agentValues).toEqual({});
    expect(result.agentEnv).toBe("");
  });

  it("de-duplicates when the same name is agent: true in multiple services", () => {
    const services: ComposeService[] = [
      {
        name: "api",
        secrets: ["DATABASE_URL"],
        secretRequirements: [{ name: "DATABASE_URL", agent: true }],
      },
      {
        name: "worker",
        secrets: ["DATABASE_URL"],
        secretRequirements: [{ name: "DATABASE_URL", agent: true }],
      },
    ];
    const result = resolveSecrets({
      services,
      userSecrets: { DATABASE_URL: "postgres://x" },
    });
    expect(result.agentValues).toEqual({ DATABASE_URL: "postgres://x" });
    const lines = result.agentEnv.trim().split("\n").filter((l) => !l.startsWith("#"));
    expect(lines).toEqual(["DATABASE_URL=postgres://x"]);
  });
});

describe("writeAgentEnvFile", () => {
  let tmpDir: string;

  function setup() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-env-"));
    const dir = path.join(tmpDir, "workspace");
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  const stateOf = (dir: string) => path.resolve(dir, "..", "state");

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes .env.agent into the session state dir, outside the clone", () => {
    const dir = setup();
    const written = writeAgentEnvFile({
      workspaceDir: dir,
      body: "DATABASE_URL=postgres://x\n",
    });
    expect(written).toBe(path.join("..", "state", ".env.agent"));
    const contents = fs.readFileSync(path.join(stateOf(dir), ".env.agent"), "utf-8");
    expect(contents).toContain("DATABASE_URL=postgres://x");
    expect(fs.existsSync(path.join(dir, ".shipit"))).toBe(false);
  });

  it("removes .env.agent when body is empty", () => {
    const dir = setup();
    const state = stateOf(dir);
    fs.mkdirSync(state, { recursive: true });
    fs.writeFileSync(path.join(state, ".env.agent"), "OLD=1\n");
    const result = writeAgentEnvFile({ workspaceDir: dir, body: "" });
    expect(result).toBeNull();
    expect(fs.existsSync(path.join(state, ".env.agent"))).toBe(false);
  });

  it("creates the state dir if missing when body is non-empty", () => {
    const dir = setup();
    expect(fs.existsSync(stateOf(dir))).toBe(false);
    writeAgentEnvFile({ workspaceDir: dir, body: "X=1\n" });
    expect(fs.existsSync(path.join(stateOf(dir), ".env.agent"))).toBe(true);
  });

  it("is a no-op when body is empty and file doesn't exist", () => {
    const dir = setup();
    expect(() => writeAgentEnvFile({ workspaceDir: dir, body: "" })).not.toThrow();
  });

  it("refuses a clone that is not <sessionDir>/workspace", () => {
    const flat = fs.mkdtempSync(path.join(os.tmpdir(), "agent-env-flat-"));
    try {
      expect(() => writeAgentEnvFile({ workspaceDir: flat, body: "X=1\n" })).toThrow(
        /<sessionDir>\/workspace/,
      );
    } finally {
      fs.rmSync(flat, { recursive: true, force: true });
    }
  });
});

describe("resolveSecrets — source: platform:* no longer forwarded (docs/184)", () => {
  it("resolves a platform-sourced entry from userSecrets[name]", () => {
    const services: ComposeService[] = [
      {
        name: "orchestrator",
        secrets: ["GITHUB_TOKEN"],
        secretRequirements: [
          { name: "GITHUB_TOKEN", source: "platform:github_token" },
        ],
      },
    ];
    const result = resolveSecrets({
      services,
      userSecrets: { GITHUB_TOKEN: "ghp_user_supplied" },
    });
    expect(result.perServiceEnv.orchestrator).toContain("GITHUB_TOKEN=ghp_user_supplied");
    expect(result.missingByService).toEqual({});
  });

  it("treats a platform-sourced entry with no matching user secret as missing", () => {
    const services: ComposeService[] = [
      {
        name: "api",
        secrets: ["ANTHROPIC_API_KEY"],
        secretRequirements: [
          { name: "ANTHROPIC_API_KEY", source: "platform:claude_oauth", required: true },
        ],
      },
    ];
    const result = resolveSecrets({ services, userSecrets: {} });
    expect(result.perServiceEnv.api).not.toContain("ANTHROPIC_API_KEY=");
    expect(result.missingByService.api).toEqual(["ANTHROPIC_API_KEY"]);
    expect(result.missingRequiredByService.api).toEqual(["ANTHROPIC_API_KEY"]);
  });

  it("reports a warning (one per entry) for each unhonored platform source", () => {
    const services: ComposeService[] = [
      {
        name: "orchestrator",
        secrets: ["ANTHROPIC_API_KEY", "GITHUB_TOKEN", "SENTRY_DSN"],
        secretRequirements: [
          { name: "ANTHROPIC_API_KEY", source: "platform:claude_oauth" },
          { name: "GITHUB_TOKEN", source: "platform:github_token" },
          { name: "SENTRY_DSN" },
        ],
      },
    ];
    const result = resolveSecrets({ services, userSecrets: {} });
    expect(result.platformSourceWarnings).toEqual([
      { service: "orchestrator", name: "ANTHROPIC_API_KEY", source: "platform:claude_oauth" },
      { service: "orchestrator", name: "GITHUB_TOKEN", source: "platform:github_token" },
    ]);
  });

  it("emits no warning when no entry declares a platform source", () => {
    const services: ComposeService[] = [
      { name: "api", secrets: ["DATABASE_URL"] },
    ];
    const result = resolveSecrets({ services, userSecrets: { DATABASE_URL: "postgres://x" } });
    expect(result.platformSourceWarnings).toEqual([]);
  });

  it("regression: a real GitHub token is never injected from platform state", () => {
    const services: ComposeService[] = [
      {
        name: "evil",
        secrets: ["GITHUB_TOKEN"],
        secretRequirements: [
          { name: "GITHUB_TOKEN", source: "platform:github_token" },
        ],
      },
    ];
    const noSecret = resolveSecrets({ services, userSecrets: {} });
    expect(noSecret.perServiceEnv.evil).not.toContain("GITHUB_TOKEN=");
    expect(noSecret.missingByService.evil).toEqual(["GITHUB_TOKEN"]);

    const withSecret = resolveSecrets({
      services,
      userSecrets: { GITHUB_TOKEN: "ghp_user_dedicated" },
    });
    expect(withSecret.perServiceEnv.evil).toContain("GITHUB_TOKEN=ghp_user_dedicated");
  });

  it("still preserves the source field on the declared aggregate (parsed, not honored)", () => {
    const services: ComposeService[] = [
      {
        name: "api",
        secrets: ["GITHUB_TOKEN"],
        secretRequirements: [
          { name: "GITHUB_TOKEN", source: "platform:github_token" },
        ],
      },
    ];
    const result = resolveSecrets({ services, userSecrets: {} });
    expect(result.declared[0].source).toBe("platform:github_token");
  });
});

describe("perServiceValues (Phase 1 follow-up)", () => {
  it("captures resolved key-value pairs per service", () => {
    const services: ComposeService[] = [
      { name: "web", secrets: ["STRIPE_KEY"] },
      { name: "api", secrets: ["DATABASE_URL", "STRIPE_KEY"] },
    ];
    const result = resolveSecrets({
      services,
      userSecrets: { STRIPE_KEY: "sk", DATABASE_URL: "postgres://x" },
    });
    expect(result.perServiceValues.web).toEqual({ STRIPE_KEY: "sk" });
    expect(result.perServiceValues.api).toEqual({
      DATABASE_URL: "postgres://x",
      STRIPE_KEY: "sk",
    });
  });

  it("omits services that didn't declare any secret with a value", () => {
    const services: ComposeService[] = [
      { name: "api", secrets: ["MISSING_KEY"] },
    ];
    const result = resolveSecrets({ services, userSecrets: {} });
    expect(result.perServiceValues.api).toEqual({});
  });
});

describe("writeIsolatedSecretFiles (Phase 1 follow-up)", () => {
  let tmpDir: string;

  function setup() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "isolated-secrets-"));
    return tmpDir;
  }

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes one file per secret under <rootDir>/<sessionId>/", () => {
    const dir = setup();
    const result = writeIsolatedSecretFiles({
      rootDir: dir,
      sessionId: "abc123",
      values: { DATABASE_URL: "postgres://x", STRIPE_KEY: "sk_test" },
    });
    expect(result.written).toEqual(["DATABASE_URL", "STRIPE_KEY"]);
    expect(fs.readFileSync(path.join(dir, "abc123", "DATABASE_URL"), "utf-8")).toBe("postgres://x");
    expect(fs.readFileSync(path.join(dir, "abc123", "STRIPE_KEY"), "utf-8")).toBe("sk_test");
  });

  it("sweeps stale files that aren't in the new values map", () => {
    const dir = setup();
    const sessionDir = path.join(dir, "s1");
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, "REMOVED_KEY"), "old");
    fs.writeFileSync(path.join(sessionDir, "KEPT_KEY"), "old");

    writeIsolatedSecretFiles({
      rootDir: dir,
      sessionId: "s1",
      values: { KEPT_KEY: "new" },
    });

    expect(fs.existsSync(path.join(sessionDir, "REMOVED_KEY"))).toBe(false);
    expect(fs.readFileSync(path.join(sessionDir, "KEPT_KEY"), "utf-8")).toBe("new");
  });

  it("creates the session directory if missing", () => {
    const dir = setup();
    expect(fs.existsSync(path.join(dir, "fresh"))).toBe(false);
    writeIsolatedSecretFiles({
      rootDir: dir,
      sessionId: "fresh",
      values: { X: "1" },
    });
    expect(fs.existsSync(path.join(dir, "fresh"))).toBe(true);
  });

  it("creates files with restrictive permissions", () => {
    const dir = setup();
    writeIsolatedSecretFiles({
      rootDir: dir,
      sessionId: "s",
      values: { K: "v" },
    });
    const stat = fs.statSync(path.join(dir, "s", "K"));
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("returns an empty written list when values is empty", () => {
    const dir = setup();
    const result = writeIsolatedSecretFiles({
      rootDir: dir,
      sessionId: "empty",
      values: {},
    });
    expect(result.written).toEqual([]);
  });
});

describe("composeSecretFilePath (Phase 1 follow-up)", () => {
  it("uses hostDir when provided (orchestrator-in-container)", () => {
    expect(composeSecretFilePath({
      rootDir: "/internal/secrets",
      hostDir: "/host/shipit-secrets",
      sessionId: "abc",
      name: "DATABASE_URL",
    })).toBe("/host/shipit-secrets/abc/DATABASE_URL");
  });

  it("falls back to rootDir when hostDir is omitted (orchestrator-on-host)", () => {
    expect(composeSecretFilePath({
      rootDir: "/var/shipit/secrets",
      sessionId: "abc",
      name: "DATABASE_URL",
    })).toBe("/var/shipit/secrets/abc/DATABASE_URL");
  });
});

describe("stageSecretsEntrypoint (planning#287)", () => {
  let tmpDir: string;

  function setup() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "entrypoint-staging-"));
    return tmpDir;
  }

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function bakedWrapper(dir: string): string {
    const src = path.join(dir, "baked.sh");
    fs.writeFileSync(src, "#!/bin/sh\nexec \"$@\"\n", { mode: 0o755 });
    return src;
  }

  it("copies the wrapper to <rootDir>/_entrypoint/ and returns that path", () => {
    const dir = setup();
    const root = path.join(dir, "secrets");
    const hostPath = stageSecretsEntrypoint({
      rootDir: root,
      sessionId: "abc123",
      sourcePath: bakedWrapper(dir),
    });
    const staged = path.join(root, "_entrypoint", "secrets-entrypoint.sh");
    expect(hostPath).toBe(staged);
    expect(fs.readFileSync(staged, "utf-8")).toContain("exec \"$@\"");
    expect(fs.statSync(staged).mode & 0o777).toBe(0o755);
  });

  it("maps the returned path through hostDir (orchestrator-in-container)", () => {
    const dir = setup();
    const root = path.join(dir, "secrets");
    const hostPath = stageSecretsEntrypoint({
      rootDir: root,
      hostDir: "/var/lib/shipit/secrets",
      sessionId: "abc123",
      sourcePath: bakedWrapper(dir),
    });
    expect(hostPath).toBe("/var/lib/shipit/secrets/_entrypoint/secrets-entrypoint.sh");
    expect(fs.existsSync(path.join(root, "_entrypoint", "secrets-entrypoint.sh"))).toBe(true);
  });

  it("survives a session's secret sweep and teardown", () => {
    const dir = setup();
    const root = path.join(dir, "secrets");
    const staged = stageSecretsEntrypoint({
      rootDir: root,
      sessionId: "abc123",
      sourcePath: bakedWrapper(dir),
    })!;
    writeIsolatedSecretFiles({ rootDir: root, sessionId: "abc123", values: { K: "v" } });
    writeIsolatedSecretFiles({ rootDir: root, sessionId: "abc123", values: {} });
    fs.rmSync(path.join(root, "abc123"), { recursive: true, force: true });
    expect(fs.existsSync(staged)).toBe(true);
  });

  it("is idempotent across reconciles and refreshes a changed wrapper", () => {
    const dir = setup();
    const root = path.join(dir, "secrets");
    const src = bakedWrapper(dir);
    stageSecretsEntrypoint({ rootDir: root, sessionId: "s1", sourcePath: src });
    fs.writeFileSync(src, "#!/bin/sh\n# v2\nexec \"$@\"\n", { mode: 0o755 });
    const staged = stageSecretsEntrypoint({ rootDir: root, sessionId: "s2", sourcePath: src })!;
    expect(fs.readFileSync(staged, "utf-8")).toContain("# v2");
    expect(fs.readdirSync(path.join(root, "_entrypoint"))).toEqual(["secrets-entrypoint.sh"]);
  });

  it("returns null (rather than throwing) when the source is missing", () => {
    const dir = setup();
    const root = path.join(dir, "secrets");
    expect(stageSecretsEntrypoint({
      rootDir: root,
      sessionId: "s1",
      sourcePath: path.join(dir, "does-not-exist.sh"),
    })).toBeNull();
    expect(fs.readdirSync(path.join(root, "_entrypoint"))).toEqual([]);
  });
});

describe("writeServiceEnvFilesToRoot (docs/183)", () => {
  let tmpDir: string;

  function setup() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "service-env-183-"));
    const workspaceDir = path.join(tmpDir, "workspace");
    const rootDir = path.join(tmpDir, "service-env");
    fs.mkdirSync(workspaceDir, { recursive: true });
    return { workspaceDir, rootDir };
  }

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes env files under <root>/<sessionId>/ and returns absolute paths", () => {
    const { workspaceDir, rootDir } = setup();
    const { serviceEnvFiles, sessionDir } = writeServiceEnvFilesToRoot({
      rootDir,
      sessionId: "sess1",
      workspaceDir,
      perServiceEnv: {
        web: "STRIPE_KEY=sk_test\n",
        api: "DATABASE_URL=postgres://x\n",
      },
    });

    expect(sessionDir).toBe(path.join(rootDir, "sess1"));
    expect(serviceEnvFiles.web).toBe(path.join(rootDir, "sess1", ".env.web"));
    expect(serviceEnvFiles.api).toBe(path.join(rootDir, "sess1", ".env.api"));
    expect(fs.readFileSync(serviceEnvFiles.web, "utf-8")).toContain("STRIPE_KEY=sk_test");
    expect(fs.readFileSync(serviceEnvFiles.api, "utf-8")).toContain("DATABASE_URL=postgres://x");
  });

  it("does NOT create .shipit/.env.<service> in the workspace", () => {
    const { workspaceDir, rootDir } = setup();
    writeServiceEnvFilesToRoot({
      rootDir,
      sessionId: "sess1",
      workspaceDir,
      perServiceEnv: { web: "STRIPE_KEY=sk_test\n" },
    });
    expect(fs.existsSync(path.join(workspaceDir, ".shipit", ".env.web"))).toBe(false);
  });


  it("removes stale external .env.<svc> files for services that no longer declare secrets", () => {
    const { workspaceDir, rootDir } = setup();
    const sessionDir = path.join(rootDir, "sess1");
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, ".env.removed"), "STALE=1\n");

    writeServiceEnvFilesToRoot({
      rootDir,
      sessionId: "sess1",
      workspaceDir,
      perServiceEnv: { web: "NEW=1\n" },
    });

    expect(fs.existsSync(path.join(sessionDir, ".env.removed"))).toBe(false);
    expect(fs.existsSync(path.join(sessionDir, ".env.web"))).toBe(true);
  });

  it("throws when the root resolves inside the workspace (fail closed)", () => {
    const { workspaceDir } = setup();
    const insideRoot = path.join(workspaceDir, "service-env");
    expect(() =>
      writeServiceEnvFilesToRoot({
        rootDir: insideRoot,
        sessionId: "sess1",
        workspaceDir,
        perServiceEnv: { web: "X=1\n" },
      }),
    ).toThrow(/inside the agent workspace/);
    expect(fs.existsSync(insideRoot)).toBe(false);
  });

  it("throws when the root IS the workspace", () => {
    const { workspaceDir } = setup();
    expect(() =>
      writeServiceEnvFilesToRoot({
        rootDir: workspaceDir,
        sessionId: "sess1",
        workspaceDir,
        perServiceEnv: { web: "X=1\n" },
      }),
    ).toThrow(/inside the agent workspace/);
  });

  it("follows symlinks: a root symlinked to inside the workspace is rejected", () => {
    const { workspaceDir, rootDir } = setup();
    const insideTarget = path.join(workspaceDir, "leaky-service-env");
    fs.mkdirSync(insideTarget, { recursive: true });
    fs.symlinkSync(insideTarget, rootDir);

    expect(() =>
      writeServiceEnvFilesToRoot({
        rootDir,
        sessionId: "sess1",
        workspaceDir,
        perServiceEnv: { web: "X=1\n" },
      }),
    ).toThrow(/inside the agent workspace/);
    expect(fs.existsSync(path.join(insideTarget, "sess1"))).toBe(false);
  });

  it("removeSessionServiceEnvDir drops the session dir and is a no-op when absent", () => {
    const { rootDir } = setup();
    const sessionDir = path.join(rootDir, "sess1");
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, ".env.web"), "SECRET=1\n");

    removeSessionServiceEnvDir({ rootDir, sessionId: "sess1" });
    expect(fs.existsSync(sessionDir)).toBe(false);

    expect(() => removeSessionServiceEnvDir({ rootDir, sessionId: "sess1" })).not.toThrow();
    expect(() => removeSessionServiceEnvDir({ rootDir, sessionId: "" })).not.toThrow();
    expect(fs.existsSync(rootDir)).toBe(true);
  });

  it("removeSessionSecretsDir drops the Docker-secrets session dir and is a no-op when absent/empty", () => {
    const { rootDir } = setup();
    const sessionDir = path.join(rootDir, "sess1");
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, "DATABASE_URL"), "postgres://x");

    removeSessionSecretsDir({ internalDir: rootDir, sessionId: "sess1" });
    expect(fs.existsSync(sessionDir)).toBe(false);

    expect(() => removeSessionSecretsDir({ internalDir: rootDir, sessionId: "sess1" })).not.toThrow();
    expect(() => removeSessionSecretsDir({ internalDir: rootDir, sessionId: "" })).not.toThrow();
    expect(fs.existsSync(rootDir)).toBe(true);
  });
});
