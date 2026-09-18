import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { persistTurnInProgress } from "../chat-card-persistence.js";
import { addMcpServer } from "./mcp.js";
import { SETTINGS_CHANGED_EVENT } from "./settings-apply.js";
import { recoverInterruptedProposals, resolveSettingsProposal } from "./settings-decision.js";
import { proposeSettingChange } from "./settings-propose.js";
import { settingsPayloadDomain, withConflictDomains } from "./settings-conflict-domain.js";
import { ServiceError } from "./types.js";
import { claimSettingsProposal } from "./settings-proposal.js";
import { proposalFixture, type ProposalFixture } from "./settings-proposal-test-helpers.js";

/**
 * The click (docs/299-agent-settings-access req 4, plan.md → Applying).
 *
 * The guards here are the ones the design names: one apply per card however many
 * clicks arrive, a claim that a turn snapshot cannot undo, a baseline compared
 * over stored bytes rather than the displayed value, and settlement that needs
 * no runner.
 */

let fx: ProposalFixture;

function post(over: Partial<Parameters<typeof proposeSettingChange>[2]> = {}) {
  return proposeSettingChange(fx.deps, fx.sessionId, {
    key: "advanced.enableSubAgents",
    valueText: "false",
    reason: "the review needs it off",
    ...over,
  });
}

function decide(cardId: string, action: "apply" | "dismiss" = "apply") {
  return resolveSettingsProposal(fx.deps, fx.sessionId, cardId, action);
}

/** A proposal refused before any card exists; the message is the agent's answer. */
async function proposeRefusal(over: Partial<Parameters<typeof post>[0]>): Promise<string> {
  try {
    await post(over);
  } catch (err) {
    if (err instanceof ServiceError) return err.message;
    throw err;
  }
  throw new Error("expected the proposal to be refused");
}

function settingsBroadcasts(): unknown[] {
  return fx.broadcasts.filter((b) => b.event === SETTINGS_CHANGED_EVENT).map((b) => b.data);
}

beforeEach(() => {
  fx = proposalFixture();
});

afterEach(() => {
  fx.close();
});

