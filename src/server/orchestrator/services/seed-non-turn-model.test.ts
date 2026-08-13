import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { CredentialRoute } from "../../shared/types.js";
import type { ModelSelection } from "../../shared/catalogue/index.js";
import type { CredentialStore } from "../credential-store.js";

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
 * The real catalogue drives every case, as in `non-turn-model.test.ts`: what is
 * seeded is "the first eligible model in the picker's own ordering", which is a
 * statement about that catalogue rather than about a fixture.
 */

function route(over: Pick<CredentialRoute, "serviceId" | "billingMode">): CredentialRoute {
  return {
    ...over,
    id: `${over.serviceId}-${over.billingMode}`,
    via: "string",
    status: "ready",
    priority: 0,
    isPrimary: true,
    label: "test",
    createdAt: 0,
    updatedAt: 0,
  };
}

/** A store that records what was written, so "wrote nothing" is assertable. */
function storeWith(routes: CredentialRoute[], stored?: ModelSelection) {
  const writes: (ModelSelection | null)[] = [];
  let current = stored;
  const store = {
    getNonTurnModel: () => current,
    setNonTurnModel: (next: ModelSelection | null) => {
      writes.push(next);
      current = next ?? undefined;
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
  return { store, writes };
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

    seedNonTurnModel(store, {});

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

    seedNonTurnModel(store, {});
    seedNonTurnModel(store, {});
    seedNonTurnModel(store, {});

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

    seedNonTurnModel(store, {});

    expect(writes).toEqual([]);
    expect(store.getNonTurnModel()).toEqual(chosen);
  });

  it("writes nothing when there is nothing to run it on", async () => {
    const { seedNonTurnModel } = await import("./settings.js");
    const { store, writes } = storeWith([]);

    seedNonTurnModel(store, {});

    expect(writes).toEqual([]);
    expect(store.getNonTurnModel()).toBeUndefined();
  });

  it("tolerates an install with no credential store at all", async () => {
    const { seedNonTurnModel } = await import("./settings.js");
    expect(() => { seedNonTurnModel(undefined, {}); }).not.toThrow();
  });
});
