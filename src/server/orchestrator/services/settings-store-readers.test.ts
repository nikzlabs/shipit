import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { allServices, getMode } from "../../shared/catalogue/index.js";
import type { ModelSelection } from "../../shared/catalogue/index.js";
import { MCP_OAUTH_PROVIDERS } from "../mcp-oauth-providers.js";
import { ALL_SETTINGS } from "../../shared/settings-catalogue/index.js";
import type { McpStdioServerConfig } from "../../shared/types/mcp-types.js";
import { CredentialStore } from "../credential-store.js";
import { ProviderAccountManager } from "../provider-account-manager.js";
import { addMcpServer } from "./mcp.js";
import {
  getSettingForAgent,
  listSettingsForAgent,
  type SettingDetailEntry,
} from "./settings-read.js";
import type { SettingsReadDeps } from "./settings-read-deps.js";

/**
 * Req 3 through the readers: what a setting a panel of its own owns is actually
 * set to. Every case below seeds a value that DIFFERS from the declaration's
 * default, so a reader that reported the default instead of the stored value
 * fails it — which is the one failure worth a guard, because the agent states
 * what it reads to the user as fact.
 */

const REPO_URL = "https://github.com/acme/widget.git";
const SESSION = "s1";

let tmpDir: string;
let credentialStore: CredentialStore;
let providerAccountManager: ProviderAccountManager;
let hosts: string[];
let repo: { allowAgentMerge?: boolean; colorIndex?: number } | undefined;
let secrets: Record<string, string>;

/** A catalogue row, resolved at run time: a test naming a model id rots. */
function someSelection(): ModelSelection {
  for (const service of allServices()) {
    for (const mode of service.modes) {
      const model = getMode(service.id, mode.kind)?.models[0];
      if (model) return { serviceId: service.id, billingMode: mode.kind, modelId: model.id };
    }
  }
  throw new Error("The catalogue has no model to pin in this fixture");
}

function deps(over: Partial<SettingsReadDeps> = {}): SettingsReadDeps {
  return {
    agentRegistry: { list: () => [] } as unknown as SettingsReadDeps["agentRegistry"],
    appWorkspaceDir: tmpDir,
    sessionManager: {
      get: (id: string) => (id === SESSION ? { id, remoteUrl: REPO_URL } : undefined),
    } as unknown as SettingsReadDeps["sessionManager"],
    credentialStore,
    providerAccountManager,
    egressAllowlistStore: {
      listHosts: () => [...hosts],
      listSuppressedDefaults: () => [],
      getGlobalEnabled: () => true,
      getSessionOverride: () => null,
      resolveContained: () => true,
    } as unknown as SettingsReadDeps["egressAllowlistStore"],
    repoStore: { get: (url: string) => (url === REPO_URL ? repo : undefined) },
    secretStore: {
      loadSecretNames: () => Object.keys(secrets),
      loadSecrets: () => ({ ...secrets }),
    },
    readReleaseChannel: async () => "edge",
    ...over,
  };
}

async function detail(key: string, over: Partial<SettingsReadDeps> = {}): Promise<SettingDetailEntry> {
  return getSettingForAgent(deps(over), SESSION, key);
}

/** Every instance of an item-addressed setting, as address → one-line value. */
async function itemDisplays(key: string): Promise<Record<string, string>> {
  const entry = await detail(key);
  const out: Record<string, string> = {};
  for (const item of entry.items ?? []) out[item.address] = item.display;
  return out;
}

const selection = someSelection();

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-store-readers-"));
  credentialStore = new CredentialStore(path.join(tmpDir, "credentials"));
  providerAccountManager = new ProviderAccountManager({
    credentialsDir: path.join(tmpDir, "credentials"),
    credentialStore,
  });
  hosts = [];
  repo = { allowAgentMerge: false, colorIndex: undefined };
  secrets = {};
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/*
  "Every declaration has a reader" used to be two runtime checks here. It is now
  a TYPE: `BESPOKE_READERS` and `OWN_ROUTE_READERS` are keyed by
  `BespokeSettingKey` / `OwnRouteSettingKey`, derived from the catalogue itself
  (`settings-catalogue/registry.ts`). A declaration added without a reader is a
  missing property and a reader for a setting nobody declared is an unknown one,
  both at compile time — so the reader tables are a projection of the registry
  rather than a second registry beside it (req 7). Restating that at run time
  would only pin what `tsc` already refuses to compile.
*/