describe("resolveSettingsProposal — apply", () => {
  it("writes the value through the shared layer and resolves the card as applied", async () => {
    const card = await post();

    const { card: resolved, acted } = await decide(card.cardId);

    expect(acted).toBe(true);
    expect(resolved.phase).toBe("applied");
    expect(resolved.outcome).toContain("off");
    expect(fx.credentialStore.getEnableSubAgents()).toBe(false);
    // The whole act the settings route does, not just the store write.
    expect(settingsBroadcasts()).toHaveLength(1);
    // Both halves of the card's phase, and they cannot disagree.
    expect(fx.proposals.get(card.cardId)?.phase).toBe("applied");
    expect(fx.history.getSettingsProposalCard(fx.sessionId, card.cardId)?.phase).toBe("applied");
  });

  /**
   * A prose card (docs/299-agent-settings-access req 9). Two things the card
   * asserts have to survive the click: what the diff showed is what gets stored,
   * character for character, and the resolved line says what the edit did.
   */
  it("writes exactly the prose its diff showed, and says what the edit did", async () => {
    const before = "Always run the tests before you finish.";
    const promptFile = path.join(fx.tmpDir, ".shipit", "system-prompt.md");
    fs.mkdirSync(path.dirname(promptFile), { recursive: true });
    fs.writeFileSync(promptFile, before);
    const proposed = `${before}\n${"Prefer small, reviewable pull requests. ".repeat(9)}`;

    const card = await post({ key: "instructions.userInstructions", valueText: proposed });
    const { card: resolved } = await decide(card.cardId);

    expect(resolved.phase).toBe("applied");
    // The writer trims and appends one newline, so a card built from the
    // untrimmed text would show a trailing line Apply never writes. The
    // declaration trims too, which is what makes the two agree.
    const stored = fs.readFileSync(promptFile, "utf-8");
    expect(stored).toBe(`${proposed.trim()}\n`);
    expect(card.textChange?.lines.filter((l) => l.kind !== "removed").map((l) => l.text).join("\n"))
      .toBe(stored.trim());
    // "Your Instructions is 398 characters" is true and says nothing about what
    // the user just approved.
    expect(resolved.outcome).toBe(
      `Your Instructions changed (+${card.textChange!.added} −${card.textChange!.removed})`,
    );
  });

  it("produces ONE apply when two decisions arrive for one card", async () => {
    const card = await post();

    const [first, second] = await Promise.all([decide(card.cardId), decide(card.cardId)]);

    // The claim is the test: the loser changed no rows, so it has nothing to
    // apply and says so rather than writing the setting a second time.
    expect([first.acted, second.acted].sort()).toEqual([false, true]);
    expect(settingsBroadcasts()).toHaveLength(1);
    expect(fx.proposals.get(card.cardId)?.phase).toBe("applied");
  });

  it("does not act on a card that is already resolved", async () => {
    const card = await post();
    await decide(card.cardId);
    fx.broadcasts.length = 0;

    const again = await decide(card.cardId);

    expect(again.acted).toBe(false);
    expect(settingsBroadcasts()).toHaveLength(0);
  });

  it("keeps the claim when a turn snapshot rebuilds the in-progress rows", async () => {
    const card = await post();
    claimSettingsProposal(fx.deps, fx.sessionId, card.cardId, "pending", { phase: "applying" });

    // What the next turn snapshot does: rebuild the in-progress rows from the
    // cards the runner is holding. A claim written only to the database is
    // undone here, and the card goes back in front of the user mid-apply.
    persistTurnInProgress(fx.deps.chatHistoryManager, fx.runner, fx.sessionId);

    expect(fx.history.getSettingsProposalCard(fx.sessionId, card.cardId)?.phase).toBe("applying");
    expect(fx.proposals.get(card.cardId)?.phase).toBe("applying");
  });

  it("settles with no runner at all, hours after the turn ended", async () => {
    const card = await post();
    fx.loseRunner();

    const { card: resolved } = await decide(card.cardId);

    expect(resolved.phase).toBe("applied");
    expect(fx.history.getSettingsProposalCard(fx.sessionId, card.cardId)?.phase).toBe("applied");
    expect(fx.credentialStore.getEnableSubAgents()).toBe(false);
  });

  it("adds a host to the allowlist, and says what it did in ShipIt's own words", async () => {
    const card = await post({
      key: "network.egress.hosts[].host",
      operation: "add",
      item: "registry.npmjs.org",
      valueText: undefined,
    });

    const { card: resolved } = await decide(card.cardId);

    expect(resolved.phase).toBe("applied");
    expect(resolved.outcome).toContain("registry.npmjs.org");
    expect(fx.egressAllowlistStore.listHosts("global")).toContain("registry.npmjs.org");
  });
});

describe("resolveSettingsProposal — stale", () => {
  it("applies nothing when the setting moved after the card was written", async () => {
    const card = await post();
    // Somebody else — the dialog, another session's card — writes it first.
    fx.credentialStore.setEnableSubAgents(false);

    const { card: resolved } = await decide(card.cardId);

    expect(resolved.phase).toBe("stale");
    expect(settingsBroadcasts()).toHaveLength(0);
  });

  it("is stale when only a field the card never showed changed", async () => {
    // The projection emits an MCP server's name, transport and enabled flag and
    // nothing else, so this rewrite leaves the card's `from` reading exactly as
    // it did. Comparing that displayed value instead of the stored revision
    // makes this test pass with the defect in place — the whole reason the
    // baseline is taken over the stored object.
    addMcpServer(
      fx.credentialStore,
      { name: "notion", type: "stdio", command: "notion-mcp", args: ["--token=first"] },
      {},
    );
    const card = await post({
      key: "mcp.servers[].enabled",
      item: "notion",
      valueText: "false",
    });
    expect(card.from).toBe("on");

    fx.credentialStore.setMcpServer("notion", {
      name: "notion",
      type: "stdio",
      command: "notion-mcp",
      args: ["--token=second"],
      enabled: true,
    });

    const { card: resolved } = await decide(card.cardId);

    expect(resolved.phase).toBe("stale");
    expect(fx.credentialStore.getMcpServer("notion")?.enabled).toBe(true);
  });
});

