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

function accountRoute(over: Pick<CredentialRoute, "serviceId" | "billingMode">): CredentialRoute {
  return { ...route(over), via: "account", status: "ready" };
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
 * docs/299-direct-provider-calls req 3. A refused pin says WHY it was refused,
 * because the two causes ask different things of the user and only one of them
 * is repaired in Settings.
 */
describe("resolveNonTurnModel — why a pin cannot run background work", () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock("../shared/installed-harnesses.js");
  });

  it("reports a credential that really is gone as gone", async () => {
    vi.doMock("../shared/installed-harnesses.js", () => ({
      isHarnessInstalled: () => true,
      readInstalledHarnesses: () => ["claude", "codex"],
    }));
    const { resolveNonTurnModel } = await import("./non-turn-model.js");
    const result = resolveNonTurnModel({
      credentialStore: storeWith([], {
        serviceId: "openai",
        billingMode: "key",
        modelId: "gpt-5.4-mini",
      }),
      env: {},
    });

    if (result.ok || result.reason !== "pin_unavailable") throw new Error("expected pin_unavailable");
    expect(result.cause).toBe("credential_gone");
  });

  /**
   * An account whose sign-in failed is dropped from the configured list
   * (`listConfiguredCredentials`), so absence there does not mean gone: the
   * account is still in Settings, waiting to be reconnected.
   */
  it("reports a sign-in that failed as unusable, not as gone", async () => {
    vi.doMock("../shared/installed-harnesses.js", () => ({
      isHarnessInstalled: () => true,
      readInstalledHarnesses: () => ["codex"],
    }));
    const { resolveNonTurnModel } = await import("./non-turn-model.js");
    const account = accountRoute({ serviceId: "openai", billingMode: "sub" });
    const pin = { serviceId: "openai", billingMode: "sub" as const, modelId: "gpt-5.4-mini" };
    // The same pin on the same account runs while the sign-in is ready, so what
    // fails below is the status and not the selection.
    expect(resolveNonTurnModel({ credentialStore: storeWith([account], pin), env: {} }).ok).toBe(true);

    const result = resolveNonTurnModel({
      credentialStore: storeWith([{ ...account, status: "auth_failed" }], pin),
      env: {},
    });

    if (result.ok || result.reason !== "pin_unavailable") throw new Error("expected pin_unavailable");
    expect(result.cause).toBe("credential_unusable");
  });

  /**
   * The case that made the fixed sentence wrong: a Gemini subscription carried
   * only by Antigravity, which refuses a tools-off run. The credential is
   * present, the harness is installed and eligible, and background work still
   * cannot use it — so nothing in Settings repairs this.
   */
  it("never reports a present credential on an installed harness as gone", async () => {
    vi.doMock("../shared/installed-harnesses.js", () => ({
      isHarnessInstalled: () => true,
      readInstalledHarnesses: () => ["antigravity"],
    }));
    const { resolveNonTurnModel, harnessesForSelection } = await import("./non-turn-model.js");
    const selection = { serviceId: "google", billingMode: "sub" as const, modelId: "gemini-3.8-flash" };
    const credentials = [{ serviceId: "google", billingMode: "sub" as const, via: "account" as const }];
    // Without this the pin would fail for want of a harness, and the assertion
    // below would pass on a case that proves nothing.
    expect(harnessesForSelection(selection, credentials)).toHaveLength(1);

    const result = resolveNonTurnModel({
      credentialStore: storeWith([accountRoute(selection)], selection),
      env: {},
    });

    if (result.ok || result.reason !== "pin_unavailable") throw new Error("expected pin_unavailable");
    expect(result.cause).toBe("no_background_carrier");
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
});