describe("roles", () => {
  beforeEach(() => {
    credentialStore.setRole("deep-dive", {
      name: "deep-dive",
      description: "Reads widely before answering.",
      prompt: "Take your time.",
      params: {
        kind: "pinned",
        harnessId: "codex",
        serviceId: selection.serviceId,
        billingMode: selection.billingMode,
        modelId: selection.modelId,
        reasoningEffort: "high",
      },
    });
  });

  it("names the roles that exist, not an empty list", async () => {
    const entry = await detail("roles");
    expect(entry.value).toEqual(expect.arrayContaining(["deep-dive", "reviewer"]));
  });

  it("reads each stored field of a role back, addressed by its name", async () => {
    expect((await itemDisplays("roles[].harness"))["deep-dive"]).toBe("codex");
    expect((await itemDisplays("roles[].reasoningEffort"))["deep-dive"]).toBe("high");
    expect((await itemDisplays("roles[].description"))["deep-dive"]).toBe(
      "Reads widely before answering.",
    );
    expect((await itemDisplays("roles[].prompt"))["deep-dive"]).toBe("Take your time.");
    expect((await itemDisplays("roles[].name"))["deep-dive"]).toBe("deep-dive");
  });

  it("reads the model tuple, which is the unit a change to it moves", async () => {
    const entry = await detail("roles[].model");
    const item = entry.items?.find((i) => i.address === "deep-dive");
    expect(item?.value).toEqual(selection);
  });

  it("says the reserved reviewer pins nothing, rather than reading it as unset", async () => {
    const entry = await detail("roles[].model");
    const reviewer = entry.items?.find((i) => i.address === "reviewer");
    expect(reviewer?.value).toBeNull();
    expect(reviewer?.notes?.join(" ")).toContain("reviewer candidate slots");
  });

  it("carries why a role cannot run, so the agent says why and not only what (req 3)", async () => {
    const entry = await detail("roles[].model");
    const item = entry.items?.find((i) => i.address === "deep-dive");
    // No credential is configured in this fixture, so the role resolves to
    // nothing — the explanation the existing role view already computes.
    expect(item?.notes?.join(" ")).toMatch(/cannot run|out of quota|edited/);
  });

  it("does not repeat back a role NAME that is shaped like a credential", async () => {
    // A role name is checked only for being non-blank and short enough
    // (`services/role-settings.ts:200`), so it is the same hole the secret
    // names were, reached through the same door: an item's address.
    const canary = new URL("https://host.test/path");
    canary.username = "user";
    canary.password = "SENTINEL";
    credentialStore.setRole(canary.toString(), {
      name: canary.toString(),
      params: { kind: "pinned", harnessId: "codex", ...selection },
    });
    const everything = JSON.stringify([
      await detail("roles"),
      await detail("roles[].name"),
      await detail("roles[].model"),
    ]);
    expect(everything).not.toContain("SENTINEL");
    expect(everything).not.toContain("host.test");
    // The roles that ARE named still come back.
    expect((await detail("roles")).value).toEqual(expect.arrayContaining(["deep-dive"]));
  });

  it("reports unreadable, never an empty role list, with no credential store", async () => {
    const entry = await detail("roles", { credentialStore: undefined });
    expect(entry).toMatchObject({ readable: false, unreadableReason: "read_failed" });
  });

  it("emits an address that resolves back to the role it came from (req 1)", async () => {
    // `requireStorableName` checks blankness and length and does not normalize
    // (`services/role-settings.ts:200`), so a padded name is storable beside the
    // bare one — and `getRole` looks both up exactly. An address the read
    // advertises has to name the item it was taken from.
    credentialStore.setRole(" helper ", {
      name: " helper ",
      params: { kind: "pinned", harnessId: "codex", ...selection },
    });
    credentialStore.setRole("helper", {
      name: "helper",
      params: { kind: "pinned", harnessId: "claude", ...selection },
    });

    const entry = await detail("roles[].harness");
    const addresses = (entry.items ?? []).map((i) => i.address);
    expect(new Set(addresses).size).toBe(addresses.length);
    for (const address of addresses) {
      expect(credentialStore.getRole(address)?.name).toBe(address);
    }
    // The bare one is still named, and reads as its OWN stored value.
    expect((await itemDisplays("roles[].harness")).helper).toBe("claude");
    // The padded one is named by nothing, and the read says one was left out.
    expect(entry.notes?.join(" ")).toContain("1 stored instance is not listed");
  });
});

describe("reviewer slots", () => {
  it("reads a pinned slot back and leaves the other automatic", async () => {
    credentialStore.setReviewerPin("first", { ...selection, reasoningEffort: "high" });
    const models = await detail("reviewers[].model");
    expect(models.items?.find((i) => i.address === "first")?.value).toEqual(selection);
    expect(models.items?.find((i) => i.address === "second")?.value).toBeNull();
    expect((await itemDisplays("reviewers[].reasoningEffort")).first).toBe("high");
  });

  it("says a slot whose pin cannot run supplies no reviewer, promising no fallback", async () => {
    // `resolveSlotPlan` returns no target for a pinned slot it cannot run, so a
    // note claiming ShipIt picks one automatically would send an agent
    // diagnosing a blocked review down the wrong path.
    credentialStore.setReviewerPin("first", selection);
    const entry = await detail("reviewers[].model");
    const note = entry.items?.find((i) => i.address === "first")?.notes?.join(" ") ?? "";
    expect(note).toContain("supplies no reviewer");
    expect(note).not.toMatch(/automatic/i);
  });

  it("carries the models and levels this install can actually run (req 3)", async () => {
    // "What it has to become" needs the option set, which a declaration's type
    // cannot hold — so `get` resolves it from the same registry the dialog's
    // own picker offers.
    const entry = await getSettingForAgent(
      deps({
        agentRegistry: {
          list: () => [
            {
              id: "codex",
              name: "Codex",
              installed: true,
              hasRunnableModels: true,
              eligibleModels: [{ serviceId: selection.serviceId, modelId: selection.modelId }],
              capabilities: { reasoning: { label: "Effort", options: [{ value: "high", label: "High" }] } },
            },
            { id: "claude", name: "Claude", installed: false, hasRunnableModels: false, eligibleModels: [] },
          ],
        } as unknown as SettingsReadDeps["agentRegistry"],
      }),
      SESSION,
      "roles[].model",
    );
    const live = entry.live as { harnesses: { harnessId: string; reasoningLevels?: unknown[] }[] };
    // Only what this install can run: an uninstalled harness is not an option.
    expect(live.harnesses.map((h) => h.harnessId)).toEqual(["codex"]);
    expect(live.harnesses[0]?.reasoningLevels).toEqual([{ value: "high", label: "High" }]);
  });

  it("names both slots and whether each is pinned", async () => {
    credentialStore.setReviewerPin("first", selection);
    const entry = await detail("reviewers");
    expect(entry.value).toEqual([
      { slot: "first", source: "pinned" },
      { slot: "second", source: "auto" },
    ]);
  });
});

