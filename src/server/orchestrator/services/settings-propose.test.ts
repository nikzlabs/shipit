import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findSetting } from "../../shared/settings-catalogue/index.js";
import { addMcpServer } from "./mcp.js";
import { getSettingForAgent } from "./settings-read.js";
import { proposeSettingChange, readProposedValue, CARD_VALUE_MAX } from "./settings-propose.js";
import { proposalFixture, type ProposalFixture } from "./settings-proposal-test-helpers.js";
import { ServiceError } from "./types.js";

/**
 * `shipit settings propose` (docs/299-agent-settings-access req 4).
 *
 * Every refusal here is a refusal BEFORE a card exists, which is the point: a
 * card the user cannot act on, or one whose words do not describe what its
 * button would do, is worse than a sentence of prose.
 */

let fx: ProposalFixture;

async function propose(input: Parameters<typeof proposeSettingChange>[2]) {
  return proposeSettingChange(fx.deps, fx.sessionId, input);
}

async function refusal(input: Parameters<typeof proposeSettingChange>[2]): Promise<string> {
  try {
    await propose(input);
  } catch (err) {
    if (err instanceof ServiceError) return err.message;
    throw err;
  }
  throw new Error("expected the proposal to be refused");
}

beforeEach(() => {
  fx = proposalFixture();
});

afterEach(() => {
  fx.close();
});

describe("proposeSettingChange", () => {
  it("posts one card whose words are the registry's and whose values are the server's read", async () => {
    const card = await propose({
      key: "advanced.enableSubAgents",
      valueText: "false",
      reason: "  The review you asked for\nruns as a separate agent.  ",
    });

    const declared = findSetting("advanced.enableSubAgents")!;
    expect(card).toMatchObject({
      target: { key: "advanced.enableSubAgents" },
      label: declared.label,
      description: declared.description,
      // `from` is this server's own read, not anything the caller passed.
      from: "on",
      to: "off",
      phase: "pending",
      // The one agent-authored field, flattened to a line.
      reason: "The review you asked for runs as a separate agent.",
    });
    expect(fx.proposals.get(card.cardId)).toMatchObject({
      operation: "set",
      phase: "pending",
      proposed: false,
    });
  });

  it("takes the private baseline, and never puts it on the card", async () => {
    const card = await propose({ key: "advanced.autoFixCi", valueText: "true", reason: "why" });

    expect(fx.proposals.get(card.cardId)?.baseline).toMatchObject({ kind: "revision" });
    // Transcript projection returns a card's fields, so a baseline on it would
    // reach every viewer and every replay.
    expect(JSON.stringify(card)).not.toContain("revision");
  });

  it("refuses a setting whose declaration refuses proposals, with the catalogue's own reason", async () => {
    const message = await refusal({
      key: "services.credentials[].secret",
      item: "route-1",
      valueText: "sk-live",
      reason: "why",
    });
    expect(message).toContain("secret");
    // Refused before anything is written down: no card, no row.
    expect(fx.emitted).toHaveLength(0);
  });

  it("refuses a setting ShipIt cannot apply yet, saying so rather than posting a dead card", async () => {
    const message = await refusal({ key: "roles[].name", item: "reviewer", valueText: "auditor", reason: "why" });
    expect(message).toContain("cannot set roles[].name");
    expect(fx.emitted).toHaveLength(0);
  });

  it("refuses a value the declared type rejects", async () => {
    expect(await refusal({ key: "advanced.releaseChannel", valueText: "nightly", reason: "why" }))
      .toContain("must be one of: stable, edge");
  });

  it("refuses a change to the value a setting already has", async () => {
    // A card that changes nothing still asks the user to read and click.
    expect(await refusal({ key: "advanced.enableSubAgents", valueText: "true", reason: "why" }))
      .toContain("already on");
  });

  it("refuses a value the card cannot show in full", async () => {
    const message = await refusal({
      key: "instructions.userInstructions",
      valueText: "x".repeat(CARD_VALUE_MAX + 1),
      reason: "why",
    });
    // The test is what the card can display, never the size of the diff.
    expect(message).toContain(`at most ${CARD_VALUE_MAX}`);
  });

  it("needs the instance of an item-addressed setting, and names where to find them", async () => {
    const message = await refusal({ key: "mcp.servers[].enabled", valueText: "false", reason: "why" });
    expect(message).toContain("--item");
    expect(message).toContain("shipit settings get mcp.servers[].enabled");
  });

  it("refuses an instance that does not exist, listing the ones that do", async () => {
    addMcpServer(fx.credentialStore, { name: "notion", type: "stdio", command: "notion-mcp" }, {});
    const message = await refusal({
      key: "mcp.servers[].enabled",
      item: "linear",
      valueText: "false",
      reason: "why",
    });
    expect(message).toContain("no instance called \"linear\"");
    expect(message).toContain("notion");
  });

  it("proposes one field of a collection entry, with the card naming the entry", async () => {
    addMcpServer(fx.credentialStore, { name: "notion", type: "stdio", command: "notion-mcp" }, {});
    const card = await propose({
      key: "mcp.servers[].enabled",
      item: "notion",
      valueText: "false",
      reason: "it keeps failing to start",
    });
    expect(card).toMatchObject({
      target: { key: "mcp.servers[].enabled", item: "notion" },
      from: "on",
      to: "off",
    });
  });

  it("refuses a per-repository setting in a session that binds no repository", async () => {
    expect(await refusal({ key: "project.allowAgentMerge", valueText: "true", reason: "why" }))
      .toContain("binds no repository");
  });

  it("freezes the session's own repository on the card, and never takes one from the caller", async () => {
    fx.close();
    fx = proposalFixture({ remoteUrl: "https://github.com/o/r" });
    const card = await propose({ key: "project.allowAgentMerge", valueText: "true", reason: "why" });
    expect(card.target).toEqual({ key: "project.allowAgentMerge", repoUrl: "https://github.com/o/r" });
  });

  describe("a list entry", () => {
    it("proposes joining the list, with membership as the card's from and to", async () => {
      const card = await propose({
        key: "network.egress.hosts[].host",
        operation: "add",
        item: "Registry.NPMJS.org",
        reason: "the install step fetches packages from it",
      });
      expect(card).toMatchObject({
        // Normalized to the form the allowlist stores, so the card names the
        // entry the button would actually write.
        target: { key: "network.egress.hosts[].host", item: "registry.npmjs.org" },
        from: "not allowed",
        to: "allowed",
      });
      expect(fx.proposals.get(card.cardId)?.operation).toBe("add");
    });

    it("refuses an entry the list's own projection would not show back", async () => {
      const message = await refusal({
        key: "network.egress.hosts[].host",
        operation: "add",
        item: "https://user:token@registry.npmjs.org/path",
        reason: "why",
      });
      expect(message).toContain("not shaped like a host name");
    });

    it("refuses adding what is already there, and removing what is not", async () => {
      fx.egressAllowlistStore.addHost("global", "registry.npmjs.org");
      expect(await refusal({
        key: "network.egress.hosts[].host",
        operation: "add",
        item: "registry.npmjs.org",
        reason: "why",
      })).toContain("already allowed");
      expect(await refusal({
        key: "network.egress.hosts[].host",
        operation: "remove",
        item: "example.test",
        reason: "why",
      })).toContain("already not allowed");
    });
  });

  it("reports a pending card without blocking a second proposal", async () => {
    const first = await propose({ key: "advanced.autoFixCi", valueText: "true", reason: "one" });
    const second = await propose({ key: "advanced.autoFixCi", valueText: "true", reason: "two" });
    expect(second.cardId).not.toBe(first.cardId);
    // A card nothing expires would otherwise be an indefinite veto from a
    // session the user has forgotten.
    expect(fx.proposals.get(first.cardId)?.phase).toBe("pending");
  });
});

