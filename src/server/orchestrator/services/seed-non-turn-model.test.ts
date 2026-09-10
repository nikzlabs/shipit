import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { CredentialRoute } from "../../shared/types.js";
import type { ModelSelection } from "../../shared/catalogue/index.js";
import type { CredentialStore } from "../credential-store.js";
import type { AgentRegistry } from "../../shared/agent-registry.js";

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
    expect(typeof writes[0]!.modelId).toBe("string");
  });

  it("writes nothing on a later read, because a value is already stored", async () => {
    const { seedNonTurnModel } = await import("./settings.js");
    const { store, writes } = storeWith([route({ serviceId: "deepseek", billingMode: "key" })]);

    seedNonTurnModel(store, registry(), {});
    seedNonTurnModel(store, registry(), {});
    seedNonTurnModel(store, registry(), {});

    expect(writes).toHaveLength(1);
  });

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

  it("does not freeze a harness the registry says is absent", async () => {
    const { seedNonTurnModel } = await import("./settings.js");
    const { store, writes } = storeWith([
      route({ serviceId: "anthropic", billingMode: "sub", via: "account", status: "ready" }),
    ]);

    seedNonTurnModel(store, registry(["codex"]), {});

    expect(writes).toEqual([]);
  });

  it("keeps walking to a harness that is installed, rather than declining", async () => {
    const { seedNonTurnModel } = await import("./settings.js");
    const { store, writes } = storeWith([
      route({ serviceId: "anthropic", billingMode: "sub", via: "account", status: "ready" }),
      route({ serviceId: "openai", billingMode: "key" }),
    ]);

    seedNonTurnModel(store, registry(["codex"]), {});

    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ serviceId: "openai", billingMode: "key" });
  });

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
