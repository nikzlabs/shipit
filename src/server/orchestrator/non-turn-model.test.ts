import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { CredentialRoute } from "../shared/types.js";
import type { ModelSelection } from "../shared/catalogue/index.js";

/**
 * docs/252 phase 7 (req 9) — the resolver for the model non-turn work runs on.
 *
 * Every test drives the REAL catalogue rather than a fixture, because the two
 * things under test — "the first eligible model in the picker's own ordering"
 * and "the first installed harness offering it" — are statements about that
 * catalogue's order. A fixture would let the rule pass here and disagree with
 * what the picker shows, which is the exact drift the setting exists to prevent.
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
    // Phase 5 widened `ServiceRoutingCredentialSource` with the selection mode;
    // nothing here reads it, so the stub returns the store's own default.
    getSelectionMode: () => "strict" as const,
    // docs/252 req 20 widened it again: spawn shaping asks whether a route id
    // names a STORED row, because an adopted credential keeps a legacy reserved
    // id and can no longer be recognised by its id's shape.
    getCredentialRoute: (id: string) => routes.find((r) => r.id === id),
    // docs/252 follow-up — the string-delivered walk applies the user's
    // cutoffs, so its credential source carries them. Default: nothing set.
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

  // req 9 — unset is not "no model", it is "the first model this install can
  // actually run", resolved fresh. A named default would point at a vendor a
  // DeepSeek-only install has no credential for and fail from day one.
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
    // DeepSeek speaks Anthropic-Messages and chat-completions; Codex speaks only
    // Responses, so the derived harness is Claude Code and there is no choice to
    // offer the user.
    expect(result.target.harnessId).toBe("claude");
  });

  // req 8 — a service with no credential is never offered, so the default skips
  // past it rather than naming it and failing.
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

  // req 14 — being installed is a precondition of req 8's rule, not an
  // exception to it: a harness this deployment did not install offers nothing.
  it("ignores a harness this deployment did not install", async () => {
    vi.doMock("../shared/installed-harnesses.js", () => ({
      isHarnessInstalled: (id: string) => id === "claude",
      readInstalledHarnesses: () => ["claude"],
    }));
    const { resolveNonTurnModel } = await import("./non-turn-model.js");
    // OpenAI's key mode reaches Codex (Responses) — with Codex uninstalled it is
    // unreachable, so the resolver must not name it.
    const result = resolveNonTurnModel({
      credentialStore: storeWith([route({ serviceId: "openai", billingMode: "key" })]),
      env: {},
    });

    // OpenAI's key mode also declares chat-completions, which no installed
    // harness speaks, so nothing is runnable at all here.
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("nothing_eligible");
  });

  // req 9 — a pin is a pin: ShipIt runs it and does not quietly move it.
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

  // req 9 — "only a pin can go stale, and it is the one the notice reports on".
  // The distinction matters: this is the case that raises a notice, where
  // `nothing_eligible` is silent because no service failed.
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

  // req 13 — a pin is a fourth persisted selection and strands on a retired
  // model exactly as a session does. Resolving through the successor is what
  // stops one retirement from firing req 9's notice on every session forever.
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

  // The second credential source phase 3 records as easy to forget: a
  // deployment-supplied variable has no row in the store, and a rule reading the
  // store alone reports the install as having nothing.
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
    // Shaped, and carrying the secret the caller has to put in the environment
    // itself — session naming spawns a CLI from the orchestrator, not a worker.
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