describe("credential routing", () => {
  beforeEach(() => {
    credentialStore.upsertCredentialRouteWithSecret(
      {
        id: "route-fixture",
        serviceId: selection.serviceId,
        billingMode: selection.billingMode,
        via: "string",
        status: "ready",
        priority: 0,
        isPrimary: true,
        label: "Second key",
        createdAt: 0,
        updatedAt: 0,
      },
      "secret-SENTINEL",
    );
  });

  const modeKey = (): string => `${selection.serviceId}:${selection.billingMode}`;

  it("reads the stored selection mode, not the shipped default", async () => {
    credentialStore.setSelectionMode(selection.serviceId, selection.billingMode, "balanced");
    expect((await itemDisplays("services.accountSelectionMode"))[modeKey()]).toBe("balanced");
  });

  it("reads both failover cutoffs, not the shipped 90", async () => {
    credentialStore.setFailoverCutoffs(selection.serviceId, selection.billingMode, {
      session: 55,
      weekly: 70,
    });
    expect((await itemDisplays("services.failoverCutoff.session"))[modeKey()]).toBe("55");
    expect((await itemDisplays("services.failoverCutoff.weekly"))[modeKey()]).toBe("70");
  });

  it("reads the order of a mode's credentials, by id", async () => {
    const entry = await detail("services.credentials");
    expect(entry.items?.find((i) => i.address === modeKey())?.value).toEqual(["route-fixture"]);
  });

  it("reads a credential's name, and reports its secret as configured and never as text", async () => {
    expect((await itemDisplays("services.credentials[].label"))["route-fixture"]).toBe("Second key");
    const secret = await detail("services.credentials[].secret");
    expect(secret.items?.find((i) => i.address === "route-fixture")?.display).toBe("configured");
    expect(JSON.stringify(secret)).not.toContain("secret-SENTINEL");
  });

  it("has no mode entry for a service with no credential at all", async () => {
    const entry = await detail("services.accountSelectionMode");
    expect(entry.items?.map((i) => i.address)).toEqual([modeKey()]);
  });
});

describe("provider accounts", () => {
  it("reads a connected account as configured and an unfinished one as not", async () => {
    const service = allServices().find((s) =>
      s.modes.some((m) => m.kind === "sub" && m.credentials.some((c) => c.via === "account")));
    // Asserted rather than skipped: a catalogue with no account-backed service
    // would otherwise turn this into a test that cannot fail.
    expect(service).toBeDefined();
    const connected = providerAccountManager.create(service!.id, "Work plan");
    const serviceId = service!.id;
    providerAccountManager.create(serviceId, "Personal plan");
    providerAccountManager.setAccountStatus(serviceId, connected.id, "ready");

    const connection = await itemDisplays("services.providerAccounts[].connection");
    expect(connection[`${serviceId}:${connected.id}`]).toBe("configured");
    expect(Object.values(connection)).toContain("not configured");
    expect((await itemDisplays("services.providerAccounts[].label"))[`${serviceId}:${connected.id}`])
      .toBe("Work plan");

    const order = await detail("services.providerAccounts");
    expect(order.items?.find((i) => i.address === serviceId)?.value).toContain(connected.id);
  });
});

