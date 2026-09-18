import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ALL_SETTINGS,
  findSetting,
  isPayloadDeclaration,
} from "../../shared/settings-catalogue/index.js";
import { addMcpServer } from "./mcp.js";
import { withConflictDomains } from "./settings-conflict-domain.js";
import {
  findOperation,
  operationsFor,
  proposableFieldsOf,
  registeredOperationKeys,
} from "./settings-operations.js";
import { proposalFixture, type ProposalFixture } from "./settings-proposal-test-helpers.js";

/**
 * What an Apply button runs (docs/299-agent-settings-access req 4).
 *
 * The registry is keyed by strings, so the first test is that every key names a
 * setting that exists and may be proposed: a typo there is an operation nothing
 * can ever reach, and propose would answer "ShipIt cannot change that yet" about
 * a setting it can.
 */

const KINDS = ["set", "add", "remove"] as const;

let fx: ProposalFixture;

beforeEach(() => {
  fx = proposalFixture();
});

afterEach(() => {
  fx.close();
});

describe("the operation registry", () => {
  it("only names declared settings that are proposable", () => {
    const keys = registeredOperationKeys();
    expect(keys.length).toBeGreaterThan(0);
    // Read off the registry's OWN keys, not off the declarations: enumerating
    // declarations drops a misspelled key silently, and the operation it names
    // is then one no proposal can ever reach.
    for (const key of keys) {
      const [settingKey, kind] = key.split("::");
      expect(KINDS).toContain(kind);
      const declaration = findSetting(settingKey!);
      expect(declaration, `${key} names no declared setting`).toBeDefined();
      expect(declaration!.propose.kind, `${key} is declared unproposable`).toBe("yes");
    }
  });

  it("covers every declared payload scalar with no entry of its own (req 7)", () => {
    // The point of the generic path: a setting declared tomorrow is proposable
    // the same day, with no second registration to forget.
    const payload = ALL_SETTINGS.filter(isPayloadDeclaration);
    expect(payload.length).toBeGreaterThan(0);
    for (const declaration of payload) {
      expect(findOperation(declaration, "set")).toBeDefined();
    }
  });

  it("reports what it can do with a setting, for a refusal that says so", () => {
    expect(operationsFor("advanced.enableSubAgents")).toEqual(["set"]);
    expect(operationsFor("network.egress.hosts[].host")).toEqual(["add", "remove"]);
    expect(operationsFor("nonsense.key")).toEqual([]);
  });

  it("leaves no declaration promising a proposal it has nowhere to send (req 4)", () => {
    // `propose.allowed: true` reaches the agent from the read surface, so a
    // declaration advertising it with no operation anywhere is a promise only
    // attempting the change reveals as empty. A collection aggregate keeps its
    // promise through its entry fields; anything else needs an operation of its
    // own.
    const stranded = ALL_SETTINGS
      .filter((declaration) => declaration.propose.kind === "yes")
      .filter((declaration) => operationsFor(declaration.key).length === 0)
      .filter((declaration) => proposableFieldsOf(declaration.key).length === 0)
      .map((declaration) => declaration.key);
    expect(stranded).toEqual([]);
  });

  it("names a conflict domain for every operation it has", () => {
    for (const declaration of ALL_SETTINGS) {
      for (const kind of KINDS) {
        const operation = findOperation(declaration, kind);
        if (!operation) continue;
        const domains = operation.domains({ key: declaration.key, item: "x", repoUrl: "u" }, fx.deps.operations, "x");
        expect(domains.length).toBeGreaterThan(0);
      }
    }
  });
});

