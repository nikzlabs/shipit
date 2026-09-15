import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  allHarnesses,
  allServices,
  catalogueModelIdsForHarness,
  reasoningOptionsFor,
} from "../../shared/catalogue/index.js";
import { findSetting } from "../../shared/settings-catalogue/index.js";
import type { SettingsProposalCard } from "../../shared/types.js";
import { resolveSettingsProposal, storedValueMismatch } from "./settings-decision.js";
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

/**
 * A model swap that costs the role its reasoning level, found in the catalogue
 * rather than named: a test that hard-codes two model ids fails the day either
 * is retired, about something that has nothing to do with the level.
 */
function levelDroppingSwap(): {
  harnessId: string;
  from: { serviceId: string; billingMode: string; modelId: string };
  to: { serviceId: string; billingMode: string; modelId: string };
  level: string;
} {
  for (const harness of allHarnesses()) {
    // Only models this harness can actually run: a swap it cannot speak to is
    // refused before the card exists, which is a different test.
    const speaks = new Set(catalogueModelIdsForHarness(harness.id));
    const selections = allServices().flatMap((service) =>
      service.modes.flatMap((mode) =>
        mode.models
          .filter((model) => speaks.has(model.id))
          .map((model) => ({
            serviceId: service.id,
            billingMode: mode.kind,
            modelId: model.id,
          }))));
    for (const from of selections) {
      for (const option of reasoningOptionsFor(harness.id, from as never)) {
        const to = selections.find((candidate) =>
          candidate.modelId !== from.modelId
          && !reasoningOptionsFor(harness.id, candidate as never).some((o) => o.value === option.value));
        if (to) return { harnessId: harness.id, from, to, level: option.value };
      }
    }
  }
  throw new Error("No catalogue pair drops a reasoning level, so this fixture cannot be built");
}

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

describe("a clear the install would immediately undo", () => {
  const PIN = "services.nonTurnModel";

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

  it("refuses at the click when the install became able to seed after the card", async () => {
    // A card outlives its turn, so eligibility is checked again inside the
    // lock. Proposing the clear was honest when nothing could be seeded; by
    // the time the user clicked it was not.
    fx.credentialStore.stampNonTurnModel({
      serviceId: "anthropic",
      billingMode: "sub",
      modelId: "claude-opus-5",
    });
    const card = await propose({ key: PIN, valueText: "null", reason: "unpin it" });

    configureDirectCredential();
    const { card: resolved } = await resolveSettingsProposal(fx.deps, fx.sessionId, card.cardId, "apply");

    expect(resolved.phase).toBe("refused");
    expect(resolved.outcome).toContain("does not leave it unset");
    expect(fx.credentialStore.getNonTurnModel()).toBeDefined();
  });
});