describe("backgroundWorkOptions — what the selector may offer (docs/299 req 3)", () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const credential = (
    serviceId: string,
    billingMode: "sub" | "key",
    via: "string" | "account" = "string",
  ) => ({ serviceId, billingMode, via });

  const noHarness = { isInstalled: () => false };

  it("offers a model provider whose credential permits a direct call, with nothing installed", async () => {
    const { backgroundWorkOptions } = await import("./non-turn-model.js");
    const options = backgroundWorkOptions([credential("deepseek", "key")], noHarness);

    expect(options.length).toBeGreaterThan(0);
    expect(options.every((o) => o.serviceId === "deepseek" && o.billingMode === "key")).toBe(true);
    expect(options[0]).toEqual(
      expect.objectContaining({ serviceName: expect.any(String), label: expect.any(String) }),
    );
  });

  /**
   * The terms rule, visible in the picker: ANTHROPIC_AUTH_TOKEN is restricted to
   * Claude Code, so its models are offered only where a harness can carry them.
   */
  it("offers nothing for a credential that may not be called directly and has no harness", async () => {
    const { backgroundWorkOptions } = await import("./non-turn-model.js");
    expect(backgroundWorkOptions([credential("anthropic", "sub")], noHarness)).toEqual([]);
  });

  it("offers that same credential's models once a harness that carries them is installed", async () => {
    const { backgroundWorkOptions } = await import("./non-turn-model.js");
    const options = backgroundWorkOptions([credential("anthropic", "sub")], {
      isInstalled: (id) => id === "claude",
    });

    expect(options.length).toBeGreaterThan(0);
    expect(options.every((o) => o.serviceId === "anthropic" && o.billingMode === "sub")).toBe(true);
  });

  /**
   * req 3's "only that call" at the level the user sees it: one triple is one
   * row. A direct call and every installed harness all reaching the same model
   * must not become three rows offering the same place.
   */
  it("offers one row per triple, however many ways reach it", async () => {
    const { backgroundWorkOptions } = await import("./non-turn-model.js");
    // Anthropic's key: directly callable AND carried by an installed harness.
    const options = backgroundWorkOptions([credential("anthropic", "key")], {
      isInstalled: () => true,
    });

    const keys = options.map((o) => `${o.serviceId}:${o.billingMode}:${o.modelId}`);
    expect(keys.length).toBeGreaterThan(1);
    expect(keys).toEqual([...new Set(keys)]);
  });

  /**
   * req 3's "only that call" at the level that decides what runs, and the half
   * a uniqueness check cannot see: one row saying "direct" and one row saying
   * "harness" look identical in the list.
   *
   * The expectation starts from the **catalogue** and never from the list under
   * test, so a model provider missing from `backgroundWorkOptions` altogether
   * fails here instead of leaving nothing to assert. Every credential the
   * catalogue declares directly callable must be offered, and the ONE excuse for
   * offering nothing is that no shipped client speaks that vendor's wire format
   * — Gemini's key is that state today, declared ahead of its client
   * (docs/302-gemini-catalogue-vendor req 5), and it stops being an excuse the
   * day a client ships.
   */
  it("offers every credential the catalogue declares directly callable", async () => {
    const { backgroundWorkOptions, runnerForNonTurnSelection } = await import("./non-turn-model.js");
    const { allServices, credentialPermitsDirectCall, directCallPathFor, resolveDirectCall } =
      await import("../shared/catalogue/index.js");
    const noHarness = { isInstalled: () => false };
    const everyHarness = { isInstalled: () => true };

    let checked = 0;
    for (const service of allServices()) {
      for (const mode of service.modes) {
        if (!credentialPermitsDirectCall(service.id, mode.kind, "string")) continue;
        const where = `${service.id}/${mode.kind}`;
        const credentials = [credential(service.id, mode.kind)];
        const select = (modelId: string) => ({
          serviceId: service.id,
          billingMode: mode.kind,
          modelId,
        });
        const offered = backgroundWorkOptions(credentials, noHarness).map((o) => o.modelId);
        const callable = mode.models
          .filter((m) => resolveDirectCall(select(m.id)))
          .map((m) => m.id);

        if (callable.length === 0) {
          const speaks = mode.models
            .flatMap((m) => m.styles)
            .some((style) => directCallPathFor(style) && mode.endpoints[style]);
          expect(speaks, `${where}: a client speaks this wire format, so it must be offered`)
            .toBe(false);
          expect(offered, where).toEqual([]);
          continue;
        }

        expect([...offered].sort(), where).toEqual([...callable].sort());
        for (const modelId of offered) {
          const selection = select(modelId);
          expect(runnerForNonTurnSelection(selection, credentials, noHarness)?.execution, `${where}/${modelId}`)
            .toBe("direct");
          // And still the direct call with every harness installed: req 3 drops
          // the harness row rather than preferring it when both exist.
          expect(runnerForNonTurnSelection(selection, credentials, everyHarness)?.execution, `${where}/${modelId}`)
            .toBe("direct");
        }
        checked += offered.length;
      }
    }
    expect(checked, "no directly callable row in the catalogue — this proves nothing")
      .toBeGreaterThan(0);
  });

  it("offers nothing at all when no credential is configured", async () => {
    const { backgroundWorkOptions } = await import("./non-turn-model.js");
    expect(backgroundWorkOptions([], { isInstalled: () => true })).toEqual([]);
  });

  /**
   * Background work runs a harness one-shot with its tools off, so a harness
   * that has no measured way to do that must not be offered at all — a row the
   * user can pick and that then refuses at run time is the state this replaces.
   *
   * Derived from `toolsOffRefusal` rather than naming a harness, so measuring
   * one (planning#546) widens the list here instead of failing this test.
   */
  it("never offers a row whose only carrier cannot run with its tools off", async () => {
    const { backgroundWorkOptions } = await import("./non-turn-model.js");
    const { toolsOffRefusal } = await import("../shared/agent-tools-off.js");
    const { allHarnesses, allServices, resolveDirectCall } = await import("../shared/catalogue/index.js");

    const refusing = allHarnesses().map((h) => h.id).filter((id) => toolsOffRefusal(id));
    expect(refusing.length, "no harness refuses tools-off — this proves nothing")
      .toBeGreaterThan(0);

    for (const service of allServices()) {
      for (const mode of service.modes) {
        const credentials = [credential(service.id, mode.kind)];
        const options = backgroundWorkOptions(credentials, {
          isInstalled: (id) => refusing.includes(id),
        });
        // Whatever survives with only those installed must be a direct call.
        for (const option of options) {
          expect(resolveDirectCall(option), `${service.id}/${mode.kind}/${option.modelId}`)
            .toBeDefined();
        }
      }
    }
  });

  it("resolves onto a harness that can run with its tools off, never one that cannot", async () => {
    const { backgroundWorkOptions, runnerForNonTurnSelection } = await import("./non-turn-model.js");
    const { toolsOffRefusal } = await import("../shared/agent-tools-off.js");
    const { allServices } = await import("../shared/catalogue/index.js");
    const installed = { isInstalled: () => true };

    for (const service of allServices()) {
      for (const mode of service.modes) {
        const credentials = [credential(service.id, mode.kind)];
        for (const option of backgroundWorkOptions(credentials, installed)) {
          const runner = runnerForNonTurnSelection(option, credentials, installed);
          if (runner?.execution !== "harness") continue;
          expect(toolsOffRefusal(runner.harnessId), `${service.id}/${mode.kind}/${option.modelId}`)
            .toBeUndefined();
        }
      }
    }
  });

  /**
   * The option list and the resolver are one search, so a pin the picker offers
   * is one `resolveNonTurnModel` can run — the drift this slice exists to close.
   */
  it("offers exactly what the resolver would accept as a pin", async () => {
    const { backgroundWorkOptions, resolveNonTurnModel } = await import("./non-turn-model.js");
    const routes = [route({ serviceId: "deepseek", billingMode: "key" })];
    const options = backgroundWorkOptions(
      [credential("deepseek", "key")],
      { isInstalled: () => false },
    );

    expect(options.length).toBeGreaterThan(0);
    for (const option of options) {
      const pin = {
        serviceId: option.serviceId,
        billingMode: option.billingMode,
        modelId: option.modelId,
      };
      expect(resolveNonTurnModel({ credentialStore: storeWith(routes, pin), env: {} }).ok, pin.modelId)
        .toBe(true);
    }
  });
});
