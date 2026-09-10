import { describe, it, expect } from "vitest";
import { opencodeProviderConfig, opencodeModelArg } from "./opencode-spawn-shaping.js";
import type { ServiceRouting } from "./types/agent-types.js";

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
    expect(opencodeProviderConfig({ ...ROUTING, style: "openai-responses" }, "gpt-5.6-sol")).toBeUndefined();
  });

  it("names the model in ShipIt's own provider namespace", () => {
    expect(opencodeModelArg("glm-5.3")).toBe("shipit/glm-5.3");
  });
});