describe("MCP servers", () => {
  const TOKEN = "SENTINEL-CREDENTIAL-MUST-NOT-BE-EMITTED";

  /**
   * Assembled part by part rather than written as one literal: a
   * `scheme://user:pass@host` string in the source reads as a real credential
   * to any scanner, whatever the value happens to be.
   */
  function poisonedUrl(host: string, secret: string): string {
    const url = new URL(`https://${host}`);
    url.username = "svc";
    url.password = secret;
    url.pathname = `/v1/${secret}`;
    url.search = `api_key=${secret}`;
    return url.toString();
  }

  beforeEach(() => {
    addMcpServer(
      credentialStore,
      {
        name: "notion",
        type: "http",
        url: poisonedUrl("mcp.example.com", TOKEN),
        headers: { Authorization: `Bearer ${TOKEN}` },
        enabled: false,
      },
      {},
    );
    addMcpServer(
      credentialStore,
      {
        name: "local",
        type: "stdio",
        command: "npx",
        args: [`--token=${TOKEN}`],
        env: { API_KEY: TOKEN },
        npmPackage: "some-mcp",
        enabled: true,
      },
      {},
    );
  });

  it("names the servers and reads each one's transport and enabled flag", async () => {
    expect((await detail("mcp.servers")).value).toEqual(["local", "notion"]);
    expect(await itemDisplays("mcp.servers[].type")).toEqual({ local: "stdio", notion: "http" });
    // Stored false against a declared default of true: a reader falling back to
    // the default would report this server as enabled.
    expect(await itemDisplays("mcp.servers[].enabled")).toEqual({ local: "on", notion: "off" });
  });

  it("emits a URL's host and nothing else of it", async () => {
    const entry = await detail("mcp.servers[].url");
    expect(entry.items?.find((i) => i.address === "notion")?.value).toEqual({
      scheme: "https",
      host: "mcp.example.com",
    });
  });

  it("reports the credential-bearing fields as configured only", async () => {
    expect((await itemDisplays("mcp.servers[].args")).local).toBe("configured");
    expect((await itemDisplays("mcp.servers[].env")).local).toBe("configured");
    expect((await itemDisplays("mcp.servers[].headers")).notion).toBe("configured");
    expect((await itemDisplays("mcp.servers[].command")).local).toBe("configured");
    expect((await itemDisplays("mcp.servers[].npmPackage")).local).toBe("configured");
  });

  it("reports an env bag whose secret was never stored as NOT configured", async () => {
    // The panel writes a `$secret:` reference for every key row even where the
    // user left the value blank, so the config alone says a name exists and not
    // that the server can start — which is the state an agent is asked about.
    addMcpServer(
      credentialStore,
      {
        name: "blank",
        type: "stdio",
        command: "npx",
        env: { API_KEY: "$secret:mcp__blank__API_KEY" },
        enabled: true,
      },
      {},
    );
    const entry = await detail("mcp.servers[].env");
    const item = entry.items?.find((i) => i.address === "blank");
    expect(item?.display).toBe("not configured");
    expect(item?.notes?.join(" ")).toContain("1 of 1 entry");
  });

  it("reports arguments whose secret was never stored as NOT configured, as the runtime does", async () => {
    // A provider's token is routinely passed as an argument, which is why this
    // field is a `secretBag` at all — and `resolveMcpServer` substitutes `args`
    // exactly as it does `env`, omitting the whole server when one reference is
    // unresolved. A settings read answering "configured" here is the surface
    // that exists to explain a blocker failing to see it (req 3). That the two
    // layers agree on one configuration is pinned across the layer boundary, in
    // `integration_tests/agent-settings-access.test.ts`.
    const config: McpStdioServerConfig = {
      name: "demo",
      type: "stdio",
      command: "npx",
      args: ["--token", "$secret:mcp__demo__TOKEN"],
      enabled: true,
    };
    addMcpServer(credentialStore, config, {});

    const item = (await detail("mcp.servers[].args")).items?.find((i) => i.address === "demo");
    expect(item?.display).toBe("not configured");
    expect(item?.notes?.join(" ")).toContain("1 of 2 arguments");
  });

  it("reports arguments as configured once the secret they refer to is stored", async () => {
    const config: McpStdioServerConfig = {
      name: "armed",
      type: "stdio",
      command: "npx",
      args: ["--token", "$secret:mcp__armed__TOKEN"],
      enabled: true,
    };
    addMcpServer(credentialStore, config, { mcp__armed__TOKEN: TOKEN });

    const entry = await detail("mcp.servers[].args");
    expect(entry.items?.find((i) => i.address === "armed")?.display).toBe("configured");
    expect(JSON.stringify(entry)).not.toContain(TOKEN);
  });

  it("does not call a reference ShipIt does not store a blocker, and says it cannot tell", async () => {
    // The worker AUGMENTS its own `process.env` with the pushed set rather than
    // replacing it, and the pushed set is a Compose snapshot this read has no
    // handle on — so `$secret:PATH` and `$secret:PROJECT_TOKEN` both resolve at
    // run time for all this read knows. Reporting them as "cannot start" states
    // a blocker the server does not have, which is req 3 pointing the wrong way.
    addMcpServer(
      credentialStore,
      {
        name: "inherited",
        type: "stdio",
        command: "npx",
        args: ["--token", "$secret:PROJECT_TOKEN"],
        enabled: true,
      },
      {},
    );

    const item = (await detail("mcp.servers[].args")).items?.find((i) => i.address === "inherited");
    expect(item?.display).toBe("configured");
    expect(item?.notes?.join(" ")).toContain("this read cannot say which");
    expect(item?.notes?.join(" ")).not.toContain("cannot start");
  });

  it("still calls a reference ShipIt DOES store a blocker when its value is absent", async () => {
    // The two ShipIt stores the value of are `mcp__<server>__<KEY>` and an MCP
    // OAuth `$platform:` source, and the panel writes nothing else — so the
    // state req 3 exists for stays a definite answer.
    addMcpServer(
      credentialStore,
      {
        name: "mixed",
        type: "stdio",
        command: "npx",
        args: ["--token", "$secret:mcp__mixed__TOKEN", "--host", "$secret:PROJECT_HOST"],
        enabled: true,
      },
      {},
    );

    const item = (await detail("mcp.servers[].args")).items?.find((i) => i.address === "mixed");
    expect(item?.display).toBe("not configured");
    expect(item?.notes?.join(" ")).toContain("cannot start until it is set");
    // …and the other thing wrong with the field is still said. Two references
    // fail for two different reasons and one branch would report one of them.
    expect(item?.notes?.join(" ")).toContain("this read cannot say which");
  });

  it("says both things when one argument carries a stored reference AND an unknown one", async () => {
    addMcpServer(
      credentialStore,
      {
        name: "both",
        type: "stdio",
        command: "npx",
        args: ["$secret:mcp__both__TOKEN@$secret:PROJECT_HOST"],
        enabled: true,
      },
      {},
    );

    const item = (await detail("mcp.servers[].args")).items?.find((i) => i.address === "both");
    expect(item?.display).toBe("not configured");
    expect(item?.notes?.join(" ")).toContain("cannot start until it is set");
    expect(item?.notes?.join(" ")).toContain("this read cannot say which");
  });

  it("reports an env bag as configured once the secret it refers to is stored", async () => {
    addMcpServer(
      credentialStore,
      {
        name: "filled",
        type: "stdio",
        command: "npx",
        env: { API_KEY: "$secret:mcp__filled__API_KEY" },
        enabled: true,
      },
      { mcp__filled__API_KEY: TOKEN },
    );
    const entry = await detail("mcp.servers[].env");
    expect(entry.items?.find((i) => i.address === "filled")?.display).toBe("configured");
    expect(JSON.stringify(entry)).not.toContain(TOKEN);
  });

  it("names every MCP OAuth provider and reads none of them as connected", async () => {
    const entry = await detail("mcp.oauthProvider");
    expect(entry.items?.map((i) => i.address).sort()).toEqual(
      MCP_OAUTH_PROVIDERS.map((p) => p.id).sort(),
    );
    expect(entry.items?.every((i) => i.display === "not configured")).toBe(true);
  });

  it("reads a connected MCP OAuth provider as configured", async () => {
    const provider = MCP_OAUTH_PROVIDERS[0];
    expect(provider).toBeDefined();
    credentialStore.setMcpOAuthTokens(provider!.id, { accessToken: TOKEN });
    const entry = await detail("mcp.oauthProvider");
    expect(entry.items?.find((i) => i.address === provider!.id)?.display).toBe("configured");
    expect(JSON.stringify(entry)).not.toContain(TOKEN);
  });
});

