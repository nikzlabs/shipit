import { describe, it, expect } from "vitest";
import { SHIPIT_PROVIDER_ID, codexProviderArgs, wireApiForStyle } from "./spawn-shaping.js";
import type { ServiceRouting } from "../../../shared/types.js";

const routing: ServiceRouting = {
  serviceId: "vercel",
  serviceName: "Vercel AI Gateway",
  billingMode: "key",
  style: "openai-responses",
  baseUrl: "https://ai-gateway.vercel.sh/v1",
  credentialSourceEnv: "VERCEL_AI_GATEWAY_API_KEY",
  credentialTarget: { kind: "env", name: "OPENAI_API_KEY" },
};

describe("codexProviderArgs", () => {
  it("writes a whole provider block and points `model_provider` at it", () => {
    // Measured against codex-cli 0.146.0: `model_provider` names a block in
    // `model_providers`, it is NOT a base URL of its own — `-c
    // model_provider=<url>` fails with "Model provider `…` not found".
    expect(codexProviderArgs(routing)).toEqual([
      "-c", `model_providers.${SHIPIT_PROVIDER_ID}.name=Vercel AI Gateway`,
      "-c", `model_providers.${SHIPIT_PROVIDER_ID}.base_url=https://ai-gateway.vercel.sh/v1`,
      "-c", `model_providers.${SHIPIT_PROVIDER_ID}.wire_api=responses`,
      "-c", `model_providers.${SHIPIT_PROVIDER_ID}.env_key=OPENAI_API_KEY`,
      "-c", `model_provider=${SHIPIT_PROVIDER_ID}`,
    ]);
  });

  it("shapes nothing when there is nothing to shape", () => {
    expect(codexProviderArgs(undefined)).toEqual([]);
  });

  it("refuses a style this CLI cannot speak rather than writing half a block", () => {
    // codex-cli 0.146.0 rejects `wire_api = "chat"` outright. A half-written
    // provider would be rejected at startup, and a turn that silently runs
    // against OpenAI because its override was dropped is worse than one that
    // does not start — so the caller stops instead.
    expect(wireApiForStyle("openai-chat-completions")).toBeUndefined();
    expect(wireApiForStyle("anthropic-messages")).toBeUndefined();
    expect(codexProviderArgs({ ...routing, style: "openai-chat-completions" })).toEqual([]);
  });

  it("refuses a credential shape that is not an environment variable", () => {
    expect(
      codexProviderArgs({
        ...routing,
        credentialTarget: { kind: "config-file", path: "/x", pointer: "y" },
      }),
    ).toEqual([]);
  });
});
