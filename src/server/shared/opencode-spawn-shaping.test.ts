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

/** The single provider block a shaped spawn writes, for the given routing. */
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
    // The block is the ONLY source of modality for a synthetic `shipit/<id>` —
    // there is no models.dev entry to fall back to, and OpenCode resolves a
    // missing declaration to image:false, which silently drops the `read` tool's
    // file part. Probed live 2026-08-20 (CLI 1.18.18): without this the model is
    // blind to an attached image; with it, it reads pixel-only content verbatim.
    for (const style of ["anthropic-messages", "openai-chat-completions"] as const) {
      const modalities = block({ ...ROUTING, style }).models?.["claude-haiku-4-5"]?.modalities;
      expect(modalities?.input).toEqual(["text", "image"]);
      expect(modalities?.output).toEqual(["text"]);
    }
  });

  it("withholds image input for a model the catalogue knows is text-only (planning#460)", () => {
    // `deepseek-v4-flash` is text-only at BOTH public gateway catalogues
    // (`model-vision.ts`), and it is the exact model planning#460 names: with the
    // blanket claim, attaching an image here made the request itself malformed
    // and the service rejected the turn. The visible half of the fix is
    // `imageAttachmentRefusal`; this is the half that stops the malformed
    // request in the paths a refusal cannot cover.
    const modalities = block(
      { ...ROUTING, style: "openai-chat-completions", baseUrl: "https://opencode.ai/zen/v1" },
      "deepseek-v4-flash",
    ).models?.["deepseek-v4-flash"]?.modalities;
    expect(modalities?.input).toEqual(["text"]);
    expect(modalities?.output).toEqual(["text"]);
  });

  it("declares image input for a model it cannot resolve — not knowing is not a refusal", () => {
    // The fail-open that keeps planning#460 from reintroducing planning#458's
    // silent drop by the back door. An id the catalogue does not carry resolves
    // to `"unverified"`, which declares, so an unrecognised route behaves exactly
    // as it did before this change.
    const modalities = block(ROUTING, "no-such-model").models?.["no-such-model"]?.modalities;
    expect(modalities?.input).toEqual(["text", "image"]);
  });

  it("never inlines the secret — the key is OpenCode's {env:VAR} indirection", () => {
    expect(block(ROUTING).options?.apiKey).toBe("{env:OPENCODE_PROVIDER_API_KEY}");
  });

  it("omits the levels @ai-sdk/anthropic refuses, and keeps the rest (docs/272 §7)", () => {
    // Measured 2026-08-17 against Zen: the package validates `effort` against a
    // zod enum, so a declared `none` variant threw AI_TypeValidationError before
    // any request went out — it did not degrade to the default. An unknown
    // `--variant` IS ignored by the CLI, so not declaring one is the safe half.
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