describe("the pasted-token integrations and the voice credentials", () => {
  it("reports GitHub and Linear as configured once a token is stored, never the token", async () => {
    credentialStore.setGithubToken("token-SENTINEL");
    credentialStore.setLinearToken("api-SENTINEL");
    const github = await detail("integrations.github.connection");
    const linear = await detail("integrations.linear.credential");
    expect(github.display).toBe("configured");
    expect(linear.display).toBe("configured");
    expect(JSON.stringify([github, linear])).not.toMatch(/SENTINEL/);
  });

  it("reports them as not configured when nothing is stored", async () => {
    expect((await detail("integrations.github.connection")).display).toBe("not configured");
    expect((await detail("integrations.linear.credential")).display).toBe("not configured");
  });

  it("reads which speech providers have a key, one entry per provider", async () => {
    credentialStore.setVoiceProviderKey("openai", "key-SENTINEL");
    const keys = await itemDisplays("voice.providerKey");
    expect(keys.openai).toBe("configured");
    expect(Object.values(keys)).toContain("not configured");
  });

  it("reports the webhook's two halves separately", async () => {
    credentialStore.setVoiceWebhook("https://hooks.example.com/notes", "token-SENTINEL");
    const url = await detail("voice.webhook.url");
    const token = await detail("voice.webhook.token");
    expect(url.display).toBe("configured");
    expect(token.display).toBe("configured");
    expect(JSON.stringify([url, token])).not.toContain("hooks.example.com");
    expect(JSON.stringify([url, token])).not.toContain("token-SENTINEL");
  });
});