describe("the lock spans the check and the write", () => {
  it("waits for a competing write, then sees it — instead of reading in front of it", async () => {
    const card = await post();
    let wrote = false;

    // A dialog save, already holding the payload's domain when the click
    // arrives. Without the decision taking that same lock around its baseline
    // check, it reads the old value while this is still running and overwrites
    // the save it never saw.
    const rival = withConflictDomains([settingsPayloadDomain], async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      fx.credentialStore.setEnableSubAgents(false);
      wrote = true;
    });
    const decision = decide(card.cardId);

    const [, { card: resolved }] = await Promise.all([rival, decision]);

    expect(wrote).toBe(true);
    expect(resolved.phase).toBe("stale");
  });
});

describe("resolveSettingsProposal — refused", () => {
  it("refuses a card for a repository this session no longer binds", async () => {
    fx.close();
    fx = proposalFixture({ remoteUrl: "https://github.com/o/a" });
    const card = await post({ key: "project.allowAgentMerge", valueText: "true", item: undefined });
    // The card froze repository A; the session is rebound to B before the click.
    fx.repoStore.add("https://github.com/o/b");
    fx.sessions.setRemoteUrl(fx.sessionId, "https://github.com/o/b");

    const { card: resolved } = await decide(card.cardId);

    expect(resolved.phase).toBe("refused");
    expect(resolved.outcome).toContain("https://github.com/o/a");
    expect(fx.repoStore.get("https://github.com/o/a")?.allowAgentMerge).toBeFalsy();
  });

  it("refuses a reviewer level the slot cannot take, before any card exists", async () => {
    // The shipped resolver SUBSTITUTES a default for a level a selection does
    // not offer rather than refusing it, which would leave a card saying
    // "banana" and a store holding something else. Refusing is what keeps the
    // card's words and the write the same change.
    const message = await proposeRefusal({
      key: "reviewers[].reasoningEffort",
      item: "first",
      valueText: "banana",
    });
    expect(message).toMatch(/reasoning level|pins no model|harness/);
    expect(fx.proposals.latestForKey("reviewers[].reasoningEffort")).toBeNull();
  });

  it("refuses at apply time what propose accepted, when the target has gone", async () => {
    addMcpServer(fx.credentialStore, { name: "notion", type: "stdio", command: "notion-mcp" }, {});
    const card = await post({ key: "mcp.servers[].enabled", item: "notion", valueText: "false" });

    fx.credentialStore.deleteMcpServer("notion");

    const { card: resolved } = await decide(card.cardId);

    // Stale would also be true here; what matters is that nothing was written
    // and the card says why in words the user can act on.
    expect(["refused", "stale"]).toContain(resolved.phase);
    expect(settingsBroadcasts()).toHaveLength(0);
  });
});

describe("resolveSettingsProposal — dismiss", () => {
  it("resolves the card and writes nothing at all", async () => {
    const card = await post();

    const { card: resolved, acted } = await decide(card.cardId, "dismiss");

    expect(acted).toBe(true);
    expect(resolved.phase).toBe("dismissed");
    expect(resolved.resolvedAt).toBeTruthy();
    // Declining cannot become stale, and it changes nothing.
    expect(fx.credentialStore.getEnableSubAgents()).toBe(true);
    expect(settingsBroadcasts()).toHaveLength(0);
  });

  it("cannot be dismissed twice, and cannot be applied after being dismissed", async () => {
    const card = await post();
    await decide(card.cardId, "dismiss");

    expect((await decide(card.cardId, "dismiss")).acted).toBe(false);
    expect((await decide(card.cardId)).acted).toBe(false);
    expect(fx.credentialStore.getEnableSubAgents()).toBe(true);
  });
});

describe("a decision that names another session's card", () => {
  it("is refused rather than reaching the proposal it shares an id with", async () => {
    const card = await post();
    fx.sessions.track("sess-2", "Another session");

    await expect(resolveSettingsProposal(fx.deps, "sess-2", card.cardId, "apply")).rejects.toThrow(
      /not in this session/,
    );
    expect(fx.proposals.get(card.cardId)?.phase).toBe("pending");
  });
});