describe("a writer that drops an empty value", () => {
  const EFFORT = "roles[].reasoningEffort";
  const ROLE = "deep-dive";

  /**
   * A pinned role on whatever this catalogue offers a reasoning level for.
   * Naming a model and a level here would make an unrelated catalogue edit —
   * a retired model, a harness that stops offering a level — fail a test about
   * an empty string.
   */
  function pinRole(level?: string) {
    for (const harness of allHarnesses()) {
      for (const service of allServices()) {
        for (const mode of service.modes) {
          for (const model of mode.models) {
            const selection = { serviceId: service.id, billingMode: mode.kind, modelId: model.id };
            const [option] = reasoningOptionsFor(harness.id, selection);
            if (!option) continue;
            fx.credentialStore.setRole(ROLE, {
              name: ROLE,
              params: {
                kind: "pinned",
                harnessId: harness.id,
                ...selection,
                ...(level ? { reasoningEffort: level === "first" ? option.value : level } : {}),
              },
            } as never);
            return level === "first" ? option.value : level;
          }
        }
      }
    }
    throw new Error("The catalogue offers no harness a reasoning level in this fixture");
  }

  it("shows clearing a role's reasoning level as the 'not set' the role stores", async () => {
    const level = pinRole("first");

    // `pinned()` stores nothing for an empty level, so a card showing `""`
    // named a value the role never holds — and the apply would then read the
    // level back as "not set" and report a successful clear as a mismatch.
    const card = await propose({ key: EFFORT, item: ROLE, valueText: "", reason: "use the default" });

    expect(card.from).toBe(`"${level}"`);
    expect(card.to).toBe("not set");

    const { card: resolved } = await resolveSettingsProposal(fx.deps, fx.sessionId, card.cardId, "apply");

    expect(resolved.phase).toBe("applied");
    const params = fx.credentialStore.getRole(ROLE)?.params as { reasoningEffort?: string };
    expect(params.reasoningEffort).toBeUndefined();
  });

  it("refuses the same clear on a role that sets no level", async () => {
    pinRole();

    expect(await refusal({ key: EFFORT, item: ROLE, valueText: "", reason: "why" }))
      .toContain("already not set");
  });

  it("still names a stored level no harness offers, rather than hiding it as unset", async () => {
    // The normalisation is about the EMPTY string and nothing else. Reading a
    // stale level back as "not set" would tell the user the field is clear
    // while the role is stranded on a level nothing honours — and would leave
    // the clear that fixes it refused as "already not set".
    pinRole("ultra-stale");

    const entry = await getSettingForAgent(fx.deps.read, fx.sessionId, EFFORT);
    expect(entry.items?.find((item) => item.address === ROLE)?.display).toBe('"ultra-stale"');

    const card = await propose({ key: EFFORT, item: ROLE, valueText: "", reason: "clear it" });
    expect(card.from).toBe('"ultra-stale"');
    expect(card.to).toBe("not set");
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

  it("does not report a write that landed as `partial` because the read stopped listing it", async () => {
    fx.credentialStore.upsertCredentialRouteWithSecret(
      {
        id: "anthropic-sub-fixture",
        serviceId: "anthropic",
        billingMode: "sub",
        via: "string",
        status: "ready",
        priority: 0,
        isPrimary: true,
        label: "fixture",
        createdAt: 0,
        updatedAt: 0,
      },
      "sk-ant-sub-fixture",
    );
    const card = await propose({
      key: "services.failoverCutoff.session",
      item: "anthropic:sub",
      valueText: "80",
      reason: "fail over earlier",
    });

    // The read lists a service/mode setting only while that pair has a
    // credential (`settings-store-readers.ts` → `modePairs`), so dropping it
    // takes the address off the read without touching the stored cutoff. The
    // baseline covers the cutoffs and still matches, so the write goes through.
    fx.credentialStore.deleteCredentialRoute("anthropic-sub-fixture");

    const { card: resolved } = await resolveSettingsProposal(fx.deps, fx.sessionId, card.cardId, "apply");

    expect(resolved.phase).toBe("applied");
    expect(fx.credentialStore.getFailoverCutoffs("anthropic", "sub").session).toBe(80);
  });

  it("reports a side change the write dropped, which the card also promised", async () => {
    const ROLE = "deep-dive";
    const swap = levelDroppingSwap();
    fx.credentialStore.setRole(ROLE, {
      name: ROLE,
      params: { kind: "pinned", harnessId: swap.harnessId, ...swap.from, reasoningEffort: swap.level },
    } as never);

    const card = await propose({
      key: "roles[].model",
      item: ROLE,
      valueText: JSON.stringify(swap.to),
      reason: "a better model",
    });
    // The card promises the model AND the level the new selection cannot
    // honour. The user approves all of it, so all of it is what "applied" has
    // to mean.
    expect(card.alsoChanges?.some((side) => side.key === "roles[].reasoningEffort")).toBe(true);

    // A writer that lands its own field and keeps the neighbour — the one shape
    // a check of the named field alone cannot see.
    const real = fx.credentialStore.setRole.bind(fx.credentialStore);
    vi.spyOn(fx.credentialStore, "setRole").mockImplementation((name, role) =>
      real(name, role && name === ROLE
        ? { ...role, params: { ...role.params, reasoningEffort: swap.level } } as never
        : role));

    const { card: resolved } = await resolveSettingsProposal(fx.deps, fx.sessionId, card.cardId, "apply");

    expect(resolved.phase).toBe("partial");
    expect(resolved.outcomeDetail).toContain(swap.level);
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

  function card(over: Partial<SettingsProposalCard>): SettingsProposalCard {
    return over as SettingsProposalCard;
  }

  it("names both values when the store disagrees with the card", async () => {
    fx.credentialStore.setDeclaredSetting(BUDGET, 2048);

    const message = storedValueMismatch(
      declaration,
      { operation: "set", target: { key: BUDGET }, proposed: 8192 },
      card({ to: "8192" }),
      await getSettingForAgent(fx.deps.read, fx.sessionId, BUDGET),
    );

    expect(message).toContain("8192");
    expect(message).toContain("2048");
  });

  describe("a prose card", () => {
    const ROLE = "deep-dive";

    async function proseMismatch(approved: string): Promise<string | null> {
      return storedValueMismatch(
        findSetting("roles[].prompt")!,
        { operation: "set", target: { key: "roles[].prompt", item: ROLE }, proposed: approved },
        // What a prose card actually carries: ShipIt's summary of the text,
        // never the text. The diff itself lives in `textChange`.
        card({
          to: "300 characters",
          textChange: { added: 1, removed: 1 } as SettingsProposalCard["textChange"],
        }),
        await getSettingForAgent(fx.deps.read, fx.sessionId, "roles[].prompt"),
      );
    }

    beforeEach(() => {
      fx.credentialStore.setRole(ROLE, {
        name: ROLE,
        prompt: "C".repeat(300),
        params: {
          kind: "pinned",
          harnessId: allHarnesses()[0]!.id,
          serviceId: "anthropic",
          billingMode: "sub",
          modelId: "claude-opus-5",
        },
      } as never);
    });

    it("is quiet when the store holds the approved text", async () => {
      // The half that makes the next case a guard rather than a coincidence:
      // comparing the card's summary against the stored text would report a
      // mismatch HERE, where there is none.
      expect(await proseMismatch("C".repeat(300))).toBeNull();
    });

    it("catches a rewrite of the same length, which the summary cannot see", async () => {
      expect(await proseMismatch("B".repeat(300))).toContain("roles[].prompt");
    });
  });

  it("says nothing about an instance the read no longer lists", async () => {
    // The address left the read; that is not a fact about the write. A rename
    // retires the name the card was addressed by, and a service/mode setting
    // stops being listed the moment its last credential goes — both are writes
    // that landed.
    const message = storedValueMismatch(
      findSetting("roles[].name")!,
      { operation: "set", target: { key: "roles[].name", item: "old-name" }, proposed: "new-name" },
      card({ to: "new-name" }),
      await getSettingForAgent(fx.deps.read, fx.sessionId, "roles[].name"),
    );

    expect(message).toBeNull();
  });
});
