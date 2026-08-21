import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { CredentialRoute } from "../../shared/types.js";
import type { ModelSelection } from "../../shared/catalogue/index.js";
import type { CredentialStore } from "../credential-store.js";
import type { AgentRegistry } from "../../shared/agent-registry.js";

/**
 * docs/252 req 9 — **the setting is written once, and ShipIt never writes over
 * it.**
 *
 * Those are two separate promises and this file pins both, because breaking
 * either one re-creates what the requirement removed. Fail the first and the
 * setting is empty while a service exists, which is the state the screen could
 * not name. Fail the second and ShipIt re-points the user's choice behind their
 * back, which is the whole of *"the default becomes the changeable setting, so
 * ShipIt does not update it anymore."*
 *
 * The last three cases are cross-backend review findings, and each is a way for
 * a *permanent* write to be made from something that was never a settled fact:
 * a sign-in still in flight, a harness only assumed installed, and a write that
 * never reached the disk.
 *
 * The real catalogue drives every case, as in `non-turn-model.test.ts`: what is
 * seeded is "the first eligible model in the picker's own ordering", which is a
 * statement about that catalogue rather than about a fixture.
 */

function route(over: Partial<CredentialRoute> & Pick<CredentialRoute, "serviceId" | "billingMode">): CredentialRoute {
  return {
    id: `${over.serviceId}-${over.billingMode}`,
    via: "string",
    status: "ready",
    priority: 0,
    isPrimary: true,
    label: "test",
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

/** Every harness installed, which is the uninteresting case for the seed. */
function registry(installed: string[] = ["claude", "codex"]): AgentRegistry {
  return {
    list: () => ["claude", "codex"].map((id) => ({
      id,
      name: id,
      installed: installed.includes(id),
      hasRunnableModels: true,
      capabilities: { models: [], supportsReview: true, supportsSteering: true, supportsCompaction: true, supportedPermissionModes: ["auto"], skillInvocationPrefix: "/" },
    })),
  } as unknown as AgentRegistry;
}

/** A store that records what was written, so "wrote nothing" is assertable. */
function storeWith(
  routes: CredentialRoute[],
  stored?: ModelSelection,
  opts: { writeFails?: boolean } = {},
) {
  const writes: (ModelSelection | null)[] = [];
  let current = stored;
  const store = {
    getNonTurnModel: () => current,
    setNonTurnModel: (next: ModelSelection | null) => {
      writes.push(next);
      current = next ?? undefined;
    },
    // The real method is atomic and rolls back a failed write — modelled here,
    // because the seed's promise depends on both halves.
    stampNonTurnModel: (next: ModelSelection) => {
      if (current) return current;
      writes.push(next);
      if (opts.writeFails) return undefined;
      current = next;
      return next;
    },
    listCredentialRoutes: (serviceId?: string, billingMode?: string) =>
      routes.filter(
        (r) =>
          (serviceId === undefined || r.serviceId === serviceId)
          && (billingMode === undefined || r.billingMode === billingMode),
      ),
    getCredentialSecret: (id: string) => (routes.some((r) => r.id === id) ? "sk-test" : undefined),
    getSelectionMode: () => "strict" as const,
    getCredentialRoute: (id: string) => routes.find((r) => r.id === id),
    getFailoverCutoffs: () => ({ session: 90, weekly: 90 }),
  } as unknown as CredentialStore;
  return { store, writes, read: () => current };
}

describe("seedNonTurnModel", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doMock("../../shared/installed-harnesses.js", () => ({
      isHarnessInstalled: () => true,
      readInstalledHarnesses: () => ["claude", "codex"],
    }));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock("../../shared/installed-harnesses.js");
  });

  it("writes the first eligible model once the install has a credential", async () => {
    const { seedNonTurnModel } = await import("./settings.js");
    const { store, writes } = storeWith([route({ serviceId: "deepseek", billingMode: "key" })]);

    seedNonTurnModel(store, registry(), {});

    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ serviceId: "deepseek", billingMode: "key" });
    // A whole triple, never a service alone — the same model id is reachable
    // through two services at different prices (req 5).
    expect(typeof writes[0]!.modelId).toBe("string");
  });

  /**
   * The state the screen could not name is gone only if the write is
   * idempotent: a second read must not produce a second write, or every
   * settings load would race the user's own choice.
   */
  it("writes nothing on a later read, because a value is already stored", async () => {
    const { seedNonTurnModel } = await import("./settings.js");
    const { store, writes } = storeWith([route({ serviceId: "deepseek", billingMode: "key" })]);

    seedNonTurnModel(store, registry(), {});
    seedNonTurnModel(store, registry(), {});
    seedNonTurnModel(store, registry(), {});

    expect(writes).toHaveLength(1);
  });

  /**
   * The half that makes this a setting rather than a default. The user chose
   * a model; a service added afterwards must not move it, and neither must the
   * credential of the chosen one going away — that case is REPORTED
   * (`pin_unavailable`), not corrected.
   */
  it("never writes over a value the user chose", async () => {
    const { seedNonTurnModel } = await import("./settings.js");
    const chosen = { serviceId: "anthropic", billingMode: "sub" as const, modelId: "claude-opus-5" };
    const { store, writes } = storeWith(
      [route({ serviceId: "deepseek", billingMode: "key" })],
      chosen,
    );

    seedNonTurnModel(store, registry(), {});

    expect(writes).toEqual([]);
    expect(store.getNonTurnModel()).toEqual(chosen);
  });

  it("writes nothing when there is nothing to run it on", async () => {
    const { seedNonTurnModel } = await import("./settings.js");
    const { store, writes } = storeWith([]);

    seedNonTurnModel(store, registry(), {});

    expect(writes).toEqual([]);
    expect(store.getNonTurnModel()).toBeUndefined();
  });

  /**
   * Cross-backend review — an account row exists from the moment a login
   * STARTS. Eligibility counts it, correctly, because routing does; a
   * permanent write must not, because req 17 deletes an abandoned attempt and
   * nothing would then re-point the setting away from a service the user never
   * connected.
   */
  it("does not seed from a sign-in that has not finished", async () => {
    const { seedNonTurnModel } = await import("./settings.js");
    const { store, writes } = storeWith([
      route({ serviceId: "anthropic", billingMode: "sub", via: "account", status: "authenticating" }),
    ]);

    seedNonTurnModel(store, registry(), {});

    expect(writes).toEqual([]);
  });

  it("seeds from the same account once it is ready", async () => {
    const { seedNonTurnModel } = await import("./settings.js");
    const { store, writes } = storeWith([
      route({ serviceId: "anthropic", billingMode: "sub", via: "account", status: "ready" }),
    ]);

    seedNonTurnModel(store, registry(), {});

    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ serviceId: "anthropic", billingMode: "sub" });
  });

  /**
   * Cross-backend review — `isHarnessInstalled` answers true for EVERYTHING on
   * a deployment that ships no install report, so the catalogue walk can pick a
   * model whose CLI is absent. Survivable while the answer is re-derived every
   * read; freezing it is not. The registry has probed `$PATH`, so where the two
   * disagree the seed declines and the live fallback continues.
   */
  it("does not freeze a harness the registry says is absent", async () => {
    const { seedNonTurnModel } = await import("./settings.js");
    const { store, writes } = storeWith([
      route({ serviceId: "anthropic", billingMode: "sub", via: "account", status: "ready" }),
    ]);

    // Anthropic's subscription runs on Claude Code alone, and the registry says
    // Claude is not installed. Nothing to seed — and nothing wrongly seeded.
    seedNonTurnModel(store, registry(["codex"]), {});

    expect(writes).toEqual([]);
  });

  /**
   * The second review round: the first version of the guard above REJECTED the
   * walk's result instead of steering it, so an install with no install report
   * and one harness present ended up with no setting at all — the empty state
   * req 9 removes, reached by the code that exists to prevent it.
   */
  it("keeps walking to a harness that is installed, rather than declining", async () => {
    const { seedNonTurnModel } = await import("./settings.js");
    const { store, writes } = storeWith([
      // Two credentials: one whose model only Claude can run, and one whose
      // model Codex can. Claude leads the catalogue, and is absent.
      route({ serviceId: "anthropic", billingMode: "sub", via: "account", status: "ready" }),
      route({ serviceId: "openai", billingMode: "key" }),
    ]);

    seedNonTurnModel(store, registry(["codex"]), {});

    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ serviceId: "openai", billingMode: "key" });
  });

  /**
   * Cross-backend review — `save()` logs and swallows, so a full or read-only
   * credentials directory would leave a value in memory that vanishes on
   * restart, and the next boot could seed a DIFFERENT model with no user
   * action. `stampNonTurnModel` rolls back instead, which makes the next read
   * try again.
   */
  it("leaves nothing behind when the write fails", async () => {
    const { seedNonTurnModel } = await import("./settings.js");
    const { store, writes, read } = storeWith(
      [route({ serviceId: "deepseek", billingMode: "key" })],
      undefined,
      { writeFails: true },
    );

    seedNonTurnModel(store, registry(), {});

    expect(writes).toHaveLength(1);
    expect(read()).toBeUndefined();
  });

  it("tolerates an install with no credential store at all", async () => {
    const { seedNonTurnModel } = await import("./settings.js");
    expect(() => { seedNonTurnModel(undefined, registry(), {}); }).not.toThrow();
  });
});