describe("the global egress allowlist", () => {
  it("reads the hosts that are allowed, addressed by host", async () => {
    hosts = ["api.example.com", ".internal.example.org"];
    const entry = await detail("network.egress.hosts");
    // The shipped defaults are part of the list, so this is containment and not
    // equality — pinning the default list here would break on every change to it.
    expect(entry.value).toEqual(expect.arrayContaining(hosts));
    const addresses = (await detail("network.egress.hosts[].host")).items?.map((i) => i.address);
    expect(addresses).toEqual(expect.arrayContaining(hosts));
  });

  it("says the allowlist is restart-dependent for a session already running", async () => {
    // The container took its allowlist when it started, so a host added now is
    // not reachable from it until it restarts — saying `live` would promise the
    // user the one thing they are asking about.
    const entry = await detail("network.egress.hosts", {
      egressEnforcementStatus: "active",
      containerManager: {
        get: () => ({ status: "running", egressContainedAtStart: true }),
        resolveEgress: () => ({ contained: true }),
      },
    });
    expect(entry.effect.state).toBe("restart-dependent");
    expect(entry.effect.detail).toContain("next time it starts");
  });

  it("does not tell a still-contained session the allowlist stopped applying to it", async () => {
    // Global containment was switched off after this container started, so the
    // resolver answers for its NEXT start while the running one still enforces
    // the list. "Its network access does not depend on the allowlist" is the
    // answer the user is unblocking against, and it would be false here.
    const entry = await detail("network.egress.hosts", {
      egressEnforcementStatus: "active",
      containerManager: {
        get: () => ({ status: "running", egressContainedAtStart: true }),
        resolveEgress: () => ({ contained: false }),
      },
    });
    expect(entry.effect.state).toBe("restart-dependent");
    expect(entry.effect.detail).not.toContain("does not depend on the allowlist");
    expect(entry.effect.detail).toContain("still enforcing");
  });

  it("says the allowlist does not restrict a running container that started open", async () => {
    const entry = await detail("network.egress.hosts", {
      egressEnforcementStatus: "active",
      containerManager: {
        get: () => ({ status: "running", egressContainedAtStart: false }),
        resolveEgress: () => ({ contained: true }),
      },
    });
    expect(entry.effect.state).toBe("restart-dependent");
    expect(entry.effect.detail).toContain("started open");
  });

  it("says it cannot tell for a container rediscovered after a ShipIt restart", async () => {
    const entry = await detail("network.egress.hosts", {
      egressEnforcementStatus: "active",
      containerManager: {
        get: () => ({ status: "running" }),
        resolveEgress: () => ({ contained: true }),
      },
    });
    expect(entry.effect.state).toBe("uncertain");
    expect(entry.effect.detail).toContain("rediscovered");
  });

  it("says the allowlist is excluded for a session nothing contains", async () => {
    const entry = await detail("network.egress.hosts", {
      egressEnforcementStatus: "active",
      containerManager: {
        get: () => undefined,
        resolveEgress: () => ({ contained: false }),
      },
    });
    expect(entry.effect.state).toBe("excluded");
    expect(entry.effect.detail).toContain("not contained");
  });

  it("says the allowlist is excluded for a sandbox whose own capability decides", async () => {
    const entry = await detail("network.egress.hosts[].host", {
      egressEnforcementStatus: "active",
      containerManager: {
        // Sealed when its policy was applied too: nothing changed under it.
        get: () => ({ status: "running", egressContainedAtStart: true, egressUserHostsExcluded: true }),
        resolveEgress: () => ({ contained: true, userHostsExcluded: true }),
      },
    });
    expect(entry.effect.state).toBe("excluded");
    expect(entry.effect.detail).toContain("network capability");
  });

  /*
    Revoking a sandbox's network capability saves WITHOUT rebuilding the
    container (`services/session-settings.ts` → `updateSandboxCapabilities`,
    which emits a `pendingRestart` card), so the resolver's `userHostsExcluded`
    answers for the next start while the container is still enforcing the policy
    it was configured with. Reading the exclusion off the resolver alone told
    such a session it was sealed from the allowlist — req 3's exact failure, on
    the surface that exists to explain a blocker.

    The container's own `egressUserHostsExcluded` is what is in force, and it is
    NOT the session's stored capabilities: `app-lifecycle.ts` snapshots those
    before creation resolves egress, and `reloadEgress` re-applies the current
    policy to a running container afterwards.
  */
  describe("a policy that changed after the container was configured", () => {
    const applied = (
      container: {
        status?: string;
        egressContainedAtStart?: boolean;
        egressUserHostsExcluded?: boolean;
      } | undefined,
      resolved: { contained: boolean; userHostsExcluded?: boolean },
    ): Partial<SettingsReadDeps> => ({
      egressEnforcementStatus: "active",
      containerManager: { get: () => container, resolveEgress: () => resolved },
    });

    it("does not tell a container that started open that it is sealed from the allowlist", async () => {
      const entry = await detail("network.egress.hosts", applied(
        { status: "running", egressContainedAtStart: false, egressUserHostsExcluded: false },
        { contained: true, userHostsExcluded: true },
      ));
      expect(entry.effect.state).toBe("excluded");
      // What is in force: nothing restricts it, and the user is owed that first.
      expect(entry.effect.detail).toContain("started open");
      // And what the next start does, which is why the state is still excluded.
      expect(entry.effect.detail).toContain("no restart makes a host here reachable");
    });

    it("says a still-contained container is enforcing the list it took, before the sealing", async () => {
      const entry = await detail("network.egress.hosts", applied(
        { status: "running", egressContainedAtStart: true, egressUserHostsExcluded: false },
        { contained: true, userHostsExcluded: true },
      ));
      expect(entry.effect.state).toBe("excluded");
      expect(entry.effect.detail).toContain("still enforcing");
      expect(entry.effect.detail).toContain("switched off since");
    });

    it("invents no history for a container it has no record of", async () => {
      // A container rediscovered after a ShipIt restart recorded no policy at
      // all. "Switched off since" would assert a change that may never have
      // happened — the capability may have been off for this container's whole
      // life.
      const entry = await detail("network.egress.hosts", applied(
        { status: "running" },
        { contained: true, userHostsExcluded: true },
      ));
      expect(entry.effect.state).toBe("excluded");
      expect(entry.effect.detail).toContain("rediscovered");
      expect(entry.effect.detail).not.toContain("since");
      expect(entry.effect.detail).toContain("no restart makes a host here reachable");
    });

    it("says the list adds nothing to a sealed container, once the capability is back", async () => {
      // The mirror image: granting the capability leaves the running container
      // sealed to ShipIt's own lifeline hosts until it restarts. It is not that
      // NO host on the list is reachable — the lifeline hosts are on the list
      // too — it is that the list adds nothing.
      const entry = await detail("network.egress.hosts", applied(
        { status: "running", egressContainedAtStart: true, egressUserHostsExcluded: true },
        { contained: true },
      ));
      expect(entry.effect.state).toBe("restart-dependent");
      expect(entry.effect.detail).toContain("adds nothing to what it can reach");
      expect(entry.effect.detail).toContain("from its next start");
    });

    it("does not call a contained container uncontained when its next start is open", async () => {
      const entry = await detail("network.egress.hosts", applied(
        { status: "running", egressContainedAtStart: true, egressUserHostsExcluded: true },
        { contained: false },
      ));
      expect(entry.effect.state).toBe("excluded");
      expect(entry.effect.detail).toContain("adds nothing to what it can reach");
      // The session IS contained right now; only its next start is open.
      expect(entry.effect.detail).not.toContain("nothing contains the session");
      expect(entry.effect.detail).toContain("next start is open");
    });

    it("leaves a sandbox nothing changed under saying exactly what it said before", async () => {
      const entry = await detail("network.egress.hosts", applied(
        { status: "running", egressContainedAtStart: true, egressUserHostsExcluded: true },
        { contained: true, userHostsExcluded: true },
      ));
      expect(entry.effect).toEqual({
        state: "excluded",
        detail: "This session's own network capability excludes it from the allowlist, and no restart makes a host here reachable from it. The session's network capability is what has to change.",
      });
    });

    it("follows a live reload rather than the policy the container started with", async () => {
      // `reloadEgress` re-applies the currently resolved policy to a RUNNING
      // container (`session-container.ts`), so a session host add after the
      // capability was granted puts it back under the ordinary allowlist
      // without a restart. Reading a start-time capability snapshot would still
      // be reporting it sealed.
      const entry = await detail("network.egress.hosts", applied(
        { status: "running", egressContainedAtStart: true, egressUserHostsExcluded: false },
        { contained: true },
      ));
      expect(entry.effect.state).toBe("restart-dependent");
      expect(entry.effect.detail).not.toContain("adds nothing to what it can reach");
    });
  });

  it("emits nothing of an entry that is not shaped like a host, and gives it no address", async () => {
    // The box takes any text, so a pasted URL is a possible stored entry — and
    // its user information and query are where a token travels. The collection's
    // projection drops it, so it is named by nothing and has no item either.
    // Lowercase, because the store normalizes an entry's case on the way in: a
    // sentinel that only matches the original spelling would pass on a leak.
    // Assembled rather than written as one literal, for the reason above.
    const pasted = new URL("https://api.example.com/v1");
    pasted.username = "svc";
    pasted.password = "sentinel-token";
    pasted.search = "api_key=sentinel-token";
    hosts = [pasted.toString(), "api.example.com"];

    const list = await listSettingsForAgent(deps(), SESSION);
    expect(JSON.stringify(list)).not.toContain("sentinel-token");

    const collection = await detail("network.egress.hosts");
    expect(collection.value).toContain("api.example.com");
    expect(JSON.stringify(collection)).not.toContain("sentinel-token");

    const items = await detail("network.egress.hosts[].host");
    const addresses = items.items?.map((i) => i.address) ?? [];
    expect(addresses).toContain("api.example.com");
    expect(addresses.some((a) => a.includes("sentinel"))).toBe(false);
    // And it says an instance was left unnamed rather than silently losing it.
    expect(items.notes.join(" ")).toContain("not listed");
    expect(JSON.stringify(items)).not.toContain("sentinel-token");
  });
});

