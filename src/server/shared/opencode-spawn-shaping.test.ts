import { afterEach, describe, it, expect } from "vitest";
import { opencodeProviderConfig, opencodeModelArg, opencodeAccountConfig, opencode2ModelArg } from "./opencode-spawn-shaping.js";
import {
  adoptModelList,
  applyModelList,
  catalogueEntriesForHarness,
  exportModelList,
  resolveStyle,
  serializeModelList,
  type CatalogueEntry,
} from "./catalogue/index.js";
import type { ServiceRouting, StringServiceRouting } from "./types/agent-types.js";

const ROUTING: ServiceRouting = {
  serviceId: "opencode",
  serviceName: "OpenCode",
  billingMode: "key",
  style: "anthropic-messages",
  baseUrl: "https://opencode.ai/zen",
  credentialSourceEnv: "OPENCODE_ZEN_API_KEY",
  credentialTarget: { kind: "env", name: "OPENCODE_PROVIDER_API_KEY" },
};

function block(routing: ServiceRouting, modelId = "claude-haiku-4-5") {
  const config = opencodeProviderConfig(routing, modelId);
  return (config?.shipit ?? {}) as {
    npm?: string;
    options?: { baseURL?: string; apiKey?: string };
    models?: Record<
      string,
      {
        id?: string;
        variants?: Record<string, Record<string, unknown>>;
        modalities?: { input?: readonly string[]; output?: readonly string[] };
      }
    >;
  };
}

describe("opencodeProviderConfig", () => {
  it("appends /v1 for anthropic-messages and leaves a chat-completions base verbatim", () => {
    expect(block(ROUTING).options?.baseURL).toBe("https://opencode.ai/zen/v1");
    expect(block({ ...ROUTING, style: "openai-chat-completions", baseUrl: "https://opencode.ai/zen/v1" }).options?.baseURL).toBe(
      "https://opencode.ai/zen/v1",
    );
  });

  it("declares image input, which is what makes an attachment reach the model (planning#458)", () => {
    for (const style of ["anthropic-messages", "openai-chat-completions"] as const) {
      const modalities = block({ ...ROUTING, style }).models?.["claude-haiku-4-5"]?.modalities;
      expect(modalities?.input).toEqual(["text", "image"]);
      expect(modalities?.output).toEqual(["text"]);
    }
  });

  it("withholds image input for a model the catalogue knows is text-only (planning#460)", () => {
    const modalities = block(
      { ...ROUTING, style: "openai-chat-completions", baseUrl: "https://opencode.ai/zen/v1" },
      "deepseek-v4-flash",
    ).models?.["deepseek-v4-flash"]?.modalities;
    expect(modalities?.input).toEqual(["text"]);
    expect(modalities?.output).toEqual(["text"]);
  });

  it("declares image input for a model it cannot resolve — not knowing is not a refusal", () => {
    const modalities = block(ROUTING, "no-such-model").models?.["no-such-model"]?.modalities;
    expect(modalities?.input).toEqual(["text", "image"]);
  });

  it("never inlines the secret — the key is OpenCode's {env:VAR} indirection", () => {
    expect(block(ROUTING).options?.apiKey).toBe("{env:OPENCODE_PROVIDER_API_KEY}");
  });

  it("omits the levels @ai-sdk/anthropic refuses, and keeps the rest (docs/272 §7)", () => {
    const variants = block(ROUTING).models?.["claude-haiku-4-5"]?.variants ?? {};
    expect(Object.keys(variants)).not.toContain("none");
    expect(Object.keys(variants)).not.toContain("minimal");
    expect(Object.keys(variants)).toEqual(expect.arrayContaining(["low", "medium", "high", "xhigh", "max"]));
    expect(variants.high).toEqual({ effort: "high" });
  });

  it("keeps every level for chat-completions, where no package schema refuses one", () => {
    const variants =
      block({ ...ROUTING, style: "openai-chat-completions", baseUrl: "https://opencode.ai/zen/v1" }, "deepseek-v4-flash")
        .models?.["deepseek-v4-flash"]?.variants ?? {};
    expect(Object.keys(variants)).toContain("none");
    expect(variants.high).toEqual({ reasoningEffort: "high" });
  });

  it("refuses a style the harness cannot speak instead of shaping a wrong spawn", () => {
    expect(opencodeProviderConfig({ ...ROUTING, style: "gemini-generate-content" }, "gemini-3-pro")).toBeUndefined();
  });

  // Uses a style that IS supported, so only the credential branch can refuse;
  // with openai-responses the result would be undefined either way.
  it("refuses a credential the spawn cannot carry as an env var", () => {
    const target = { kind: "config-file", path: "auth.json", pointer: "/key" } as const;
    expect(opencodeProviderConfig({ ...ROUTING, credentialTarget: target }, "claude-haiku-4-5")).toBeUndefined();
    expect(opencodeProviderConfig(ROUTING, "claude-haiku-4-5")).toBeDefined();
  });

  // @ai-sdk/openai is the package that posts to <base>/responses; the
  // openai-compatible one never does, whatever baseURL it is given.
  it("shapes openai-responses onto the Responses-capable provider package", () => {
    const shaped = block(
      { ...ROUTING, style: "openai-responses", baseUrl: "https://opencode.ai/zen/v1" },
      "gpt-6-astra",
    );
    expect(shaped.npm).toBe("@ai-sdk/openai");
    expect(shaped.options?.baseURL).toBe("https://opencode.ai/zen/v1");
    expect(shaped.models?.["gpt-6-astra"]?.variants?.medium).toEqual({ reasoningEffort: "medium" });
  });

  it("names the model in ShipIt's own provider namespace", () => {
    expect(opencodeModelArg("glm-5.3")).toBe("shipit/glm-5.3");
  });
});