describe("a collection entry is patched, never replaced", () => {
  it("keeps the fields of a role the change is not about", async () => {
    fx.credentialStore.setRole("deep-dive", {
      name: "deep-dive",
      description: "the old description",
      prompt: "standing instructions the agent wrote nothing about",
      params: {
        kind: "pinned",
        harnessId: "claude",
        serviceId: "anthropic",
        billingMode: "sub",
        modelId: "claude-opus-5",
        reasoningEffort: "high",
      },
    });
    const operation = findOperation(findSetting("roles[].description")!, "set")!;
    const target = { key: "roles[].description", item: "deep-dive" };

    // Under the domains the operation DECLARES, exactly as the decision handler
    // holds them: the lock refuses a nested acquisition its caller does not
    // hold, so a `domains()` that is not a superset of what the write takes
    // throws here instead of quietly working in a test that skipped the hold.
    const value = "what it is for, in one line";
    const outcome = await withConflictDomains(operation.domains(target, fx.deps.operations, value), () =>
      operation.apply(fx.deps.operations, target, value));

    expect(outcome.status).toBe("applied");
    const role = fx.credentialStore.getRole("deep-dive");
    expect(role?.description).toBe("what it is for, in one line");
    // The agent supplied one field and can see one field; everything else on the
    // stored object has to survive its own proposal.
    expect(role?.prompt).toBe("standing instructions the agent wrote nothing about");
    expect(role?.params).toMatchObject({ harnessId: "claude", modelId: "claude-opus-5", reasoningEffort: "high" });
  });

  it("turns a server off without clearing a secret its configuration does not name", async () => {
    // Both are stored secrets of this server; only one is referenced by the
    // config. `addMcpServer` accepts the other, and it is what an update-shaped
    // write treats as unreferenced and deletes.
    addMcpServer(
      fx.credentialStore,
      {
        name: "notion",
        type: "http",
        url: "https://mcp.notion.com/mcp",
        headers: { Authorization: "Bearer $secret:mcp__notion__TOKEN" },
        enabled: true,
      },
      { mcp__notion__TOKEN: "ntn_referenced", mcp__notion__LEGACY: "ntn_unreferenced" },
    );
    const operation = findOperation(findSetting("mcp.servers[].enabled")!, "set")!;
    const target = { key: "mcp.servers[].enabled", item: "notion" };

    const outcome = await withConflictDomains(operation.domains(target, fx.deps.operations, false), () =>
      operation.apply(fx.deps.operations, target, false));

    expect(outcome.status).toBe("applied");
    expect(fx.credentialStore.getMcpServer("notion")?.enabled).toBe(false);
    // The card proposed one boolean, so one boolean is what the write may
    // change: a credential the user would have to fetch again is not part of it.
    expect(fx.credentialStore.getAgentEnv("mcp__notion__TOKEN")).toBe("ntn_referenced");
    expect(fx.credentialStore.getAgentEnv("mcp__notion__LEGACY")).toBe("ntn_unreferenced");
  });
});

describe("a refusal names stored values only through the projection that emits them", () => {
  const pinned = {
    kind: "pinned",
    harnessId: "claude",
    serviceId: "anthropic",
    billingMode: "sub",
    modelId: "claude-opus-5",
  } as const;

  it("does not repeat a role name shaped like a credential-bearing URL (req 2)", () => {
    const urlName = "https://user:CANARY@example.com/?token=CANARY";
    fx.credentialStore.setRole(urlName, { name: urlName, params: pinned });
    fx.credentialStore.setRole("deep-dive", { name: "deep-dive", params: pinned });
    const operation = findOperation(findSetting("roles[].description")!, "set")!;

    const message = operation.preflight!(
      fx.deps.operations,
      { key: "roles[].description", item: "helper" },
      "what it is for",
    );

    // The read emits no item for such a name, so the error path must not be the
    // second door out of the same store.
    expect(message).toContain("deep-dive");
    expect(message).not.toContain("CANARY");
    expect(message).not.toContain("https");
    expect(message).toContain("1 ShipIt does not name back");
  });
});

/**
 * The three operations a declaration advertised before one existed
 * (docs/299-agent-settings-access req 4). Each is a narrow write: the field the
 * card names, and nothing beside it.
 */
