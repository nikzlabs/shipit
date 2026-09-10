import { MODEL_CONTEXT_WINDOWS } from "./model-windows.js";
import type { AgentId, ServiceRouting } from "./types.js";
import type { ApiStyle } from "./catalogue/types.js";

const ANTHROPIC_CREDENTIAL_VARS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"] as const;

// These variables override the selected account's on-disk credentials.
const HARNESS_CREDENTIAL_VARS: Record<AgentId, readonly string[]> = {
  claude: ANTHROPIC_CREDENTIAL_VARS,
  codex: ["OPENAI_API_KEY"],
  opencode: [
    "OPENCODE_PROVIDER_API_KEY",
    "OPENCODE_API_KEY",
    "OPENCODE_AUTH_CONTENT",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "OPENAI_API_KEY",
    "DEEPSEEK_API_KEY",
    "OPENROUTER_API_KEY",
  ],
  grok: ["XAI_API_KEY", "GROK_AUTH", "GROK_AUTH_PATH"],
};

export function scrubHarnessEnvCredentials(env: Record<string, string>, harnessId: AgentId): void {
  for (const name of HARNESS_CREDENTIAL_VARS[harnessId]) {
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- keys are module literals.
    delete env[name];
  }
}

// Run after the scoped-home credential scrub, which deletes the variables set here.
export function applyServiceRouting(
  env: Record<string, string>,
  routing: ServiceRouting | undefined,
): { credentialDelivered: boolean } {
  if (!routing) return { credentialDelivered: true };
  const secret = routing.credentialSourceEnv ? env[routing.credentialSourceEnv] : undefined;
  // API keys and bearer tokens use different headers; never leave both set.
  for (const name of ANTHROPIC_CREDENTIAL_VARS) {
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- keys are module literals.
    delete env[name];
  }
  const credentialDelivered = routing.credentialTarget.kind === "env" && !!secret;
  if (credentialDelivered && routing.credentialTarget.kind === "env") {
    env[routing.credentialTarget.name] = secret;
  }
  env.ANTHROPIC_BASE_URL = routing.baseUrl;
  return { credentialDelivered };
}

export const SHIPIT_PROVIDER_ID = "shipit";
const VARIANT_SUFFIX = /\[[^\]]*\]$/;
const LONG_CONTEXT_TOKENS = 1_000_000;

// Claude Code needs [1m] for unrecognized 1M models; its context env var only caps.
// Add the suffix at spawn time because other harnesses would send it as an ID.
export function claudeModelArg(modelId: string): string {
  if (VARIANT_SUFFIX.test(modelId)) return modelId;
  // Exact lookup avoids granting a larger window to an unknown model.
  // Revisit if catalogue windows gain service or harness overrides.
  if ((MODEL_CONTEXT_WINDOWS[modelId] ?? 0) < LONG_CONTEXT_TOKENS) return modelId;
  return `${modelId}[1m]`;
}

// The selected ID distinguishes an added suffix from a catalogue ID containing it.
export function unshapeClaudeModelId(reported: string, selected: string | undefined): string {
  if (selected === undefined) return reported;
  return reported === claudeModelArg(selected) ? selected : reported;
}

export function wireApiForStyle(style: ApiStyle): string | undefined {
  return style === "openai-responses" ? "responses" : undefined;
}

export function codexProviderArgs(routing: ServiceRouting | undefined): string[] {
  if (!routing) return [];
  const wireApi = wireApiForStyle(routing.style);
  if (!wireApi || routing.credentialTarget.kind !== "env") return [];
  const p = `model_providers.${SHIPIT_PROVIDER_ID}`;
  return [
    "-c", `${p}.name=${routing.serviceName}`,
    "-c", `${p}.base_url=${routing.baseUrl}`,
    "-c", `${p}.wire_api=${wireApi}`,
    "-c", `${p}.env_key=${routing.credentialTarget.name}`,
    "-c", `model_provider=${SHIPIT_PROVIDER_ID}`,
  ];
}