describe("what `shipit settings get` reports about the last proposal", () => {
  it("carries it per setting, so the agent knows what the user already did (req 8)", async () => {
    const card = await propose({ key: "advanced.autoFixCi", valueText: "true", reason: "the checks keep failing" });

    const entry = await getSettingForAgent(fx.deps.read, fx.sessionId, "advanced.autoFixCi");

    expect(entry.lastProposal).toMatchObject({
      cardId: card.cardId,
      phase: "pending",
      operation: "set",
      from: false,
      proposed: true,
      sessionId: fx.sessionId,
    });
  });

  it("carries it per INSTANCE, so one entry's card says nothing about another's", async () => {
    addMcpServer(fx.credentialStore, { name: "notion", type: "stdio", command: "notion-mcp" }, {});
    addMcpServer(fx.credentialStore, { name: "linear", type: "stdio", command: "linear-mcp" }, {});
    const card = await propose({
      key: "mcp.servers[].enabled",
      item: "notion",
      valueText: "false",
      reason: "why",
    });

    const entry = await getSettingForAgent(fx.deps.read, fx.sessionId, "mcp.servers[].enabled");

    const items = Object.fromEntries((entry.items ?? []).map((i) => [i.address, i.lastProposal]));
    expect(items.notion).toMatchObject({ cardId: card.cardId, phase: "pending" });
    expect(items.linear).toBeUndefined();
  });

  it("reports it from ANY session: what was done about a setting is a fact about the setting", async () => {
    const card = await propose({ key: "advanced.autoFixCi", valueText: "true", reason: "why" });
    fx.sessions.track("sess-2", "Another session");

    const entry = await getSettingForAgent(fx.deps.read, "sess-2", "advanced.autoFixCi");

    expect(entry.lastProposal).toMatchObject({ cardId: card.cardId, sessionId: fx.sessionId });
  });
});

describe("readProposedValue", () => {
  it("reads text against the DECLARED type, so a word is not a boolean by accident", () => {
    const bool = findSetting("advanced.enableSubAgents")!;
    const text = findSetting("roles[].description")!;
    expect(readProposedValue(bool, "true")).toBe(true);
    expect(readProposedValue(bool, "off")).toBe(false);
    // The same word, in a box that holds prose, is that word.
    expect(readProposedValue(text, "true")).toBe("true");
  });

  it("reads a number, a cleared value and a model tuple", () => {
    const budget = findSetting("advanced.memoryBudgetMb")!;
    const pin = findSetting("services.nonTurnModel")!;
    expect(readProposedValue(budget, "8192")).toBe(8192);
    expect(readProposedValue(budget, "null")).toBeNull();
    expect(readProposedValue(pin, '{"serviceId":"anthropic","billingMode":"sub","modelId":"m"}'))
      .toEqual({ serviceId: "anthropic", billingMode: "sub", modelId: "m" });
  });
});