// Measured against opencode 1.18.30: a model entry without `id` posts its key as
// the Messages API `model`, so the Haiku 4.5 row sent `haiku`.
describe("the model id OpenCode sends", () => {
  const ANTHROPIC_KEY: StringServiceRouting = {
    serviceId: "anthropic",
    serviceName: "Anthropic",
    billingMode: "key",
    style: "anthropic-messages",
    baseUrl: "https://api.anthropic.com",
    credentialSourceEnv: "ANTHROPIC_API_KEY",
    credentialTarget: { kind: "env", name: "OPENCODE_PROVIDER_API_KEY" },
  };

  const label = (e: CatalogueEntry) => `${e.selection.serviceId}/${e.selection.billingMode}/${e.selection.modelId}`;

  function sentModelId(entry: CatalogueEntry): string | undefined {
    const { serviceId, billingMode, modelId } = entry.selection;
    if (serviceId === "openai" && billingMode === "sub") {
      const config = opencodeAccountConfig(modelId) as { provider: { openai: { models: Record<string, { id?: string }> } } };
      return config.provider.openai.models[modelId]?.id;
    }
    const style = resolveStyle("opencode", entry.model, "string");
    if (!style) return undefined;
    return block({ ...ANTHROPIC_KEY, serviceId, billingMode, style }, modelId).models?.[modelId]?.id;
  }

  const aliased = () => catalogueEntriesForHarness("opencode").filter((e) => e.model.apiId !== undefined);

  afterEach(() => applyModelList(undefined));

  it("sends the vendor id for the Haiku 4.5 row and keeps the row id as the selectable key", () => {
    const models = block(ANTHROPIC_KEY, "haiku").models ?? {};
    expect(Object.keys(models)).toEqual(["haiku"]);
    expect(models.haiku?.id).toBe("claude-haiku-4-5");
    expect(opencodeModelArg("haiku")).toBe("shipit/haiku");
  });

  it("sends its declared API id for every embedded row that has one", () => {
    const entries = aliased();
    expect(entries.map(label)).toContain("anthropic/key/haiku");
    for (const entry of entries) expect(sentModelId(entry), label(entry)).toBe(entry.model.apiId);
  });

  it("sends a published row's API id on the ChatGPT account path as well as the string-credential one", () => {
    const doc = exportModelList();
    for (const modes of Object.values(doc.services)) {
      for (const mode of Object.values(modes)) {
        for (const row of mode?.models ?? []) row.apiId ??= `${row.id}-vendor`;
      }
    }
    adoptModelList(JSON.parse(serializeModelList(doc)));
    const entries = aliased();
    expect(entries.map((e) => `${e.selection.serviceId}/${e.selection.billingMode}`)).toContain("openai/sub");
    expect(entries.length).toBe(catalogueEntriesForHarness("opencode").length);
    for (const entry of entries) expect(sentModelId(entry), label(entry)).toBe(entry.model.apiId);
  });

  it("sends the row id for a row without an API id, and for a model the catalogue cannot resolve", () => {
    expect(block(ANTHROPIC_KEY, "claude-haiku-5-5").models?.["claude-haiku-5-5"]?.id).toBe("claude-haiku-5-5");
    expect(block(ANTHROPIC_KEY, "no-such-model").models?.["no-such-model"]?.id).toBe("no-such-model");
  });
});

describe("OpenCode 2 shaping (docs/269)", () => {
  it("rides the variant on the model, since 2.x has no --variant", () => {
    expect(opencode2ModelArg("shipit", "kimi-k3", "high")).toBe("shipit/kimi-k3#high");
    expect(opencode2ModelArg("openai", "gpt-6-luna")).toBe("openai/gpt-6-luna");
  });

  it("declares OpenCode 2's own reasoning levels as variants", () => {
    const config = opencodeProviderConfig(ROUTING, "claude-haiku-4-5", "opencode2") as { shipit: { models: Record<string, { variants: Record<string, unknown> }> } };
    expect(Object.keys(config.shipit.models["claude-haiku-4-5"].variants)).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(opencodeProviderConfig(ROUTING, "claude-haiku-4-5", "opencode2")).toEqual(opencodeProviderConfig(ROUTING, "claude-haiku-4-5"));
  });
});
