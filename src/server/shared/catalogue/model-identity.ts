// Families follow training lineage, not service or model generation.
export const MODEL_FAMILY_IDS = [
  "claude",
  "gpt",
  "deepseek",
  "glm",
  "gemini",
  "grok",
  "kimi",
  "qwen",
  "ox",
] as const;

export type ModelFamily = (typeof MODEL_FAMILY_IDS)[number];

export interface ModelIdentity {
  /** Stable across service aliases and context-window suffixes. */
  canonicalModelKey: string;
  family: ModelFamily;
}

function identity<K extends string, F extends ModelFamily>(
  canonicalModelKey: K,
  family: F,
): { readonly canonicalModelKey: K; readonly family: F } {
  return { canonicalModelKey, family } as const;
}

// Reuse these pairs in service rows; an additional offering does not add an identity.
export const MODEL_IDENTITIES = {
  opus5: identity("claude-opus-5", "claude"),
  sonnet5: identity("claude-sonnet-5", "claude"),
  haiku45: identity("claude-haiku-4.5", "claude"),
  fable5: identity("claude-fable-5", "claude"),
  fable51: identity("claude-fable-5.1", "claude"),

  gpt6astra: identity("gpt-6-astra", "gpt"),
  gpt56sol: identity("gpt-5.6-sol", "gpt"),
  gpt56terra: identity("gpt-5.6-terra", "gpt"),
  gpt56luna: identity("gpt-5.6-luna", "gpt"),
  gpt55: identity("gpt-5.5", "gpt"),
  gpt54: identity("gpt-5.4", "gpt"),
  gpt54mini: identity("gpt-5.4-mini", "gpt"),
  gpt53codex: identity("gpt-5.3-codex", "gpt"),
  gpt53codexSpark: identity("gpt-5.3-codex-spark", "gpt"),
  gpt52: identity("gpt-5.2", "gpt"),

  deepseekV4Flash: identity("deepseek-v4-flash", "deepseek"),
  deepseekV4Pro: identity("deepseek-v4-pro", "deepseek"),
  // V4.1 Flash is a DISTINCT canonical model, not a spelling of V4 Flash — the
  // same reasoning as the GLM-5.2/5.3 pair. Both stay declared: DeepSeek retired
  // V4 Flash at its own endpoint (`services.ts`) while the gateways still serve
  // those weights. `deepseek-flash`, the vendor's current id, is aliased below.
  deepseekV41Flash: identity("deepseek-v4.1-flash", "deepseek"),

  glm52: identity("glm-5.2", "glm"),
  glm53: identity("glm-5.3", "glm"),

  gemini37flash: identity("gemini-3.7-flash", "gemini"),
  grok46: identity("grok-4.6", "grok"),
  grok43: identity("grok-4.3", "grok"),
  grok45: identity("grok-4.5", "grok"),
  grok420Reasoning: identity("grok-4.20-0309-reasoning", "grok"),
  grok420NonReasoning: identity("grok-4.20-0309-non-reasoning", "grok"),
  kimiK3: identity("kimi-k3", "kimi"),
  qwen38max: identity("qwen3.8-max", "qwen"),
  oxAlpha: identity("ox-alpha", "ox"),
} as const;

// Verified aliases that namespace/suffix normalization cannot resolve.
export const MODEL_ID_ALIASES: Record<string, string> = {
  haiku: "claude-haiku-4.5",
  "claude-haiku-4-5": "claude-haiku-4.5",
  "claude-fable-5-1": "claude-fable-5.1",
  "x-preview-f-free": "ox-alpha",
  "ox-alpha-free": "ox-alpha",
  // DeepSeek's own version-free id for V4.1 Flash, which OpenCode Go copies,
  // where the gateways spell it `deepseek/deepseek-v4.1-flash`. The vendor's
  // model table names this id's MODEL VERSION as DeepSeek-V4.1-Flash outright
  // (2026-09-10) — a read fact, not a guess from the word "flash".
  "deepseek-flash": "deepseek-v4.1-flash",
};

export function normalizeModelIdForIdentity(id: string): string {
  const withoutNamespace = id.includes("/") ? id.slice(id.lastIndexOf("/") + 1) : id;
  return withoutNamespace.replace(/\[[^\]]*\]$/, "");
}

export type CanonicalModelKey =
  (typeof MODEL_IDENTITIES)[keyof typeof MODEL_IDENTITIES]["canonicalModelKey"];

export const MODEL_IDENTITY_BY_KEY: Record<string, ModelIdentity> = Object.fromEntries(
  Object.values(MODEL_IDENTITIES).map((entry) => [entry.canonicalModelKey, entry]),
);

export function sameCanonicalModel(a: ModelIdentity | undefined, b: ModelIdentity | undefined): boolean {
  if (!a || !b) return false;
  return a.canonicalModelKey === b.canonicalModelKey;
}

export function sameModelFamily(a: ModelIdentity | undefined, b: ModelIdentity | undefined): boolean {
  if (!a || !b) return false;
  return a.family === b.family;
}
