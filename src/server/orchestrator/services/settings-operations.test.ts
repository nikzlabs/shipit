import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ALL_SETTINGS,
  findSetting,
  isPayloadDeclaration,
} from "../../shared/settings-catalogue/index.js";
import { withConflictDomains } from "./settings-conflict-domain.js";
import { findOperation, operationsFor, registeredOperationKeys } from "./settings-operations.js";
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
    // Declared, readable, and not something a card can apply yet.
    expect(operationsFor("services.credentials[].label")).toEqual([]);
    expect(operationsFor("nonsense.key")).toEqual([]);
  });

  it("names a conflict domain for every operation it has", () => {
    for (const declaration of ALL_SETTINGS) {
      for (const kind of KINDS) {
        const operation = findOperation(declaration, kind);
        if (!operation) continue;
        const domains = operation.domains({ key: declaration.key, item: "x", repoUrl: "u" });
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
    const outcome = await withConflictDomains(operation.domains(target), () =>
      operation.apply(fx.deps.operations, target, "what it is for, in one line"));

    expect(outcome.status).toBe("applied");
    const role = fx.credentialStore.getRole("deep-dive");
    expect(role?.description).toBe("what it is for, in one line");
    // The agent supplied one field and can see one field; everything else on the
    // stored object has to survive its own proposal.
    expect(role?.prompt).toBe("standing instructions the agent wrote nothing about");
    expect(role?.params).toMatchObject({ harnessId: "claude", modelId: "claude-opus-5", reasoningEffort: "high" });
  });
});
