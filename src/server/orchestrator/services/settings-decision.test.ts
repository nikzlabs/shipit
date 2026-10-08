import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import { listRolesForAgent } from "./spawn-inventory.js";
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

  it("applies two pending host cards one after the other", async () => {
    const addHost = (item: string) =>
      post({ key: "network.egress.hosts[].host", operation: "add", item, valueText: undefined });
    const first = await addHost("api.example.com");
    const second = await addHost("cdn.example.com");

    expect((await decide(first.cardId)).card.phase).toBe("applied");
    expect((await decide(second.cardId)).card.phase).toBe("applied");
    expect(fx.egressAllowlistStore.listHosts("global"))
      .toEqual(expect.arrayContaining(["api.example.com", "cdn.example.com"]));
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

  it("is stale when the card's own host moved", async () => {
    const card = await post({
      key: "network.egress.hosts[].host",
      operation: "add",
      item: "api.example.com",
      valueText: undefined,
    });
    fx.egressAllowlistStore.addHost("global", "api.example.com");

    expect((await decide(card.cardId)).card.phase).toBe("stale");
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

describe("resolveSettingsProposal — the Docker socket grant (docs/318-compose-remaining-escapes req 8)", () => {
  it("is written only by the user's accept on the card", async () => {
    fx.close();
    fx = proposalFixture({ remoteUrl: "https://github.com/o/a" });
    const card = await post({ key: "project.allowDockerSocket", valueText: "true", item: undefined });
    expect(fx.repoStore.allowsDockerSocket("https://github.com/o/a")).toBe(false);

    const { card: resolved } = await decide(card.cardId);

    expect(resolved.phase).toBe("applied");
    expect(fx.repoStore.allowsDockerSocket("https://github.com/o/a")).toBe(true);
    expect(fx.repoStore.allowsAgentMerge("https://github.com/o/a")).toBe(false);
  });

  it("writes nothing when the card is dismissed", async () => {
    fx.close();
    fx = proposalFixture({ remoteUrl: "https://github.com/o/a" });
    const card = await post({ key: "project.allowDockerSocket", valueText: "true", item: undefined });

    await decide(card.cardId, "dismiss");

    expect(fx.repoStore.allowsDockerSocket("https://github.com/o/a")).toBe(false);
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

describe("a decision on a card that has left the transcript (docs/324-scheduled-sessions plan.md → Cards)", () => {
  it("is refused before anything is written, whatever the action", async () => {
    const card = await post();
    fx.dbManager.db.prepare("DELETE FROM messages WHERE session_id = ?").run(fx.sessionId);
    fx.emitted.length = 0;
    // A claim that runs and then rolls back ends in the same state; the refusal
    // must come before any write is tried.
    const claimPhase = vi.spyOn(fx.proposals, "claimPhase");
    const setPhase = vi.spyOn(fx.proposals, "setPhase");

    for (const action of ["apply", "dismiss"] as const) {
      await expect(decide(card.cardId, action)).rejects.toThrow(/not in this session/);
    }
    expect(claimPhase).not.toHaveBeenCalled();
    expect(setPhase).not.toHaveBeenCalled();
    expect(fx.proposals.get(card.cardId)?.phase).toBe("pending");
    expect(fx.credentialStore.getEnableSubAgents()).toBe(true);
    expect(settingsBroadcasts()).toHaveLength(0);
    expect(fx.emitted).toEqual([]);
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

describe("the click applies what the card showed, and nothing more", () => {
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

/**
 * docs/299-agent-settings-access req 10 — the click creates the role the card
 * showed, through the dialog's own create.
 */
describe("creating a role from a card", () => {
  const OPUS = { serviceId: "anthropic", billingMode: "sub", modelId: "claude-opus-5" } as const;
  let report: { restore: () => void };

  beforeEach(() => {
    report = installReport(["claude"]);
  });

  afterEach(() => {
    report.restore();
  });

  function proposeRole(name: string, body: Record<string, unknown> = { model: OPUS }) {
    return post({ key: "roles", operation: "add", item: name, valueText: JSON.stringify(body) });
  }

  it("creates the role, and `shipit agent roles` lists it", async () => {
    const prompt = Array.from({ length: 30 }, (_, i) => `Rule ${i}: read the code before answering.`).join("\n");
    const card = await proposeRole("deep-dive", {
      model: OPUS,
      reasoningEffort: "high",
      description: "Open-ended research into how this codebase works.",
      prompt,
    });

    const { card: resolved } = await decide(card.cardId);

    // `applied`, not `partial`: every field the card showed is read back at the
    // new role's address, the long instructions against the approved text.
    expect(resolved.phase).toBe("applied");
    expect(resolved.outcome).toBe("created the deep-dive role");
    expect(fx.credentialStore.getRole("deep-dive")).toEqual({
      name: "deep-dive",
      description: "Open-ended research into how this codebase works.",
      prompt,
      params: { kind: "pinned", harnessId: "claude", ...OPUS, reasoningEffort: "high" },
    });
    expect(listRolesForAgent({ credentialStore: fx.credentialStore }).map((role) => role.name))
      .toContain("deep-dive");
    expect(settingsBroadcasts()).toHaveLength(1);
  });

  it("applies two creations in either order: each card is about its own role", async () => {
    // The restore that asked for this is nine cards. A baseline over the whole
    // list would make the first click stale every other one.
    const first = await proposeRole("researcher");
    const second = await proposeRole("auditor");

    expect((await decide(second.cardId)).card.phase).toBe("applied");
    expect((await decide(first.cardId)).card.phase).toBe("applied");
    expect(fx.credentialStore.getRole("researcher")).toBeDefined();
    expect(fx.credentialStore.getRole("auditor")).toBeDefined();
  });

  it("goes stale, and overwrites nothing, when the name is taken before the click", async () => {
    const card = await proposeRole("deep-dive");
    fx.credentialStore.setRole("deep-dive", {
      name: "deep-dive",
      description: "made in the dialog",
      params: { kind: "pinned", harnessId: "claude", ...OPUS },
    });

    const { card: resolved } = await decide(card.cardId);

    expect(resolved.phase).toBe("stale");
    expect(fx.credentialStore.getRole("deep-dive")?.description).toBe("made in the dialog");
  });

  it("writes nothing when the card is dismissed", async () => {
    const card = await proposeRole("deep-dive");
    await decide(card.cardId, "dismiss");
    expect(fx.credentialStore.getRole("deep-dive")).toBeUndefined();
  });

  it("says so when the store holds other instructions than the card showed, however alike in size", async () => {
    const prompt = Array.from({ length: 30 }, (_, i) => `Rule ${i}: read the code before answering.`).join("\n");
    const card = await proposeRole("deep-dive", { model: OPUS, prompt });
    // A writer that keeps the length and changes the words: the card's summary
    // ("N characters") cannot tell the two apart, and the approved text can.
    const setRole = fx.credentialStore.setRole.bind(fx.credentialStore);
    vi.spyOn(fx.credentialStore, "setRole").mockImplementation((name, role) =>
      setRole(name, role ? { ...role, prompt: role.prompt?.replace("Rule 0", "Rule X") } : role));

    const { card: resolved } = await decide(card.cardId);

    expect(resolved.phase).toBe("partial");
    expect(resolved.outcomeDetail).toContain("Standing instructions does not now hold the text");
  });

  it("refuses when the harness it derived is uninstalled before the click", async () => {
    // Both speak this model, and the card was written while the role would
    // land on claude.
    report.restore();
    report = installReport(["claude", "opencode"]);
    const card = await proposeRole("deep-dive", {
      model: { serviceId: "zai", billingMode: "sub", modelId: "glm-5.3[1m]" },
    });
    expect(card.alsoChanges?.find((side) => side.key === "roles[].harness")?.to).toBe('"claude"');

    report.restore();
    report = installReport(["opencode"]);
    const { card: resolved } = await decide(card.cardId);

    expect(resolved.phase).toBe("refused");
    expect(resolved.outcomeDetail).toContain("opencode");
    expect(fx.credentialStore.getRole("deep-dive")).toBeUndefined();
  });
});

/** docs/299-agent-settings-access req 11 — the click deletes the role the card showed. */
describe("deleting a role from a card", () => {
  const OPUS = { serviceId: "anthropic", billingMode: "sub", modelId: "claude-opus-5" } as const;

  it("deletes it, and `shipit agent roles` no longer lists it", async () => {
    fx.credentialStore.setRole("deep-dive", {
      name: "deep-dive",
      description: "Open-ended research.",
      params: { kind: "pinned", harnessId: "claude", ...OPUS },
    });
    const card = await post({ key: "roles", operation: "remove", item: "deep-dive" });

    const { card: resolved } = await decide(card.cardId);

    // Not `partial`: a side read back at an address that is gone says nothing.
    expect(resolved.phase).toBe("applied");
    expect(resolved.outcome).toBe("deleted the deep-dive role");
    expect(fx.credentialStore.getRole("deep-dive")).toBeUndefined();
    expect(listRolesForAgent({ credentialStore: fx.credentialStore }).map((role) => role.name))
      .not.toContain("deep-dive");
  });

  it("goes stale, and deletes nothing, when the role changed before the click", async () => {
    fx.credentialStore.setRole("deep-dive", { name: "deep-dive", params: { kind: "pinned", harnessId: "claude", ...OPUS } });
    const card = await post({ key: "roles", operation: "remove", item: "deep-dive" });
    fx.credentialStore.setRole("deep-dive", {
      name: "deep-dive",
      description: "edited in the dialog",
      params: { kind: "pinned", harnessId: "claude", ...OPUS },
    });

    expect((await decide(card.cardId)).card.phase).toBe("stale");
    expect(fx.credentialStore.getRole("deep-dive")?.description).toBe("edited in the dialog");
  });
});

/** docs/299-agent-settings-access req 11 and req 12 — the click creates the server, with no secret value. */
describe("creating an MCP server from a card", () => {
  function proposeServer(name: string, body: Record<string, unknown>) {
    return post({ key: "mcp.servers", operation: "add", item: name, valueText: JSON.stringify(body) });
  }

  it("stores the configuration, placeholders for the secrets, and no secret value", async () => {
    const card = await proposeServer("github", {
      type: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
      env: ["GITHUB_PERSONAL_ACCESS_TOKEN"],
    });

    const { card: resolved } = await decide(card.cardId);

    expect(resolved.phase).toBe("applied");
    expect(fx.credentialStore.getMcpServer("github")).toEqual({
      name: "github",
      type: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
      env: { GITHUB_PERSONAL_ACCESS_TOKEN: "$secret:mcp__github__GITHUB_PERSONAL_ACCESS_TOKEN" },
      enabled: true,
    });
    expect(Object.keys(fx.credentialStore.getAllAgentEnv()).filter((key) => key.startsWith("mcp__github__")))
      .toEqual([]);
    // What the user still has to do, and where, in ShipIt's own words.
    expect(resolved.outcome).toContain('"GITHUB_PERSONAL_ACCESS_TOKEN"');
    expect(resolved.outcome).toContain("Settings › Integrations › MCP servers");
  });

  it("names a header's placeholder so the panel's form can fill it", async () => {
    const card = await proposeServer("linear", { type: "http", url: "https://mcp.linear.app/mcp", headers: ["X-Api-Key"] });
    await decide(card.cardId);
    expect(fx.credentialStore.getMcpServer("linear")).toMatchObject({
      headers: { "X-Api-Key": "$secret:mcp__linear__X_Api_Key" },
    });
  });

  it("never points a placeholder at a value already stored, which would fill it with no one typing it", async () => {
    // Left by an earlier server of this name, kept because another server uses it.
    fx.credentialStore.setMcpSecret("mcp__linear__Authorization", "Bearer old-token");
    const card = await proposeServer("linear", { type: "http", url: "https://mcp.linear.app/mcp", headers: ["Authorization"] });
    await decide(card.cardId);
    expect(fx.credentialStore.getMcpServer("linear")).toMatchObject({
      headers: { Authorization: "$secret:mcp__linear__Authorization_2" },
    });
  });

  it("applies two creations in either order", async () => {
    const first = await proposeServer("github", { type: "stdio", command: "npx" });
    const second = await proposeServer("linear", { type: "http", url: "https://mcp.linear.app/mcp" });
    expect((await decide(second.cardId)).card.phase).toBe("applied");
    expect((await decide(first.cardId)).card.phase).toBe("applied");
  });
});

/** docs/299-agent-settings-access req 11 — the click deletes the server and its stored secrets. */
describe("deleting an MCP server from a card", () => {
  it("deletes the server and the secret values stored for it", async () => {
    addMcpServer(
      fx.credentialStore,
      {
        name: "github",
        type: "stdio",
        command: "npx",
        env: { GITHUB_PERSONAL_ACCESS_TOKEN: "$secret:mcp__github__GITHUB_PERSONAL_ACCESS_TOKEN" },
      },
      { mcp__github__GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_secret" },
    );
    const card = await post({ key: "mcp.servers", operation: "remove", item: "github" });

    const { card: resolved } = await decide(card.cardId);

    expect(resolved.phase).toBe("applied");
    expect(resolved.outcome).toBe("deleted the github MCP server");
    expect(fx.credentialStore.getMcpServer("github")).toBeUndefined();
    expect(fx.credentialStore.getAllAgentEnv()).not.toHaveProperty("mcp__github__GITHUB_PERSONAL_ACCESS_TOKEN");
  });

  it("goes stale when a secret value was replaced before the click, and deletes nothing", async () => {
    addMcpServer(
      fx.credentialStore,
      {
        name: "github",
        type: "stdio",
        command: "npx",
        env: { GITHUB_PERSONAL_ACCESS_TOKEN: "$secret:mcp__github__GITHUB_PERSONAL_ACCESS_TOKEN" },
      },
      { mcp__github__GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_old" },
    );
    const card = await post({ key: "mcp.servers", operation: "remove", item: "github" });
    // Rotated in the panel: the configuration is the same, the value is not.
    fx.credentialStore.setMcpSecret("mcp__github__GITHUB_PERSONAL_ACCESS_TOKEN", "ghp_new");

    expect((await decide(card.cardId)).card.phase).toBe("stale");
    expect(fx.credentialStore.getMcpServer("github")).toBeDefined();
    expect(fx.credentialStore.getAllAgentEnv().mcp__github__GITHUB_PERSONAL_ACCESS_TOKEN).toBe("ghp_new");
  });
});