describe("renaming what the user named themselves", () => {
  const pinned = {
    kind: "pinned",
    harnessId: "claude",
    serviceId: "anthropic",
    billingMode: "sub",
    modelId: "claude-opus-5",
  } as const;

  async function run(key: string, item: string, value: unknown) {
    const operation = findOperation(findSetting(key)!, "set")!;
    const target = { key, item };
    return withConflictDomains(operation.domains(target, fx.deps.operations, value), () =>
      operation.apply(fx.deps.operations, target, value));
  }

  function refusal(key: string, item: string, value: unknown): string | null {
    const operation = findOperation(findSetting(key)!, "set")!;
    return operation.preflight!(fx.deps.operations, { key, item }, value);
  }

  it("moves a role to its new name and leaves everything else on it", async () => {
    fx.credentialStore.setRole("deep-dive", {
      name: "deep-dive",
      description: "for the hard ones",
      prompt: "standing instructions",
      params: pinned,
    });

    const outcome = await run("roles[].name", "deep-dive", "auditor");

    expect(outcome.status).toBe("applied");
    expect(fx.credentialStore.getRole("deep-dive")).toBeUndefined();
    expect(fx.credentialStore.getRole("auditor")).toMatchObject({
      description: "for the hard ones",
      prompt: "standing instructions",
      params: { harnessId: "claude", modelId: "claude-opus-5" },
    });
  });

  it("refuses a rename that would replace a role that already exists", () => {
    fx.credentialStore.setRole("deep-dive", { name: "deep-dive", params: pinned });
    fx.credentialStore.setRole("auditor", { name: "auditor", params: pinned });

    expect(refusal("roles[].name", "deep-dive", "auditor")).toContain("already exists");
  });

  it("refuses renaming the reserved role, because \"review this\" has to resolve", () => {
    expect(refusal("roles[].name", "reviewer", "auditor")).toContain("cannot be renamed");
  });

  it("renames a credential without touching the secret it delivers", async () => {
    fx.credentialStore.upsertCredentialRouteWithSecret(
      {
        id: "anthropic-key-fixture",
        serviceId: "anthropic",
        billingMode: "key",
        via: "string",
        status: "ready",
        priority: 0,
        isPrimary: true,
        label: "the old name",
        createdAt: 0,
        updatedAt: 0,
      },
      "sk-ant-fixture",
    );

    const outcome = await run("services.credentials[].label", "anthropic-key-fixture", "work key");

    expect(outcome.status).toBe("applied");
    expect(fx.credentialStore.getCredentialRoute("anthropic-key-fixture")?.label).toBe("work key");
    // A label is a display string; the credential the session is handed is not
    // part of what the card proposed.
    expect(fx.credentialStore.getCredentialSecret("anthropic-key-fixture")).toBe("sk-ant-fixture");
  });

  it("refuses a credential id that names nothing", () => {
    expect(refusal("services.credentials[].label", "no-such-route", "work key")).toContain("no-such-route");
  });

  it("refuses a provider account address the read does not emit", () => {
    // The address is `service:accountId`, and the writer takes the harness whose
    // sign-in owns that service — so a bare provider, and a service nothing
    // signs in to, are both addresses that reach no account.
    expect(refusal("services.providerAccounts[].label", "claude", "work account"))
      .toContain("No provider account is addressed by");
    expect(refusal("services.providerAccounts[].label", "nonsense:acct-1", "work account"))
      .toContain("No provider account is addressed by");
  });

  it("refuses a name longer than the credential writers store", () => {
    fx.credentialStore.upsertCredentialRouteWithSecret(
      {
        id: "anthropic-key-fixture",
        serviceId: "anthropic",
        billingMode: "key",
        via: "string",
        status: "ready",
        priority: 0,
        isPrimary: true,
        label: "the old name",
        createdAt: 0,
        updatedAt: 0,
      },
      "sk-ant-fixture",
    );
    // The declaration allows more than the writer stores, so without this the
    // card could only ever resolve `refused`.
    const message = refusal("services.credentials[].label", "anthropic-key-fixture", "x".repeat(121));
    expect(message).toContain("at most 120");
  });
});

describe("a role card is refused when the write would be", () => {
  it("refuses renaming a role whose pinned model the write no longer accepts", () => {
    fx.credentialStore.setRole("deep-dive", {
      name: "deep-dive",
      params: {
        kind: "pinned",
        harnessId: "claude",
        serviceId: "anthropic",
        billingMode: "sub",
        // Left the catalogue: `planRoleWrites` validates the whole role on every
        // write, so a card proposing only the name could only resolve `refused`.
        modelId: "claude-fable-5",
      },
    });
    const operation = findOperation(findSetting("roles[].name")!, "set")!;

    const message = operation.preflight!(
      fx.deps.operations,
      { key: "roles[].name", item: "deep-dive" },
      "auditor",
    );

    expect(message).toContain("claude-fable-5");
  });
});
