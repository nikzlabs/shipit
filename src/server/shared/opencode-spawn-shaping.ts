import fs from "node:fs";
import path from "node:path";
import type { ServiceRouting, OpenAIAccountRouting, AnthropicAccountRouting } from "./types/agent-types.js";
import { SHIPIT_PROVIDER_ID, claudeModelArg, scrubHarnessEnvCredentials } from "./spawn-routing.js";
import { HARNESSES } from "./catalogue/harnesses.js";
import { apiModelIdFor, contextWindowFor, visionSupportFor } from "./catalogue/index.js";
import type { ModelSelection } from "./catalogue/types.js";
import type { OpenCodeHarnessId } from "./opencode-harness.js";

// OpenCode 2's output limit for a model it has no window for; restated so a declared window leaves it unchanged.
const OPENCODE2_DEFAULT_OUTPUT_TOKENS = 32_000;

// OpenCode 2 assumes 200K for a model it has no window for and compacts near 170K,
// whatever the model takes. It ignores a limit without `output`.
function opencode2Limit(selection: ModelSelection, output = OPENCODE2_DEFAULT_OUTPUT_TOKENS): { context: number; output: number } | undefined {
  const context = contextWindowFor(selection, "opencode2");
  return context && context > 0 ? { context, output } : undefined;
}

function reasoningLevels(harness: OpenCodeHarnessId): readonly string[] {
  return (HARNESSES.find((h) => h.id === harness)?.capabilities.reasoning?.options ?? []).map((o) => o.value);
}

const OPENCODE_REASONING_LEVELS = reasoningLevels("opencode");

// Synthetic models have no models.dev fallback; omitted modalities silently drop images.
const IMAGE_MODALITIES = { input: ["text", "image"], output: ["text"] } as const;
const TEXT_ONLY_MODALITIES = { input: ["text"], output: ["text"] } as const;

// The Anthropic SDK rejects these; an undeclared variant uses the provider default.
const STYLE_REFUSED_LEVELS: Readonly<Record<string, readonly string[]>> = {
  "anthropic-messages": ["none", "minimal"],
};

function npmPackageForStyle(style: ServiceRouting["style"]): string | undefined {
  switch (style) {
    case "openai-chat-completions":
      return "@ai-sdk/openai-compatible";
    case "anthropic-messages":
      return "@ai-sdk/anthropic";
    // Measured 2026-09-18 against opencode 1.18.30: this package on a custom
    // baseURL posts to <base>/responses, which openai-compatible never does.
    case "openai-responses":
      return "@ai-sdk/openai";
    default:
      return undefined;
  }
}

function variantPayload(style: ServiceRouting["style"], level: string): Record<string, unknown> {
  return style === "anthropic-messages" ? { effort: level } : { reasoningEffort: level };
}

export function opencodeProviderConfig(
  routing: ServiceRouting,
  modelId: string,
  harness: OpenCodeHarnessId = "opencode",
): Record<string, unknown> | undefined {
  const npm = npmPackageForStyle(routing.style);
  if (!npm || routing.credentialTarget.kind !== "env") return undefined;
  // The Anthropic SDK does not insert /v1 as Claude Code does.
  const baseURL =
    routing.style === "anthropic-messages" ? `${routing.baseUrl.replace(/\/$/, "")}/v1` : routing.baseUrl;
  const refused = STYLE_REFUSED_LEVELS[routing.style] ?? [];
  const variants: Record<string, Record<string, unknown>> = {};
  for (const level of harness === "opencode" ? OPENCODE_REASONING_LEVELS : reasoningLevels(harness)) {
    if (refused.includes(level)) continue;
    variants[level] = variantPayload(routing.style, level);
  }
  const selection = { serviceId: routing.serviceId, billingMode: routing.billingMode, modelId };
  const modalities = visionSupportFor(selection) === "no" ? TEXT_ONLY_MODALITIES : IMAGE_MODALITIES;
  const limit = harness === "opencode2" ? opencode2Limit(selection) : undefined;
  return {
    [SHIPIT_PROVIDER_ID]: {
      name: routing.serviceName,
      npm,
      options: {
        baseURL,
        apiKey: `{env:${routing.credentialTarget.name}}`,
      },
      // The key stays the row id, which OpenCode reports back; `id` is what it sends.
      models: {
        [modelId]: { id: apiModelIdFor(selection) ?? modelId, name: modelId, variants, modalities, ...(limit ? { limit } : {}) },
      },
    },
  };
}

export function opencodeModelArg(modelId: string): string {
  return `${SHIPIT_PROVIDER_ID}/${modelId}`;
}

/** OpenCode 2 has no `--variant`; the variant rides the model as `provider/model#variant`. */
export function opencode2ModelArg(providerId: string, modelId: string, variant?: string): string {
  return `${providerId}/${modelId}${variant ? `#${variant}` : ""}`;
}

