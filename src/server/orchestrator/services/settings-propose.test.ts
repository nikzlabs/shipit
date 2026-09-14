import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findSetting } from "../../shared/settings-catalogue/index.js";
import { addMcpServer, MAX_ENABLED_MCP_SERVERS } from "./mcp.js";
import { settingsPayloadDomain, withConflictDomains } from "./settings-conflict-domain.js";
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

/**
 * Which harnesses this box counts as installed, pinned for the length of a test.
 * `harnessForSelection` asks, so a test about the harness a model moves a role
 * onto cannot be left reading whatever the machine running it happens to have.
 */
function installReport(harnesses: string[]): { restore: () => void } {
  const previous = process.env.SHIPIT_AGENTS_INSTALL_REPORT;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-installed-"));
  const file = path.join(dir, "installed.json");
  fs.writeFileSync(file, JSON.stringify({ harnesses }));
  process.env.SHIPIT_AGENTS_INSTALL_REPORT = file;
  return {
    restore: () => {
      if (previous === undefined) delete process.env.SHIPIT_AGENTS_INSTALL_REPORT;
      else process.env.SHIPIT_AGENTS_INSTALL_REPORT = previous;
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
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

  it("sends a proposal about a whole list to the entry field that carries it", async () => {
    // The aggregate declaration advertises `propose.allowed: true` and carries no
    // operation, because a card changes one entry and never replaces the list.
    // The refusal has to say where the proposal goes, or the only way to find out
    // is to attempt it (docs/299-agent-settings-access req 4).
    const message = await refusal({ key: "roles", valueText: "anything", reason: "why" });
    expect(message).toContain("roles is the whole list");
    expect(message).toContain("roles[].description");
    expect(message).toContain("--item");
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

  it("refuses a name ShipIt would not read back, rather than showing it as \"not set\"", async () => {
    fx.credentialStore.setRole("deep-dive", {
      name: "deep-dive",
      params: {
        kind: "pinned",
        harnessId: "claude",
        serviceId: "anthropic",
        billingMode: "sub",
        modelId: "claude-opus-5",
      },
    });

    const message = await refusal({
      key: "roles[].name",
      item: "deep-dive",
      valueText: "https://user:CANARY@example.test/?token=CANARY",
      reason: "why",
    });

    // The projection names no URL back, so the card would have said
    // `deep-dive → not set` while the write stored the URL and deleted the role.
    expect(message).toContain("would not read that value back");
    expect(fx.emitted).toHaveLength(0);
    expect(fx.credentialStore.getRole("deep-dive")).toBeDefined();
    // The refusal reaches the transcript as tool output, so it must not quote
    // back what was typed.
    expect(message).not.toContain("CANARY");
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
      // The refusal reaches the transcript as tool output, so it must not quote
      // back what was typed: a pasted URL can carry a token.
      expect(message).not.toContain("token");
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
      })).toContain("already off the list");
    });

    it("words a removal as membership, not as reachability", async () => {
      // `.github.com` ships as a default and matches this host, so taking the
      // entry off does not make the host unreachable. A card promising "not
      // allowed" would be approving something the removal cannot deliver.
      fx.egressAllowlistStore.addHost("global", "api.github.com");

      const card = await propose({
        key: "network.egress.hosts[].host",
        operation: "remove",
        item: "api.github.com",
        reason: "why",
      });

      expect(card).toMatchObject({ from: "on the list", to: "off the list" });
    });
  });

  it("reports a pending card without blocking a second proposal", async () => {
    const first = await propose({ key: "advanced.autoFixCi", valueText: "true", reason: "one" });
    // Reported: the read carries it, which is what "reporting it is enough"
    // means. Without that the agent has no way to know a card is already up.
    const entry = await getSettingForAgent(fx.deps.read, fx.sessionId, "advanced.autoFixCi");
    expect(entry.lastProposal).toMatchObject({ cardId: first.cardId, phase: "pending" });

    const second = await propose({ key: "advanced.autoFixCi", valueText: "true", reason: "two" });
    expect(second.cardId).not.toBe(first.cardId);
    // A card nothing expires would otherwise be an indefinite veto from a
    // session the user has forgotten.
    expect(fx.proposals.get(first.cardId)?.phase).toBe("pending");
  });

  it("takes the displayed value and the baseline as one snapshot, under the target's lock", async () => {
    // A write already in flight when the proposal arrives. Reading outside the
    // lock gives the card a `from` of "on" — the value this write is in the
    // middle of replacing — and a baseline taken after it, which is the card
    // describing one change and approving another.
    const rival = withConflictDomains([settingsPayloadDomain], async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      fx.credentialStore.setEnableSubAgents(false);
    });
    const refused = refusal({ key: "advanced.enableSubAgents", valueText: "false", reason: "why" });

    const [, message] = await Promise.all([rival, refused]);

    expect(message).toContain("already off");
    expect(fx.emitted).toHaveLength(0);
  });

  it("refuses removing an allowlist entry the allowlist cannot remove", async () => {
    // The read lists the EFFECTIVE allowlist, which includes the hosts a
    // configured MCP server needs. Removing one writes nothing, so a card for
    // it would report "off the allowlist" about a host still on it.
    addMcpServer(fx.credentialStore, { name: "notion", type: "http", url: "https://mcp.notion.com/sse" }, {});

    const message = await refusal({
      key: "network.egress.hosts[].host",
      operation: "remove",
      item: "mcp.notion.com",
      reason: "why",
    });

    expect(message).toContain("MCP server");
    expect(fx.emitted).toHaveLength(0);
  });

  it("refuses removing a shipped default the deployment's operator also supplies", async () => {
    // `.github.com` is on the list twice over. A removal suppresses the default
    // and cannot touch the operator's entry, so the host stays reachable — and
    // the card, and the agent's next-turn notice, used to report it gone.
    const previous = process.env.SESSION_EGRESS_ALLOWLIST;
    process.env.SESSION_EGRESS_ALLOWLIST = ".github.com";
    try {
      const message = await refusal({
        key: "network.egress.hosts[].host",
        operation: "remove",
        item: ".github.com",
        reason: "why",
      });

      expect(message).toContain("operator");
      expect(fx.emitted).toHaveLength(0);
    } finally {
      if (previous === undefined) delete process.env.SESSION_EGRESS_ALLOWLIST;
      else process.env.SESSION_EGRESS_ALLOWLIST = previous;
    }
  });

  it("refuses enabling an MCP server past the limit the writer enforces", async () => {
    for (let i = 0; i < MAX_ENABLED_MCP_SERVERS; i++) {
      addMcpServer(fx.credentialStore, { name: `srv${i}`, type: "stdio", command: "x" }, {});
    }
    addMcpServer(fx.credentialStore, { name: "extra", type: "stdio", command: "x", enabled: false }, {});

    const message = await refusal({
      key: "mcp.servers[].enabled",
      item: "extra",
      valueText: "true",
      reason: "why",
    });

    // A card that could only ever resolve `refused` is not a change the user
    // can make with one click.
    expect(message).toContain("limit");
  });

  it("keeps a proposal about an entry the read does not list", async () => {
    // A pending addition names a host that does not exist yet, so an
    // item-addressed lookup answers nothing about it — and the agent told to
    // read before proposing would post the same card again.
    const card = await propose({
      key: "network.egress.hosts[].host",
      operation: "add",
      item: "registry.npmjs.org",
      reason: "why",
    });

    const entry = await getSettingForAgent(fx.deps.read, fx.sessionId, "network.egress.hosts[].host");

    expect(entry.items?.some((i) => i.address === "registry.npmjs.org")).toBe(false);
    expect(entry.lastProposal).toMatchObject({
      cardId: card.cardId,
      phase: "pending",
      operation: "add",
      item: "registry.npmjs.org",
    });
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

/**
 * The declared operation is the mutation unit, so the card shows all of it
 * (docs/299-agent-settings-access req 4, plan.md → The unit of a change is the
 * declared operation).
 *
 * Picking a role's model re-derives the harness and drops a level the new
 * selection does not offer. The declaration's own description says so in
 * prose — and prose is not the values, which is what the user is approving.
 */
describe("a card shows every field its one operation writes", () => {
  const ROLE = "deep-dive";

  function pinRole(params: Record<string, unknown>) {
    fx.credentialStore.setRole(ROLE, {
      name: ROLE,
      params: { kind: "pinned", ...params } as never,
    });
  }

  it("names the reasoning level a new model drops", async () => {
    pinRole({
      harnessId: "claude",
      serviceId: "anthropic",
      billingMode: "sub",
      modelId: "claude-opus-5",
      reasoningEffort: "max",
    });

    // Claude speaks this model, so the harness stays — and it offers low and
    // high only, so `max` cannot survive the write.
    const card = await propose({
      key: "roles[].model",
      item: ROLE,
      valueText: JSON.stringify({ serviceId: "openrouter", billingMode: "key", modelId: "stealth/ox-alpha" }),
      reason: "why",
    });

    expect(card.alsoChanges).toEqual([
      { label: findSetting("roles[].reasoningEffort")!.label, from: "max", to: "not set" },
    ]);
  });

  it("names the harness a new model moves the role onto", async () => {
    const report = installReport(["claude", "codex"]);
    try {
      pinRole({
        harnessId: "claude",
        serviceId: "anthropic",
        billingMode: "sub",
        modelId: "claude-opus-5",
      });

      // Only codex speaks this one, so applying moves the role's harness.
      const card = await propose({
        key: "roles[].model",
        item: ROLE,
        valueText: JSON.stringify({ serviceId: "openai", billingMode: "sub", modelId: "gpt-5.6-sol" }),
        reason: "why",
      });

      expect(card.alsoChanges).toEqual([
        { label: findSetting("roles[].harness")!.label, from: "claude", to: "codex" },
      ]);
    } finally {
      report.restore();
    }
  });

  it("names the level a new harness drops", async () => {
    const report = installReport(["claude", "codex"]);
    try {
      pinRole({
        harnessId: "codex",
        serviceId: "openrouter",
        billingMode: "key",
        modelId: "stealth/ox-alpha",
        reasoningEffort: "minimal",
      });

      // Claude offers low and high on this model, so `minimal` cannot survive
      // the move — the same drop a model change makes, under a different card.
      const card = await propose({
        key: "roles[].harness",
        item: ROLE,
        valueText: "claude",
        reason: "why",
      });

      expect(card.alsoChanges).toEqual([
        { label: findSetting("roles[].reasoningEffort")!.label, from: "minimal", to: "not set" },
      ]);
    } finally {
      report.restore();
    }
  });

  it("carries nothing extra when the operation writes the one field it names", async () => {
    pinRole({
      harnessId: "claude",
      serviceId: "anthropic",
      billingMode: "sub",
      modelId: "claude-opus-5",
      reasoningEffort: "high",
    });

    const card = await propose({
      key: "roles[].model",
      item: ROLE,
      valueText: JSON.stringify({ serviceId: "anthropic", billingMode: "sub", modelId: "claude-sonnet-5" }),
      reason: "why",
    });

    // Same harness, same level: an "also changes" block here would be noise the
    // user has to read past on every ordinary card.
    expect(card.alsoChanges).toBeUndefined();
  });

  it("names the level a reviewer slot's new model substitutes", async () => {
    // A reviewer slot resolves against the credentials this install has, so the
    // fixture needs one before any model is runnable in a slot.
    fx.credentialStore.upsertCredentialRouteWithSecret(
      {
        id: "openrouter-key-fixture",
        serviceId: "openrouter",
        billingMode: "key",
        via: "string",
        status: "ready",
        priority: 0,
        isPrimary: true,
        label: "fixture",
        createdAt: 0,
        updatedAt: 0,
      },
      "sk-or-fixture",
    );
    fx.credentialStore.setReviewerPin("first", {
      serviceId: "openrouter",
      billingMode: "key",
      modelId: "anthropic/claude-opus-5",
      reasoningEffort: "max",
    });

    const card = await propose({
      key: "reviewers[].model",
      item: "first",
      valueText: JSON.stringify({ serviceId: "openrouter", billingMode: "key", modelId: "stealth/ox-alpha" }),
      reason: "why",
    });

    // The slot's writer substitutes a default rather than refusing a level the
    // new model does not offer, so the substitution belongs on the card.
    expect(card.alsoChanges).toHaveLength(1);
    expect(card.alsoChanges?.[0]).toMatchObject({
      label: findSetting("reviewers[].reasoningEffort")!.label,
      from: "max",
    });
    expect(card.alsoChanges?.[0]?.to).not.toBe("max");
  });
});
