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
  });

  it("runs a harness where the credential may not be called directly", async () => {
    installAll();
    const { resolveNonTurnModel } = await import("./non-turn-model.js");
    // ANTHROPIC_AUTH_TOKEN is restricted to Claude Code, so it declares no
    // direct call and background work has to carry it on a harness.
    const result = resolveNonTurnModel({
      credentialStore: storeWith([route({ serviceId: "anthropic", billingMode: "sub" })]),
      env: {},
    });

    expect(result.ok).toBe(true);
    if (!result.ok || result.target.execution !== "harness") throw new Error("expected a harness");
    expect(result.target.harnessId).toBe("claude");
    expect(result.target.serviceRouting).toBeTruthy();
  });

  it("ignores a harness this deployment did not install", async () => {
    vi.doMock("../shared/installed-harnesses.js", () => ({
      isHarnessInstalled: (id: string) => id === "codex",
      readInstalledHarnesses: () => ["codex"],
    }));
    const { resolveNonTurnModel } = await import("./non-turn-model.js");
    // Z.AI's coding plan is carried by Claude Code alone and permits no direct call.
    const result = resolveNonTurnModel({
      credentialStore: storeWith([route({ serviceId: "zai", billingMode: "sub" })]),
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
        [route({ serviceId: "zai", billingMode: "sub" })],
        { serviceId: "zai", billingMode: "sub", modelId: "glm-5.2[1m]" },
      ),
      env: {},
    });

    expect(result.ok).toBe(true);
    if (!result.ok || result.target.execution !== "harness") throw new Error("expected a harness");
    expect(result.target.selection.modelId).toBe("glm-5.2[1m]");
    expect(result.target.source).toBe("pinned");
    expect(result.target.harnessId).toBe("claude");
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
      env: { ZAI_CODING_PLAN_KEY: "sk-env" },
    });

    expect(result.ok).toBe(true);
    if (!result.ok || result.target.execution !== "harness") throw new Error("expected a harness");
    expect(result.target.selection.serviceId).toBe("zai");
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

/**
 * docs/299 req 3. Where a credential permits a direct call, background work
 * offers that call and no harness row for the same model — and needs no
 * installed harness to do it (req 4).
 */
describe("resolveNonTurnModel — a direct call where the credential permits one", () => {
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

  const installNone = () =>
    vi.doMock("../shared/installed-harnesses.js", () => ({
      isHarnessInstalled: () => false,
      readInstalledHarnesses: () => [],
    }));

  it("prefers the direct call over a harness that could reach the same model", async () => {
    installAll();
    const { resolveNonTurnModel } = await import("./non-turn-model.js");
    const result = resolveNonTurnModel({
      credentialStore: storeWith([route({ serviceId: "openai", billingMode: "key" })], {
        serviceId: "openai",
        billingMode: "key",
        modelId: "gpt-5.4-mini",
      }),
      env: {},
    });

    expect(result.ok).toBe(true);
    if (!result.ok || result.target.execution !== "direct") throw new Error("expected a direct call");
    expect(result.target.call.style).toBe("openai-responses");
    expect(result.target.call.baseUrl).toBe("https://api.openai.com/v1");
    expect(result.target.apiKey).toBe("sk-test");
  });

  it("needs no installed harness", async () => {
    installNone();
    const { resolveNonTurnModel } = await import("./non-turn-model.js");
    const result = resolveNonTurnModel({
      credentialStore: storeWith([route({ serviceId: "anthropic", billingMode: "key" })]),
      env: {},
    });

    expect(result.ok).toBe(true);
    if (!result.ok || result.target.execution !== "direct") throw new Error("expected a direct call");
    expect(result.target.selection.serviceId).toBe("anthropic");
    expect(result.target.call.style).toBe("anthropic-messages");
  });

  it("sends the API's model id, not the harness alias the row is named for", async () => {
    installNone();
    const { resolveNonTurnModel } = await import("./non-turn-model.js");
    const result = resolveNonTurnModel({
      credentialStore: storeWith([route({ serviceId: "anthropic", billingMode: "key" })], {
        serviceId: "anthropic",
        billingMode: "key",
        modelId: "haiku",
      }),
      env: {},
    });

    if (!result.ok || result.target.execution !== "direct") throw new Error("expected a direct call");
    expect(result.target.selection.modelId).toBe("haiku");
    expect(result.target.call.apiModelId).toBe("claude-haiku-4-5");
  });

  it("carries the request headers the credential declares", async () => {
    installNone();
    const { resolveNonTurnModel } = await import("./non-turn-model.js");
    // OpenCode Go: a `sub` mode with a pasted key and ordinary API endpoints,
    // which refuses an unnamed client and a session-less request.
    const result = resolveNonTurnModel({
      credentialStore: storeWith([route({ serviceId: "opencode", billingMode: "sub" })]),
      env: {},
    });

    if (!result.ok || result.target.execution !== "direct") throw new Error("expected a direct call");
    expect(result.target.selection.billingMode).toBe("sub");
    expect(result.target.call.headers?.["User-Agent"]).toBe("ShipIt");
    expect(result.target.call.headers?.["x-opencode-session"]).toBeTruthy();
  });

  it("follows a retired pin onto a successor it can call directly", async () => {
    installNone();
    const { resolveNonTurnModel } = await import("./non-turn-model.js");
    const result = resolveNonTurnModel({
      credentialStore: storeWith([route({ serviceId: "openai", billingMode: "key" })], {
        serviceId: "openai",
        billingMode: "key",
        modelId: "gpt-5.6",
      }),
      env: {},
    });

    if (!result.ok || result.target.execution !== "direct") throw new Error("expected a direct call");
    expect(result.target.selection.modelId).toBe("gpt-5.6-sol");
    expect(result.target.call.apiModelId).toBe("gpt-5.6-sol");
  });

  it("reads the key from the environment when no route is stored", async () => {
    installNone();
    const { resolveNonTurnModel } = await import("./non-turn-model.js");
    const result = resolveNonTurnModel({
      credentialStore: storeWith([]),
      env: { DEEPSEEK_API_KEY: "sk-env" },
    });

    if (!result.ok || result.target.execution !== "direct") throw new Error("expected a direct call");
    expect(result.target.selection.serviceId).toBe("deepseek");
    expect(result.target.apiKey).toBe("sk-env");
  });

  it("gives a caller that asks for a harness one it can run", async () => {
    // Session naming still runs a CLI of its own until docs/299 phase 3.
    installAll();
    const { resolveNonTurnModel } = await import("./non-turn-model.js");
    const result = resolveNonTurnModel(
      {
        credentialStore: storeWith([route({ serviceId: "anthropic", billingMode: "key" })]),
        env: {},
      },
      { harnessOnly: true },
    );

    if (!result.ok || result.target.execution !== "harness") throw new Error("expected a harness");
    expect(result.target.harnessId).toBe("claude");
  });

  it("has nothing to offer a harness-only caller with no harness installed", async () => {
    installNone();
    const { resolveNonTurnModel } = await import("./non-turn-model.js");
    const result = resolveNonTurnModel(
      {
        credentialStore: storeWith([route({ serviceId: "anthropic", billingMode: "key" })]),
        env: {},
      },
      { harnessOnly: true },
    );

    expect(result.ok).toBe(false);
  });
});