export function isOpenCodeAccountRouting(routing: ServiceRouting | undefined): routing is OpenAIAccountRouting {
  return routing?.credentialTarget.kind === "openai-chatgpt";
}

export function isOpenCodeClaudeRouting(routing: ServiceRouting | undefined): routing is AnthropicAccountRouting {
  return routing?.credentialTarget.kind === "anthropic-oauth";
}

/** OpenCode 2's built-in provider, which runs the session's `claude` CLI (docs/340). */
export const OPENCODE2_CLAUDE_PROVIDER_ID = "claude-agent";

// The provider reads the effort from the variant's name; none/minimal are not Claude efforts.
const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

// The provider does not know catalogue ids, so the model is declared with the id `claude` is
// given. It is the only enabled provider, so a credential another route left behind serves nothing.
export function opencode2ClaudeConfig(modelId: string): Record<string, unknown> {
  const providerId = OPENCODE2_CLAUDE_PROVIDER_ID;
  const limit = opencode2Limit({ serviceId: "anthropic", billingMode: "sub", modelId });
  return {
    enabled_providers: [providerId],
    model: `${providerId}/${modelId}`,
    small_model: `${providerId}/${modelId}`,
    provider: {
      [providerId]: {
        models: {
          [modelId]: {
            id: claudeModelArg(modelId),
            name: modelId,
            variants: Object.fromEntries(CLAUDE_EFFORTS.map((level) => [level, { effort: level }])),
            ...(limit ? { limit } : {}),
          },
        },
      },
    },
  };
}

export function claudeVariant(variant: string | undefined): string | undefined {
  return variant && (CLAUDE_EFFORTS as readonly string[]).includes(variant) ? variant : undefined;
}

/** Throws when the `claude` CLI under this home has no login to run on. */
export function requireClaudeLogin(home: string): void {
  if (!fs.existsSync(path.join(home, ".claude", ".credentials.json"))) {
    throw new Error("No Claude login is provisioned for this turn");
  }
}

/** A Claude login comes from `~/.claude`; these would replace it or bill elsewhere. */
export function prepareOpenCodeClaudeEnv(env: Record<string, string>): void {
  // An inherited inline config loads after ShipIt's file and could re-point the provider;
  // OPENCODE_CLAUDE_PATH would pick another `claude` than the image's.
  for (const name of [...Object.keys(env).filter((n) => n.startsWith("SHIPIT_CREDENTIAL_")), "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CONFIG_DIR", "ANTHROPIC_BASE_URL", "OPENCODE_CONFIG_CONTENT", "OPENCODE_CLAUDE_PATH"]) {
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- fixed provider-auth denylist.
    delete env[name];
  }
}

const ACCOUNT_MODE = { serviceId: "openai", billingMode: "sub" } as const satisfies Pick<
  OpenAIAccountRouting,
  "serviceId" | "billingMode"
>;

const ACCOUNT_OUTPUT_TOKENS = 128_000;

// Native auth rewrites Responses to the ChatGPT backend and rereads file auth.
// OpenCode 2 caps a ChatGPT login's input per model itself, so it gets the full window to cap.
export function opencodeAccountConfig(modelId: string, harness: OpenCodeHarnessId = "opencode"): Record<string, unknown> {
  const limit = harness === "opencode2"
    ? opencode2Limit({ ...ACCOUNT_MODE, modelId }, ACCOUNT_OUTPUT_TOKENS)
    : { context: 400_000, input: 272_000, output: ACCOUNT_OUTPUT_TOKENS };
  return {
    enabled_providers: ["openai"],
    disabled_providers: [],
    model: `openai/${modelId}`,
    small_model: `openai/${modelId}`,
    provider: {
      openai: {
        npm: "@ai-sdk/openai",
        options: { baseURL: "https://api.openai.com/v1" },
        whitelist: [modelId],
        models: {
          [modelId]: {
            id: apiModelIdFor({ ...ACCOUNT_MODE, modelId }) ?? modelId,
            name: modelId,
            modalities: IMAGE_MODALITIES,
            ...(limit ? { limit } : {}),
            variants: Object.fromEntries((harness === "opencode" ? OPENCODE_REASONING_LEVELS : reasoningLevels(harness)).map((level) => [level, { reasoningEffort: level }])),
          },
        },
      },
    },
  };
}

export function prepareOpenCodeAccountEnv(env: Record<string, string>): void {
  scrubHarnessEnvCredentials(env, "opencode");
  for (const name of [...Object.keys(env).filter(name => name.startsWith("SHIPIT_CREDENTIAL_")), "OPENCODE_AUTH_CONTENT", "OPENCODE_API_KEY", "OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_API_BASE", "OPENAI_ORG_ID", "OPENAI_PROJECT_ID"]) {
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- fixed provider-auth denylist.
    delete env[name];
  }
  env.OPENCODE_DISABLE_DEFAULT_PLUGINS = "0";
}
