import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findSetting } from "../../shared/settings-catalogue/index.js";
import { resolveSettingsProposal, storedValueMismatch } from "./settings-decision.js";
import { findOperation } from "./settings-operations.js";
import { proposeSettingChange } from "./settings-propose.js";
import { getSettingForAgent } from "./settings-read.js";
import { nonTurnModelSeedCandidate } from "./settings.js";
import { ServiceError } from "./types.js";
import { proposalFixture, type ProposalFixture } from "./settings-proposal-test-helpers.js";

/**
 * A card names the exact change the click applies
 * (docs/299-agent-settings-access req 4).
 *
 * Not the click gate — `settings-decision.test.ts` owns that — but the other
 * half of the requirement: that what the card displays is what the store ends
 * up holding. Two shipped proposals showed one thing and stored another, and
 * the defences here are prospective first (the value is normalised before it is
 * displayed, a change that cannot be shown truthfully is refused) with the
 * store's own read-back as the last word.
 */

let fx: ProposalFixture;

beforeEach(() => {
  fx = proposalFixture();
});

afterEach(() => {
  vi.restoreAllMocks();
  fx.close();
});

function propose(input: Parameters<typeof proposeSettingChange>[2]) {
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

/** What `shipit settings get` says the setting is, after the click. */
async function displayNow(key: string): Promise<string> {
  return (await getSettingForAgent(fx.deps.read, fx.sessionId, key)).display;
}

const BUDGET = "advanced.memoryBudgetMb";

describe("a declaration that normalises shows the normalised value", () => {
  it("names a budget of 0 as the 'not set' it becomes, and stores that", async () => {
    fx.credentialStore.setDeclaredSetting(BUDGET, 4096);

    const card = await propose({ key: BUDGET, valueText: "0", reason: "let the host decide" });

    // Serialising 0 removes the field, so "4096 → 0" was a change the click
    // could not make: the user approved a budget of nothing and got the
    // install's default.
    expect(card.from).toBe("4096");
    expect(card.to).toBe("not set");

    const { card: resolved } = await resolveSettingsProposal(fx.deps, fx.sessionId, card.cardId, "apply");

    expect(resolved.phase).toBe("applied");
    expect(fx.credentialStore.getDeclaredSetting(BUDGET)).toBeNull();
    expect(await displayNow(BUDGET)).toBe(card.to);
  });

  it("refuses a budget of 0 on an install that already follows the host", async () => {
    // The same normalisation, one step earlier: with the value shown as what it
    // becomes, this is a card that would change nothing — which a proposal has
    // always refused rather than posted.
    expect(await refusal({ key: BUDGET, valueText: "0", reason: "why" }))
      .toContain("already not set");
  });
});

describe("a clear the install would immediately undo", () => {
  const PIN = "services.nonTurnModel";

  function configureDirectCredential() {
    fx.credentialStore.upsertCredentialRouteWithSecret(
      {
        id: "anthropic-key-fixture",
        serviceId: "anthropic",
        billingMode: "key",
        via: "string",
        status: "ready",
        priority: 0,
        isPrimary: true,
        label: "fixture",
        createdAt: 0,
        updatedAt: 0,
      },
      "sk-ant-fixture",
    );
  }

  it("refuses to clear the background-model pin while a model is eligible", async () => {
    configureDirectCredential();
    const seeded = nonTurnModelSeedCandidate(fx.credentialStore, fx.deps.operations.agentRegistry);
    expect(seeded).toBeDefined();
    fx.credentialStore.stampNonTurnModel(seeded!);

    const message = await refusal({ key: PIN, valueText: "null", reason: "let ShipIt choose" });

    // The save hook reseeds the pin the moment the clear is stored, and so does
    // every build of the settings payload — so "not set" is not a state this
    // setting can be left in, and a card is not the place to find that out.
    expect(message).toContain("does not leave it unset");
    expect(fx.credentialStore.getNonTurnModel()).toEqual(seeded);
  });

  it("allows the clear where nothing would be seeded in its place", async () => {
    // No credential is configured, so clearing really does clear. The refusal
    // is about what the install would do, not about the setting.
    fx.credentialStore.stampNonTurnModel({
      serviceId: "anthropic",
      billingMode: "sub",
      modelId: "claude-opus-5",
    });

    const card = await propose({ key: PIN, valueText: "null", reason: "unpin it" });
    const { card: resolved } = await resolveSettingsProposal(fx.deps, fx.sessionId, card.cardId, "apply");

    expect(card.to).toBe("not set");
    expect(resolved.phase).toBe("applied");
    expect(fx.credentialStore.getNonTurnModel()).toBeUndefined();
  });
});

describe("the store has the last word on what was applied", () => {
  it("reports `partial` when the write stored something the card never showed", async () => {
    fx.credentialStore.setDeclaredSetting(BUDGET, 4096);
    const card = await propose({ key: BUDGET, valueText: "8192", reason: "more room" });

    // A writer that stores its own value instead of the approved one — the
    // shape a save hook takes when it seeds or derives a neighbour. Nothing
    // before the write can see this, which is why the read-back exists.
    const real = fx.credentialStore.setDeclaredSetting.bind(fx.credentialStore);
    vi.spyOn(fx.credentialStore, "setDeclaredSetting").mockImplementation((key, value) =>
      real(key, key === BUDGET ? 2048 : value));

    const { card: resolved } = await resolveSettingsProposal(fx.deps, fx.sessionId, card.cardId, "apply");

    expect(resolved.phase).toBe("partial");
    expect(resolved.outcomeDetail).toContain("8192");
    expect(resolved.outcomeDetail).toContain("2048");
  });

  it("says nothing when the store holds what the card showed", async () => {
    fx.credentialStore.setDeclaredSetting(BUDGET, 4096);
    const card = await propose({ key: BUDGET, valueText: "8192", reason: "more room" });

    const { card: resolved } = await resolveSettingsProposal(fx.deps, fx.sessionId, card.cardId, "apply");

    expect(resolved.phase).toBe("applied");
    expect(resolved.outcomeDetail).toBeUndefined();
  });
});

describe("storedValueMismatch", () => {
  const declaration = findSetting(BUDGET)!;
  const operation = findOperation(declaration, "set")!;

  async function entry() {
    return getSettingForAgent(fx.deps.read, fx.sessionId, BUDGET);
  }

  it("names both values when the store disagrees with the card", async () => {
    fx.credentialStore.setDeclaredSetting(BUDGET, 2048);
    const card = { to: "8192", target: { key: BUDGET } } as Parameters<typeof storedValueMismatch>[2];

    const message = storedValueMismatch(
      declaration,
      { operation: "set", target: { key: BUDGET } },
      card,
      operation,
      await entry(),
    );

    expect(message).toContain("8192");
    expect(message).toContain("2048");
  });

  it("stays quiet for an operation that renames the entry the card addresses", async () => {
    const rename = findOperation(findSetting("roles[].name")!, "set")!;
    expect(rename.renamesItem).toBe(true);

    // The card is addressed by the OLD name, so reading it back finds nothing —
    // which is the rename working, not a write that went astray.
    const message = storedValueMismatch(
      findSetting("roles[].name")!,
      { operation: "set", target: { key: "roles[].name", item: "old-name" } },
      { to: "new-name" } as Parameters<typeof storedValueMismatch>[2],
      rename,
      await getSettingForAgent(fx.deps.read, fx.sessionId, "roles[].name"),
    );

    expect(message).toBeNull();
  });
});
