import { describe, it, expect } from "vitest";
import type { ServiceManager } from "../service-manager.js";
import type { OAuthTokens } from "../../shared/types/mcp-types.js";
import type { CredentialRoute } from "../../shared/types.js";
import type { AccountAgentEnvSource } from "../session-agent-env.js";
import { selectAgentEnvForPush } from "./agent-execution.js";

interface FakeCredentialStoreOptions {
  agentEnv?: Record<string, string>;
  oauthTokens?: Record<string, OAuthTokens>;
  credentialRoutes?: CredentialRoute[];
  credentialSecrets?: Record<string, string>;
}

function makeFakeCredentialStore(
  opts: FakeCredentialStoreOptions = {},
): AccountAgentEnvSource {
  return {
    getAllAgentEnv: () => ({ ...(opts.agentEnv ?? {}) }),
    getAllMcpOAuthTokens: () => ({ ...(opts.oauthTokens ?? {}) }),
    listCredentialRoutes: () => (opts.credentialRoutes ?? []).map((r) => ({ ...r })),
    getCredentialSecret: (routeId: string) => opts.credentialSecrets?.[routeId],
  };
}

function makeFakeServiceManager(
  snapshotAgentValues: Record<string, string>,
  declaredNames: string[] = [],
): Pick<ServiceManager, "getSecretsSnapshot"> {
  return {
    getSecretsSnapshot: () => ({
      declared: declaredNames.map((name) => ({ name, services: [] })),
      missingByService: {},
      missingRequired: [],
      plugins: [],
      agentNames: Object.keys(snapshotAgentValues).sort(),
      agentValues: { ...snapshotAgentValues },
    }),
  };
}

describe("selectAgentEnvForPush — compose-less regime", () => {
  it("returns the full account-level env (non-MCP keys included)", () => {
    const credentialStore = makeFakeCredentialStore({
      agentEnv: {
        OPENAI_API_KEY: "sk-test",
        mcp__linear__LINEAR_API_KEY: "lin-token",
      },
    });
    const result = selectAgentEnvForPush({
      serviceManager: null,
      credentialStore,
    });
    expect(result).toEqual({
      OPENAI_API_KEY: "sk-test",
      mcp__linear__LINEAR_API_KEY: "lin-token",
    });
  });

  it("merges MCP_PLATFORM_* OAuth tokens on top of agentEnv", () => {
    const credentialStore = makeFakeCredentialStore({
      agentEnv: { OPENAI_API_KEY: "sk-test" },
      oauthTokens: {
        sentry_oauth: { accessToken: "sentry-bearer-xyz" },
        notion_oauth: { accessToken: "notion-bearer-abc" },
      },
    });
    const result = selectAgentEnvForPush({
      serviceManager: null,
      credentialStore,
    });
    expect(result.OPENAI_API_KEY).toBe("sk-test");
    expect(result.MCP_PLATFORM_SENTRY_OAUTH).toBe("sentry-bearer-xyz");
    expect(result.MCP_PLATFORM_NOTION_OAUTH).toBe("notion-bearer-abc");
  });

  it("returns an empty object when neither agentEnv nor mcpOAuth has entries", () => {
    const credentialStore = makeFakeCredentialStore();
    const result = selectAgentEnvForPush({
      serviceManager: null,
      credentialStore,
    });
    expect(result).toEqual({});
  });

  it("excludes OAuth tokens with no accessToken", () => {
    const credentialStore = makeFakeCredentialStore({
      oauthTokens: {
        notion_oauth: { accessToken: "" },
      },
    });
    const result = selectAgentEnvForPush({
      serviceManager: null,
      credentialStore,
    });
    expect(result.MCP_PLATFORM_NOTION_OAUTH).toBeUndefined();
  });
});

describe("selectAgentEnvForPush — compose regime", () => {
  it("returns the snapshot's merged agentValues verbatim", () => {
    const serviceManager = makeFakeServiceManager({
      DATABASE_URL: "postgres://compose-declared",
      mcp__linear__LINEAR_API_KEY: "lin-token",
      MCP_PLATFORM_NOTION_OAUTH: "notion-bearer-xyz",
    });
    const credentialStore = makeFakeCredentialStore({
      agentEnv: { mcp__linear__LINEAR_API_KEY: "STALE-account-value" },
    });
    const result = selectAgentEnvForPush({
      serviceManager,
      credentialStore,
    });
    expect(result).toEqual({
      DATABASE_URL: "postgres://compose-declared",
      mcp__linear__LINEAR_API_KEY: "lin-token",
      MCP_PLATFORM_NOTION_OAUTH: "notion-bearer-xyz",
    });
  });

  it("preserves compose-declared keys that collide with account-level MCP names", () => {
    const serviceManager = makeFakeServiceManager({
      mcp__custom__KEY: "from-compose",
    });
    const credentialStore = makeFakeCredentialStore({
      agentEnv: { mcp__custom__KEY: "from-account-level" },
    });
    const result = selectAgentEnvForPush({
      serviceManager,
      credentialStore,
    });
    expect(result.mcp__custom__KEY).toBe("from-compose");
  });

  it("returns an empty object when the snapshot is empty", () => {
    const serviceManager = makeFakeServiceManager({});
    const credentialStore = makeFakeCredentialStore({
      agentEnv: { OPENAI_API_KEY: "sk-should-be-ignored" },
    });
    const result = selectAgentEnvForPush({
      serviceManager,
      credentialStore,
    });
    expect(result).toEqual({});
  });
});

describe("revoked service credentials never ride a stale compose snapshot", () => {
  it("drops a catalogue credential the store no longer holds", () => {
    const serviceManager = makeFakeServiceManager({
      DATABASE_URL: "postgres://db",
      DEEPSEEK_API_KEY: "sk-revoked",
    });
    const credentialStore = makeFakeCredentialStore();
    expect(selectAgentEnvForPush({ serviceManager, credentialStore })).toEqual({
      DATABASE_URL: "postgres://db",
    });
  });

  it("keeps one the store still holds", () => {
    const now = Date.now();
    const route: CredentialRoute = {
      id: "cred_1", serviceId: "deepseek", billingMode: "key", via: "string",
      label: "DeepSeek key", isPrimary: true, priority: 0, status: "ready",
      createdAt: now, updatedAt: now,
    };
    const serviceManager = makeFakeServiceManager({ DEEPSEEK_API_KEY: "sk-live" });
    const credentialStore = makeFakeCredentialStore({
      credentialRoutes: [route],
      credentialSecrets: { cred_1: "sk-live" },
    });
    expect(selectAgentEnvForPush({ serviceManager, credentialStore })).toEqual({
      DEEPSEEK_API_KEY: "sk-live",
      SHIPIT_CREDENTIAL_CRED_1: "sk-live",
    });
  });

  it("keeps one the COMPOSE FILE declares, which is the documented per-repo override", () => {
    const serviceManager = makeFakeServiceManager(
      { DEEPSEEK_API_KEY: "sk-repo-owned" },
      ["DEEPSEEK_API_KEY"],
    );
    const credentialStore = makeFakeCredentialStore();
    expect(selectAgentEnvForPush({ serviceManager, credentialStore })).toEqual({
      DEEPSEEK_API_KEY: "sk-repo-owned",
    });
  });
});
