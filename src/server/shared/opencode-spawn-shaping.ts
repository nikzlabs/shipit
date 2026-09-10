import type { ServiceRouting, OpenAIAccountRouting } from "./types/agent-types.js";
import { SHIPIT_PROVIDER_ID, scrubHarnessEnvCredentials } from "./spawn-routing.js";
import { HARNESSES } from "./catalogue/harnesses.js";
import { visionSupportFor } from "./catalogue/index.js";

const OPENCODE_REASONING_LEVELS: readonly string[] = (
  HARNESSES.find((h) => h.id === "opencode")?.capabilities.reasoning?.options ?? []
).map((o) => o.value);

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
): Record<string, unknown> | undefined {
  const npm = npmPackageForStyle(routing.style);
  if (!npm || routing.credentialTarget.kind !== "env") return undefined;
  // The Anthropic SDK does not insert /v1 as Claude Code does.
  const baseURL =
    routing.style === "anthropic-messages" ? `${routing.baseUrl.replace(/\/$/, "")}/v1` : routing.baseUrl;
  const refused = STYLE_REFUSED_LEVELS[routing.style] ?? [];
  const variants: Record<string, Record<string, unknown>> = {};
  for (const level of OPENCODE_REASONING_LEVELS) {
    if (refused.includes(level)) continue;
    variants[level] = variantPayload(routing.style, level);
  }
  const modalities =
    visionSupportFor({
      serviceId: routing.serviceId,
      billingMode: routing.billingMode,
      modelId,
    }) === "no"
      ? TEXT_ONLY_MODALITIES
      : IMAGE_MODALITIES;
  return {
    [SHIPIT_PROVIDER_ID]: {
      name: routing.serviceName,
      npm,
      options: {
        baseURL,
        apiKey: `{env:${routing.credentialTarget.name}}`,
      },
      models: {
        [modelId]: { name: modelId, variants, modalities },
      },
    },
  };
}

export function opencodeModelArg(modelId: string): string {
  return `${SHIPIT_PROVIDER_ID}/${modelId}`;
}

export function isOpenCodeAccountRouting(routing: ServiceRouting | undefined): routing is OpenAIAccountRouting {
  return routing?.credentialTarget.kind === "openai-chatgpt";
}

// Native auth rewrites Responses to the ChatGPT backend and rereads file auth.
export function opencodeAccountConfig(modelId: string): Record<string, unknown> {
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
            id: modelId,
            name: modelId,
            modalities: IMAGE_MODALITIES,
            limit: { context: 400_000, input: 272_000, output: 128_000 },
            variants: Object.fromEntries(OPENCODE_REASONING_LEVELS.map((level) => [level, { reasoningEffort: level }])),
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