describe("Project Settings", () => {
  it("reads this session's repository, and only from the session's own binding", async () => {
    repo = { allowAgentMerge: true, colorIndex: 3 };
    expect((await detail("project.allowAgentMerge")).display).toBe("on");
    expect((await detail("project.colorIndex")).display).toBe("3");
  });

  it("names the secrets that are set and whether each has a value, never a value", async () => {
    // Assembled rather than written as one literal, for the reason the MCP
    // fixture gives: a `scheme://user:pass@host` string reads as a credential.
    const dbUrl = new URL("postgres://db/app");
    dbUrl.username = "user";
    dbUrl.password = "SENTINEL";
    secrets = { DATABASE_URL: dbUrl.toString(), EMPTY_ONE: "" };
    const names = await detail("project.secrets");
    expect(names.value).toEqual(["DATABASE_URL", "EMPTY_ONE"]);
    const values = await itemDisplays("project.secrets[].value");
    expect(values).toEqual({ DATABASE_URL: "configured", EMPTY_ONE: "not configured" });
    expect(JSON.stringify([names, values])).not.toContain("SENTINEL");
  });

  it("does not repeat back a secret NAME that is shaped like a credential", async () => {
    /*
      `PUT /api/secrets` takes any string as a key, and an item's ADDRESS is
      projected through this collection — so before the shape gate a secret
      called `https://user:TOKEN@host/path?token=TOKEN` came back whole: in the
      index, in each item's address, in the one-line display and in `--json`.
      The value column was hidden the whole time; the name was not.

      Assembled rather than written as one literal, for the reason the MCP
      fixture gives.
    */
    const canary = new URL("https://host.test/path");
    canary.username = "user";
    canary.password = "SENTINEL";
    canary.search = "token=SENTINEL";
    secrets = { DATABASE_URL: "postgres://db/app", [canary.toString()]: "x" };

    const names = await detail("project.secrets");
    const { settings } = await listSettingsForAgent(deps(), SESSION);
    const everything = JSON.stringify([
      names,
      settings,
      await detail("project.secrets[].name"),
      await detail("project.secrets[].value"),
    ]);

    expect(everything).not.toContain("SENTINEL");
    expect(everything).not.toContain("host.test");
    // The one name that IS a name still comes back — dropping the emission
    // entirely would cost the agent the thing it needs to ask the user for.
    expect(names.value).toEqual(["DATABASE_URL"]);
    expect(names.notes.join(" ")).toMatch(/not shaped like|does not repeat it back/);
  });

  it("reports read_failed rather than false when ShipIt has no record of the repository", async () => {
    repo = undefined;
    const entry = await detail("project.allowAgentMerge");
    expect(entry).toMatchObject({ readable: false, unreadableReason: "read_failed" });
    expect(entry.value).toBeNull();
  });

  it("stays per-repository: an unbound session reads them as unavailable", async () => {
    const entry = await getSettingForAgent(
      deps({
        sessionManager: {
          get: () => ({ id: SESSION, remoteUrl: "" }),
        } as unknown as SettingsReadDeps["sessionManager"],
      }),
      SESSION,
      "project.allowAgentMerge",
    );
    expect(entry.unreadableReason).toBe("no_repository");
  });
});