describe("recoverInterruptedProposals", () => {
  it("converts a card found mid-apply, and never retries it", async () => {
    const card = await post();
    claimSettingsProposal(fx.deps, fx.sessionId, card.cardId, "pending", { phase: "applying" });

    expect(recoverInterruptedProposals(fx.deps)).toBe(1);

    // Both halves, because boot has no runner to patch either.
    expect(fx.proposals.get(card.cardId)?.phase).toBe("unknown");
    expect(fx.history.getSettingsProposalCard(fx.sessionId, card.cardId)?.phase).toBe("unknown");
    // The side effect may already have run, so nothing runs it again — and a
    // later click finds nothing to claim.
    expect(fx.credentialStore.getEnableSubAgents()).toBe(true);
    expect((await decide(card.cardId)).acted).toBe(false);
  });

  it("leaves a pending card alone: it is the user's to decide, not a leftover", async () => {
    const card = await post();

    expect(recoverInterruptedProposals(fx.deps)).toBe(0);
    expect(fx.proposals.get(card.cardId)?.phase).toBe("pending");
  });
});

/**
 * A card outlives its turn, and the fields one operation re-derives are computed
 * from live state the baseline does not cover — which harnesses are installed,
 * which levels a selection offers (docs/299-agent-settings-access req 4).
 */
describe("the click applies what the card showed, and nothing more", () => {
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

  /**
   * The registry guard says an operation is registered; only propose-then-click
   * says it can be reached. A rename with no baseline reader posts no card at
   * all, and the operation-level tests call `apply` directly, so they cannot see
   * it.
   */
  it("carries a credential rename from the proposal to the stored row", async () => {
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

    const card = await post({
      key: "services.credentials[].label",
      item: "anthropic-key-fixture",
      valueText: "work key",
    });
    const { card: resolved } = await decide(card.cardId);

    expect(resolved.phase).toBe("applied");
    expect(fx.credentialStore.getCredentialRoute("anthropic-key-fixture")?.label).toBe("work key");
  });

  it("carries a provider-account rename from the proposal to the stored account", async () => {
    fx.close();
    fx = proposalFixture({ providerAccounts: true });
    fx.credentialStore.upsertCredentialRoute({
      id: "acct-1",
      serviceId: "anthropic",
      billingMode: "sub",
      via: "account",
      status: "ready",
      priority: 0,
      isPrimary: true,
      label: "the old name",
      createdAt: 0,
      updatedAt: 0,
    });

    // The read addresses an account by its SERVICE; the writer takes the harness
    // whose sign-in owns that service, and passing the address's half straight
    // through refused every rename at the click.
    const card = await post({
      key: "services.providerAccounts[].label",
      item: "anthropic:acct-1",
      valueText: "work account",
    });
    const { card: resolved } = await decide(card.cardId);

    expect(resolved.phase).toBe("applied");
    expect(fx.credentialStore.getCredentialRoute("acct-1")?.label).toBe("work account");
  });

  it("carries a role rename from the proposal to the stored role", async () => {
    fx.credentialStore.setRole("deep-dive", {
      name: "deep-dive",
      prompt: "standing instructions",
      params: {
        kind: "pinned",
        harnessId: "claude",
        serviceId: "anthropic",
        billingMode: "sub",
        modelId: "claude-opus-5",
      },
    });

    const card = await post({ key: "roles[].name", item: "deep-dive", valueText: "auditor" });
    const { card: resolved } = await decide(card.cardId);

    expect(resolved.phase).toBe("applied");
    expect(fx.credentialStore.getRole("deep-dive")).toBeUndefined();
    expect(fx.credentialStore.getRole("auditor")?.prompt).toBe("standing instructions");
  });

  it("refuses when the harness it would now re-derive is not the one on the card", async () => {
    let report = installReport(["claude", "opencode"]);
    try {
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
      // Both harnesses speak this model, so the role keeps its own and the card
      // shows a model change alone.
      const card = await post({
        key: "roles[].model",
        item: "deep-dive",
        valueText: JSON.stringify({ serviceId: "zai", billingMode: "sub", modelId: "glm-5.3[1m]" }),
      });
      expect(card.alsoChanges).toBeUndefined();

      // The role's own harness is uninstalled before the click, so applying
      // would now move the role onto opencode — a change nobody approved.
      report.restore();
      report = installReport(["opencode"]);
      const { card: resolved } = await decide(card.cardId);

      expect(resolved.phase).toBe("refused");
      expect(resolved.outcome).toContain("does not show");
      expect(resolved.outcomeDetail).toContain("opencode");
      // Refused means nothing was written.
      expect(fx.credentialStore.getRole("deep-dive")?.params).toMatchObject({
        harnessId: "claude",
        modelId: "claude-opus-5",
      });
    } finally {
      report.restore();
    }
  });
});
