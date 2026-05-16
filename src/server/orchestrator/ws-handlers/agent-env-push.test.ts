/**
 * Unit tests for `selectAgentEnvForPush` (docs/088 mid-turn agent-env push).
 *
 * Verifies the two regimes documented in `agent-execution.ts`:
 *
 *   * Compose-less session — push the full account-level set assembled from
 *     `CredentialStore.getAllAgentEnv()` plus `collectMcpAgentEnv()` (which
 *     adds `MCP_PLATFORM_*` keys derived from `mcpOAuth` tokens).
 *   * Compose session — push `ServiceManager.getSecretsSnapshot().agentValues`
 *     verbatim. That snapshot is the merged compose-declared + MCP set, and
 *     the worker REPLACES its tracked set on every push — handing over a
 *     partial subset would clobber `agent: true` compose secrets.
 *
 * Both cases use fake stores so the test stays a pure unit; the heavyweight
 * `ContainerSessionRunner` / `ServiceManager` paths are covered separately in
 * `container-agent-wiring.test.ts` and `service-manager.test.ts`.
 */
import { describe, it, expect } from "vitest";
import type { ServiceManager } from "../service-manager.js";
import type { CredentialStore } from "../credential-store.js";
import type { OAuthTokens } from "../../shared/types/mcp-types.js";
import { selectAgentEnvForPush } from "./agent-execution.js";

interface FakeCredentialStoreOptions {
  agentEnv?: Record<string, string>;
  oauthTokens?: Record<string, OAuthTokens>;
}

/** Minimal fake — `selectAgentEnvForPush` only touches these two methods. */
function makeFakeCredentialStore(
  opts: FakeCredentialStoreOptions = {},
): Pick<CredentialStore, "getAllAgentEnv" | "getAllMcpOAuthTokens"> {
  return {
    getAllAgentEnv: () => ({ ...(opts.agentEnv ?? {}) }),
    getAllMcpOAuthTokens: () => ({ ...(opts.oauthTokens ?? {}) }),
  };
}

function makeFakeServiceManager(
  snapshotAgentValues: Record<string, string>,
): Pick<ServiceManager, "getSecretsSnapshot"> {
  return {
    getSecretsSnapshot: () => ({
      declared: [],
      missingByService: {},
      missingRequired: [],
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
        linear_oauth: { accessToken: "linear-bearer-xyz" },
        notion_oauth: { accessToken: "notion-bearer-abc" },
      },
    });
    const result = selectAgentEnvForPush({
      serviceManager: null,
      credentialStore,
    });
    expect(result.OPENAI_API_KEY).toBe("sk-test");
    expect(result.MCP_PLATFORM_LINEAR_OAUTH).toBe("linear-bearer-xyz");
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
        // Refresh-token-only entry — a real refresh failure can leave this
        // shape behind. The worker resolver has nothing to substitute, so
        // we must not push an empty MCP_PLATFORM_* key (which would shadow
        // a future successful refresh's value).
        linear_oauth: { accessToken: "" },
      },
    });
    const result = selectAgentEnvForPush({
      serviceManager: null,
      credentialStore,
    });
    expect(result.MCP_PLATFORM_LINEAR_OAUTH).toBeUndefined();
  });
});

describe("selectAgentEnvForPush — compose regime", () => {
  it("returns the snapshot's merged agentValues verbatim", () => {
    const serviceManager = makeFakeServiceManager({
      DATABASE_URL: "postgres://compose-declared",
      mcp__linear__LINEAR_API_KEY: "lin-token",
      MCP_PLATFORM_LINEAR_OAUTH: "linear-bearer-xyz",
    });
    const credentialStore = makeFakeCredentialStore({
      // CredentialStore values must be IGNORED in compose mode — the snapshot
      // is already the merged authority. If we accidentally re-merged
      // CredentialStore on top, compose-declared `agent: true` secrets that
      // override an account-level key would be clobbered.
      agentEnv: { mcp__linear__LINEAR_API_KEY: "STALE-account-value" },
    });
    const result = selectAgentEnvForPush({
      serviceManager,
      credentialStore,
    });
    expect(result).toEqual({
      DATABASE_URL: "postgres://compose-declared",
      mcp__linear__LINEAR_API_KEY: "lin-token",
      MCP_PLATFORM_LINEAR_OAUTH: "linear-bearer-xyz",
    });
  });

  it("preserves compose-declared keys that collide with account-level MCP names", () => {
    // Pathological but legal: a user declares `mcp__custom__X` in compose
    // with one value AND in account-level CredentialStore with a different
    // value. `syncSecrets()` lets compose win — we MUST preserve that here
    // by NOT consulting CredentialStore at all in compose mode.
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
    // A compose session without `agent: true` secrets gets an empty push —
    // and the account-level OPENAI_API_KEY is intentionally NOT carried
    // through. That's correct behavior because compose sessions are
    // expected to opt into agent secrets via `x-shipit-secrets` with
    // `agent: true`.
    expect(result).toEqual({});
  });
});