describe("the index", () => {
  it("reads every declared setting that is not browser-local", async () => {
    repo = { allowAgentMerge: true, colorIndex: 1 };
    const { settings } = await listSettingsForAgent(deps(), SESSION);
    const unreadable = settings.filter((s) => !s.readable);
    // Only the browser-local values remain, and they say so for their own reason.
    expect(unreadable.every((s) => s.unreadableReason === "browser_local")).toBe(true);
    expect(unreadable.length).toBeGreaterThan(0);
  });

  it("names the instances of a per-item setting without growing an entry per item", async () => {
    credentialStore.setRole("deep-dive", {
      name: "deep-dive",
      params: {
        kind: "pinned",
        harnessId: "codex",
        serviceId: selection.serviceId,
        billingMode: selection.billingMode,
        modelId: selection.modelId,
      },
    });
    const { settings } = await listSettingsForAgent(deps(), SESSION);
    expect(settings).toHaveLength(ALL_SETTINGS.length);
    const entry = settings.find((s) => s.key === "roles[].model");
    expect(entry?.display).toBe("2 items: deep-dive, reviewer");
    // The index names them; what each is set to is the detail (req 1).
    expect(entry?.value).toBeNull();
    expect(entry).not.toHaveProperty("items");
  });

  it("caps how many instances the index names, and says how many it left out", async () => {
    hosts = Array.from({ length: 12 }, (_, i) => `h${i}.example.com`);
    const { settings } = await listSettingsForAgent(deps(), SESSION);
    const entry = settings.find((s) => s.key === "network.egress.hosts[].host");
    expect(entry?.display).toContain("more)");
    const all = await detail("network.egress.hosts[].host");
    expect(all.items?.length).toBeGreaterThanOrEqual(12);
  });

  it("declares a reader for every bespoke setting, and finds one for each", async () => {
    const { settings } = await listSettingsForAgent(deps(), SESSION);
    const bespoke = ALL_SETTINGS.filter(
      (d) => d.store.kind === "bespoke" && d.emits.kind !== "withheld",
    );
    for (const declaration of bespoke) {
      const entry = settings.find((s) => s.key === declaration.key);
      expect(entry?.readable, declaration.key).toBe(true);
    }
    expect(bespoke.length).toBeGreaterThan(40);
  });
});

describe("nothing reports a default in place of a value it could not read", () => {
  it("degrades every bespoke setting when its store is absent, rather than defaulting", async () => {
    const bare = deps({
      credentialStore: undefined,
      providerAccountManager: undefined,
      egressAllowlistStore: undefined,
      repoStore: undefined,
      secretStore: undefined,
    });
    const { settings } = await listSettingsForAgent(bare, SESSION);
    const bespoke = ALL_SETTINGS.filter(
      (d) => d.store.kind === "bespoke" && d.emits.kind !== "withheld",
    );
    for (const declaration of bespoke) {
      const entry = settings.find((s) => s.key === declaration.key);
      expect(entry?.readable, declaration.key).toBe(false);
      expect(entry?.value, declaration.key).toBeNull();
      expect(entry?.display, declaration.key).toBe("unknown");
    }
    // And the call still answered for the settings that do not need those stores.
    expect(settings).toHaveLength(ALL_SETTINGS.length);
  });
});
