import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { CredentialRoute } from "../shared/types.js";
import type { ModelSelection } from "../shared/catalogue/index.js";

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

function storeWith(routes: CredentialRoute[], pinned?: ModelSelection) {
  return {
    getNonTurnModel: () => pinned,
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
  };
}

describe("resolveNonTurnModel", () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock("../shared/installed-harnesses.js");
  });

  const installAll = () =>
    vi.doMock("../shared/installed-harnesses.js", () => ({
      isHarnessInstalled: () => true,
      readInstalledHarnesses: () => ["claude", "codex"],
    }));

  it("with nothing pinned, derives the first eligible model of the first credentialed service", async () => {
    installAll();
    const { resolveNonTurnModel } = await import("./non-turn-model.js");
    const result = resolveNonTurnModel({
      credentialStore: storeWith([route({ serviceId: "deepseek", billingMode: "key" })]),
      env: {},
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.target.selection.serviceId).toBe("deepseek");
    expect(result.target.selection.billingMode).toBe("key");
    expect(result.target.source).toBe("default");
    expect(result.target.harnessId).toBe("claude");
  });

  it("skips a service whose mode has no credential", async () => {
    installAll();
    const { resolveNonTurnModel } = await import("./non-turn-model.js");
    const result = resolveNonTurnModel({
      credentialStore: storeWith([route({ serviceId: "openai", billingMode: "key" })]),
      env: {},
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.target.selection.serviceId).toBe("openai");
    expect(result.target.harnessId).toBe("codex");
  });

  it("ignores a harness this deployment did not install", async () => {
    vi.doMock("../shared/installed-harnesses.js", () => ({
      isHarnessInstalled: (id: string) => id === "claude",
      readInstalledHarnesses: () => ["claude"],
    }));
    const { resolveNonTurnModel } = await import("./non-turn-model.js");
    const result = resolveNonTurnModel({
      credentialStore: storeWith([route({ serviceId: "openai", billingMode: "key" })]),
      env: {},
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("nothing_eligible");
  });

  it("uses the pinned selection and derives its harness", async () => {
    installAll();
    const { resolveNonTurnModel } = await import("./non-turn-model.js");
    const result = resolveNonTurnModel({
      credentialStore: storeWith(
        [
          route({ serviceId: "deepseek", billingMode: "key" }),
          route({ serviceId: "openai", billingMode: "key" }),
        ],
        { serviceId: "openai", billingMode: "key", modelId: "gpt-5.4-mini" },
      ),
      env: {},
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.target.selection.modelId).toBe("gpt-5.4-mini");
    expect(result.target.source).toBe("pinned");
    expect(result.target.harnessId).toBe("codex");
  });

  it("reports a pinned selection whose credential is gone as pin_unavailable", async () => {
    installAll();
    const { resolveNonTurnModel } = await import("./non-turn-model.js");
    const result = resolveNonTurnModel({
      credentialStore: storeWith([], {
        serviceId: "openai",
        billingMode: "key",
        modelId: "gpt-5.4-mini",
      }),
      env: {},
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("pin_unavailable");
    if (result.reason !== "pin_unavailable") return;
    expect(result.serviceName).toBe("OpenAI");
  });

  it("follows a retired pin onto its successor", async () => {
    installAll();
    const { resolveNonTurnModel } = await import("./non-turn-model.js");
    const result = resolveNonTurnModel({
      credentialStore: storeWith([route({ serviceId: "openai", billingMode: "key" })], {
        serviceId: "openai",
        billingMode: "key",
        modelId: "gpt-5.6",
      }),
      env: {},
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.target.selection.modelId).toBe("gpt-5.6-sol");
  });

  it("counts a deployment-supplied environment credential", async () => {
    installAll();
    const { resolveNonTurnModel } = await import("./non-turn-model.js");
    const result = resolveNonTurnModel({
      credentialStore: storeWith([]),
      env: { DEEPSEEK_API_KEY: "sk-env" },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.target.selection.serviceId).toBe("deepseek");
    expect(result.target.serviceRouting?.baseUrl).toBeTruthy();
    expect(result.target.credentialSecret).toBe("sk-env");
  });

  it("returns nothing_eligible when no credential exists at all", async () => {
    installAll();
    const { resolveNonTurnModel } = await import("./non-turn-model.js");
    const result = resolveNonTurnModel({ credentialStore: storeWith([]), env: {} });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("nothing_eligible");
  });
});
