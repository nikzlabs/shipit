import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  resolveSecrets,
  collectMcpAgentEnv,
  renderAgentEnvBody,
  writePerServiceEnvFiles,
  writeServiceEnvFilesToRoot,
  sweepWorkspaceServiceEnvFiles,
  writeAgentEnvFile,
  writeIsolatedSecretFiles,
  composeSecretFilePath,
} from "./secret-resolver.js";
import type { ComposeService } from "./compose-generator.js";

describe("collectMcpAgentEnv (docs/088)", () => {
  // Stub helper covering both methods the new signature touches.
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
    // resolveSecrets with no services produces no agentValues; collectMcpAgentEnv
    // still surfaces the account-level mcp__* keys.
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
              linear_oauth: { accessToken: "lin_at" },
              notion_oauth: { accessToken: "ntn_at" },
            },
          }),
        ),
      ).toEqual({
        MCP_PLATFORM_LINEAR_OAUTH: "lin_at",
        MCP_PLATFORM_NOTION_OAUTH: "ntn_at",
      });
    });

    it("merges mcp__* secrets with MCP_PLATFORM_* tokens in one map", () => {
      expect(
        collectMcpAgentEnv(
          stub({
            agentEnv: { mcp__sentry__SENTRY_AUTH_TOKEN: "sntrys_xyz" },
            mcpOAuth: { linear_oauth: { accessToken: "lin_at" } },
          }),
        ),
      ).toEqual({
        mcp__sentry__SENTRY_AUTH_TOKEN: "sntrys_xyz",
        MCP_PLATFORM_LINEAR_OAUTH: "lin_at",
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

// ---------------------------------------------------------------------------
// Phase 2: extended syntax — required, descriptions, declared aggregation
// ---------------------------------------------------------------------------

describe("resolveSecrets — Phase 2 extended syntax", () => {
  it("flags missing-required secrets via missingRequiredByService", () => {
    const services: ComposeService[] = [
      {
        name: "api",
        secrets: ["DATABASE_URL", "OPTIONAL_KEY"],
        secretRequirements: [
          { name: "DATABASE_URL", required: true },
          { name: "OPTIONAL_KEY" }, // not required → not in missingRequired
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
          { name: "STRIPE_KEY", required: true }, // required wins (OR'd)
          { name: "DATABASE_URL", description: "Postgres URL", required: true },
        ],
      },
    ];
    const result = resolveSecrets({ services, userSecrets: {} });
    expect(result.declared).toHaveLength(2);

    const stripe = result.declared.find((d) => d.name === "STRIPE_KEY");
    expect(stripe).toBeDefined();
    expect(stripe?.required).toBe(true); // OR'd across services
    expect(stripe?.description).toBe("Stripe publishable key"); // first non-empty wins
    expect(stripe?.services).toEqual(["api", "web"]); // sorted

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
    // Older callers / shorthand-only compose files without object form still work.
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

// ---------------------------------------------------------------------------
// Phase 3: agent: true → agentEnv / agentValues
// ---------------------------------------------------------------------------

describe("resolveSecrets — Phase 3 agent injection", () => {
  it("collects values for entries marked agent: true", () => {
    const services: ComposeService[] = [
      {
        name: "api",
        secrets: ["DATABASE_URL", "STRIPE_KEY"],
        secretRequirements: [
          { name: "DATABASE_URL", agent: true },
          { name: "STRIPE_KEY" }, // not agent → service-only
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
    // Still surfaces in missingRequired even though no agent value emitted.
    expect(result.missingRequiredByService.api).toEqual(["DATABASE_URL"]);
  });

  it("returns empty agentEnv string when no agent entries exist", () => {
    const services: ComposeService[] = [
      { name: "api", secrets: ["STRIPE_KEY"] }, // legacy form, no agent flag
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
    // env file body has one DATABASE_URL line, not two
    const lines = result.agentEnv.trim().split("\n").filter((l) => !l.startsWith("#"));
    expect(lines).toEqual(["DATABASE_URL=postgres://x"]);
  });
});

describe("writeAgentEnvFile", () => {
  let tmpDir: string;

  function setup() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-env-"));
    return tmpDir;
  }

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes .shipit/.env.agent with the given body", () => {
    const dir = setup();
    const written = writeAgentEnvFile({
      workspaceDir: dir,
      body: "DATABASE_URL=postgres://x\n",
    });
    expect(written).toBe(".shipit/.env.agent");
    const contents = fs.readFileSync(path.join(dir, ".shipit/.env.agent"), "utf-8");
    expect(contents).toContain("DATABASE_URL=postgres://x");
  });

  it("removes .env.agent when body is empty", () => {
    const dir = setup();
    const shipit = path.join(dir, ".shipit");
    fs.mkdirSync(shipit);
    fs.writeFileSync(path.join(shipit, ".env.agent"), "OLD=1\n");
    const result = writeAgentEnvFile({ workspaceDir: dir, body: "" });
    expect(result).toBeNull();
    expect(fs.existsSync(path.join(shipit, ".env.agent"))).toBe(false);
  });

  it("creates .shipit/ if missing when body is non-empty", () => {
    const dir = setup();
    expect(fs.existsSync(path.join(dir, ".shipit"))).toBe(false);
    writeAgentEnvFile({ workspaceDir: dir, body: "X=1\n" });
    expect(fs.existsSync(path.join(dir, ".shipit", ".env.agent"))).toBe(true);
  });

  it("is a no-op when body is empty and file doesn't exist", () => {
    const dir = setup();
    expect(() => writeAgentEnvFile({ workspaceDir: dir, body: "" })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// docs/184: source: platform:* is no longer forwarded
// ---------------------------------------------------------------------------

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
    // Resolves from the user secret store under the declared name, NOT from
    // any platform credential.
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
          { name: "SENTRY_DSN" }, // no source → no warning
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
    // A hostile repo declares source: platform:github_token. With NO user
    // secret of that name set, the service gets nothing — the user's real
    // token is never forwarded.
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

    // With a same-named user secret set, the service gets the user-supplied
    // value instead — never a platform identity.
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

// ---------------------------------------------------------------------------
// Phase 1 follow-up: Docker-secrets isolation
// ---------------------------------------------------------------------------

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
    // perServiceValues[api] exists but is empty
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
    // Check user RW, no group/other (lower 9 bits = 0o600).
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

describe("writeServiceEnvFilesToRoot (docs/183)", () => {
  let tmpDir: string;

  function setup() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "service-env-183-"));
    // Workspace and external root are siblings — root is outside the workspace.
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

  it("sweeps a pre-183 workspace .shipit/.env.<service> leak but keeps .env.agent", () => {
    const { workspaceDir, rootDir } = setup();
    const shipit = path.join(workspaceDir, ".shipit");
    fs.mkdirSync(shipit, { recursive: true });
    fs.writeFileSync(path.join(shipit, ".env.web"), "LEAKED=1\n");
    fs.writeFileSync(path.join(shipit, ".env.agent"), "FROM_AGENT=1\n");

    writeServiceEnvFilesToRoot({
      rootDir,
      sessionId: "sess1",
      workspaceDir,
      perServiceEnv: { web: "STRIPE_KEY=sk_test\n" },
    });

    // The leaked service env file is removed from the workspace…
    expect(fs.existsSync(path.join(shipit, ".env.web"))).toBe(false);
    // …but the agent env file is left alone (Phase 3 owns it).
    expect(fs.existsSync(path.join(shipit, ".env.agent"))).toBe(true);
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
    // Nothing was written.
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
});

describe("sweepWorkspaceServiceEnvFiles (docs/183)", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("removes .env.<svc> files but preserves .env.agent; no-op when .shipit missing", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sweep-183-"));
    // No .shipit dir yet — must not throw.
    expect(() => sweepWorkspaceServiceEnvFiles(tmpDir)).not.toThrow();

    const shipit = path.join(tmpDir, ".shipit");
    fs.mkdirSync(shipit);
    fs.writeFileSync(path.join(shipit, ".env.web"), "A=1\n");
    fs.writeFileSync(path.join(shipit, ".env.api"), "B=1\n");
    fs.writeFileSync(path.join(shipit, ".env.agent"), "AGENT=1\n");

    sweepWorkspaceServiceEnvFiles(tmpDir);

    expect(fs.existsSync(path.join(shipit, ".env.web"))).toBe(false);
    expect(fs.existsSync(path.join(shipit, ".env.api"))).toBe(false);
    expect(fs.existsSync(path.join(shipit, ".env.agent"))).toBe(true);
  });
});
