import { MODEL_IDENTITIES } from "./model-identity.js";
import type { ServiceDef } from "./types.js";

const A_MSG = "anthropic-messages" as const;
const O_RESP = "openai-responses" as const;
const O_CC = "openai-chat-completions" as const;

// USD per million tokens. Rates below are estimates; gateway rates can differ from upstream.
// Anthropic pricing and prompt-caching docs, 2026-08-09; 5-minute cache writes.
const ANTHROPIC_PRICES = {
  opus5: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  sonnet5: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  haiku45: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  fable5: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
  // Pricing page, 2026-09-01: Fable 5.1 uses a 0.025× cache-read multiplier.
  fable51: { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
} as const;

// OpenAI model/pricing docs: 2026-08-09; Astra 2026-09-04.
const OPENAI_PRICES = {
  gpt6astra: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
  sol: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
  terra: { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 2.5 },
  luna: { input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0.25 },
  gpt55: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
  gpt54: { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 },
  gpt54mini: { input: 0.75, output: 4.5, cacheRead: 0.075, cacheWrite: 0 },
  gpt53codex: { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 },
  // No published Spark token price (2026-08-17); use the closest same-vendor rate provisionally.
  gpt53codexSparkProvisional: { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 },
  gpt52: { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 },
} as const;

// api-docs.deepseek.com/quick_start/pricing, 2026-09-10.
// Use peak rates to avoid understating costs; off-peak rates are half.
const DEEPSEEK_PRICES = {
  v41flash: { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0.3 },
} as const;

// z.ai/model-api, 2026-08-09.
const GLM_PRICES = {
  glm52: { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 1.4 },
  // No published GLM-5.3 rate (2026-08-17); provisional carry-over from GLM-5.2.
  glm53Provisional: { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 1.4 },
} as const;

// https://openrouter.ai/api/v1/models, 2026-08-16. Missing cache-write rates use input.
const OPENROUTER_PRICES = {
  // Copied verbatim: Google's hourly storage pricing makes write lower than read here.
  gemini37flash: { input: 0.375, output: 1.875, cacheRead: 0.0375, cacheWrite: 0.020833 },
  grok46: { input: 2, output: 6, cacheRead: 0.5, cacheWrite: 2 },
  kimiK3: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3 },
  qwen38max: { input: 2, output: 6, cacheRead: 0.25, cacheWrite: 2.5 },
  gpt56terra: { input: 1, output: 6, cacheRead: 0.1, cacheWrite: 1.25 },
  v4flash: { input: 0.06146, output: 0.12292, cacheRead: 0.012292, cacheWrite: 0.06146 },
  glm52: { input: 0.308, output: 0.968, cacheRead: 0.0572, cacheWrite: 0.308 },
  oxAlpha: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
} as const;

// https://ai-gateway.vercel.sh/v1/models, 2026-08-16.
const VERCEL_PRICES = {
  gemini37flash: { input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: 0.75 },
  grok46: { input: 2, output: 6, cacheRead: 0.5, cacheWrite: 2 },
  kimiK3: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3 },
  qwen38max: { input: 2, output: 6, cacheRead: 0.25, cacheWrite: 2.5 },
  v4flash: { input: 0.2, output: 0.4, cacheRead: 0.04, cacheWrite: 0.2 },
  glm52: { input: 1.1, output: 3.851, cacheRead: 0.275, cacheWrite: 1.1 },
  // 2026-09-10. The one DERIVED figure in this file: Vercel headlines the
  // OFF-peak rate (0.15/0.6/0.003) plus `peak_pricing.multiplier: 2`, so this is
  // its own published rate on the peak tier {@link DEEPSEEK_PRICES} explains.
  // It lands on DeepSeek's published peak rate exactly.
  v41flash: { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0.3 },
} as const;

// models.dev and opencode.ai/docs/zen, 2026-08-17; upstream constants reused only when checked equal.
const OPENCODE_ZEN_PRICES = {
  sonnet5: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  v4flash: { input: 0.14, output: 0.28, cacheRead: 0.028, cacheWrite: 0.14 },
  glm52: { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 1.4 },
  kimiK3: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3 },
  gpt56sol: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
  gpt56terra: { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 3.125 },
  gpt56luna: { input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0.25 },
  grok46: { input: 2, output: 6, cacheRead: 0.5, cacheWrite: 0 },
  oxAlpha: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
} as const;

// Same sources/date as Zen; Go's subscription comparison rates differ.
const OPENCODE_GO_PRICES = {
  v4flash: { input: 0.22, output: 0.66, cacheRead: 0.007, cacheWrite: 0.22 },
  // 2026-09-10, live models.dev. Go publishes ONE rate per model rather than a
  // peak/off-peak pair, so there is no tier to choose — verbatim, even though it
  // equals DeepSeek's off-peak figure.
  v41flash: { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0.15 },
  glm5x: { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 1.4 },
  kimiK3: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3 },
  gpt56luna: { input: 0.1, output: 0.6, cacheRead: 0.01, cacheWrite: 0.125 },
  oxAlpha: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
} as const;

// docs.x.ai/docs/models and /v1/models, 2026-08-18. Excludes the >200K doubled tier.
const XAI_PRICES = {
  grok46: { input: 2, output: 6, cacheRead: 0.5, cacheWrite: 2 },
  // Re-read 2026-08-19: 4.5 has a different cache-read rate.
  grok45: { input: 2, output: 6, cacheRead: 0.3, cacheWrite: 2 },
  grok43: { input: 1.25, output: 2.5, cacheRead: 0.2, cacheWrite: 1.25 },
  grok420: { input: 1.25, output: 2.5, cacheRead: 0.2, cacheWrite: 1.25 },
} as const;

// Match the app-server's assigned window, not the larger advertised API maximum.
const CODEX_WINDOW = { default: 272_000 } as const;
const ONE_M = { default: 1_000_000 } as const;
const HALF_M = { default: 500_000 } as const;

export const SERVICES = [
  {
    id: "anthropic",
    name: "Anthropic",
    modes: [
      {
        kind: "sub",
        endpoints: { [A_MSG]: "https://api.anthropic.com" },
        quota: "anthropic-oauth-usage",
        credentials: [
          // Login fan-out tests guard account compatibility when harness styles expand.
          { via: "account", login: "anthropic-oauth" },
          {
            via: "string",
            storageEnv: "ANTHROPIC_AUTH_TOKEN",
            targetOverride: { claude: { kind: "env", name: "ANTHROPIC_AUTH_TOKEN" } },
            carriers: ["claude"],
          },
        ],
        retired: [{ id: "claude-fable-5", styles: [A_MSG], successors: { [A_MSG]: "claude-fable-5-1" } }],
        models: [
          { id: "claude-opus-5", label: "Opus 5", ...MODEL_IDENTITIES.opus5, styles: [A_MSG], contextWindow: ONE_M, price: ANTHROPIC_PRICES.opus5 },
          { id: "claude-sonnet-5", label: "Sonnet 5", ...MODEL_IDENTITIES.sonnet5, styles: [A_MSG], contextWindow: ONE_M, price: ANTHROPIC_PRICES.sonnet5 },
          { id: "haiku", label: "Haiku 4.5", ...MODEL_IDENTITIES.haiku45, styles: [A_MSG], contextWindow: { default: 200_000 }, price: ANTHROPIC_PRICES.haiku45 },
          { id: "claude-fable-5-1", label: "Fable 5.1", ...MODEL_IDENTITIES.fable51, styles: [A_MSG], contextWindow: ONE_M, price: ANTHROPIC_PRICES.fable51 },
        ],
      },
      {
        kind: "key",
        endpoints: { [A_MSG]: "https://api.anthropic.com" },
        credentials: [{ via: "string", storageEnv: "ANTHROPIC_API_KEY" }],
        retired: [{ id: "claude-fable-5", styles: [A_MSG], successors: { [A_MSG]: "claude-fable-5-1" } }],
        models: [
          { id: "claude-opus-5", label: "Opus 5", ...MODEL_IDENTITIES.opus5, styles: [A_MSG], contextWindow: ONE_M, price: ANTHROPIC_PRICES.opus5 },
          { id: "claude-sonnet-5", label: "Sonnet 5", ...MODEL_IDENTITIES.sonnet5, styles: [A_MSG], contextWindow: ONE_M, price: ANTHROPIC_PRICES.sonnet5 },
          { id: "haiku", label: "Haiku 4.5", ...MODEL_IDENTITIES.haiku45, styles: [A_MSG], contextWindow: { default: 200_000 }, price: ANTHROPIC_PRICES.haiku45 },
          { id: "claude-fable-5-1", label: "Fable 5.1", ...MODEL_IDENTITIES.fable51, styles: [A_MSG], contextWindow: ONE_M, price: ANTHROPIC_PRICES.fable51 },
        ],
      },
    ],
  },
  {
    id: "openai",
    name: "OpenAI",
    modes: [
      {
        kind: "sub",
        endpoints: { [O_RESP]: "https://api.openai.com/v1" },
        quota: "openai-chatgpt-usage",
        credentials: [{ via: "account", login: "openai-chatgpt", carriers: ["codex", "opencode"] }],
        retired: [{ id: "gpt-5.6", styles: [O_RESP], successors: { [O_RESP]: "gpt-5.6-sol" } }],
        models: [
          // Keep Sol first: Astra may be hidden by account entitlement.
          { id: "gpt-5.6-sol", harnesses: ["codex"], label: "GPT-5.6 Sol", ...MODEL_IDENTITIES.gpt56sol, styles: [O_RESP], contextWindow: CODEX_WINDOW, price: OPENAI_PRICES.sol },
          { id: "gpt-6-astra", harnesses: ["codex"], label: "GPT-6 Astra", ...MODEL_IDENTITIES.gpt6astra, styles: [O_RESP], contextWindow: CODEX_WINDOW, price: OPENAI_PRICES.gpt6astra, reasoningEfforts: ["low", "medium", "high", "xhigh", "max"] },
          { id: "gpt-5.6-terra", harnesses: ["codex"], label: "GPT-5.6 Terra", ...MODEL_IDENTITIES.gpt56terra, styles: [O_RESP], contextWindow: CODEX_WINDOW, price: OPENAI_PRICES.terra },
          { id: "gpt-5.6-luna", harnesses: ["codex"], label: "GPT-5.6 Luna", ...MODEL_IDENTITIES.gpt56luna, styles: [O_RESP], contextWindow: CODEX_WINDOW, price: OPENAI_PRICES.luna },
          { id: "gpt-5.3-codex-spark", harnesses: ["codex"], label: "GPT-5.3 Codex Spark", ...MODEL_IDENTITIES.gpt53codexSpark, styles: [O_RESP], contextWindow: CODEX_WINDOW, price: OPENAI_PRICES.gpt53codexSparkProvisional },
          { id: "gpt-5.4", harnesses: ["codex"], label: "GPT-5.4", ...MODEL_IDENTITIES.gpt54, styles: [O_RESP], contextWindow: CODEX_WINDOW, price: OPENAI_PRICES.gpt54 },
          { id: "gpt-5.4-mini", harnesses: ["codex"], label: "GPT-5.4 Mini", ...MODEL_IDENTITIES.gpt54mini, styles: [O_RESP], contextWindow: CODEX_WINDOW, price: OPENAI_PRICES.gpt54mini },
          { id: "gpt-5.5", harnesses: ["codex", "opencode"], label: "GPT-5.5", ...MODEL_IDENTITIES.gpt55, styles: [O_RESP], contextWindow: CODEX_WINDOW, price: OPENAI_PRICES.gpt55 },
          { id: "gpt-5.3-codex", harnesses: ["codex"], label: "GPT-5.3 Codex", ...MODEL_IDENTITIES.gpt53codex, styles: [O_RESP], contextWindow: CODEX_WINDOW, price: OPENAI_PRICES.gpt53codex },
          { id: "gpt-5.2", harnesses: ["codex"], label: "GPT-5.2", ...MODEL_IDENTITIES.gpt52, styles: [O_RESP], contextWindow: CODEX_WINDOW, price: OPENAI_PRICES.gpt52 },
        ],
      },
      {
        kind: "key",
        endpoints: { [O_RESP]: "https://api.openai.com/v1", [O_CC]: "https://api.openai.com/v1" },
        credentials: [{ via: "string", storageEnv: "OPENAI_API_KEY" }],
        retired: [{ id: "gpt-5.6", styles: [O_RESP], successors: { [O_RESP]: "gpt-5.6-sol" } }],
        models: [
          { id: "gpt-5.6-sol", label: "GPT-5.6 Sol", ...MODEL_IDENTITIES.gpt56sol, styles: [O_RESP, O_CC], contextWindow: CODEX_WINDOW, price: OPENAI_PRICES.sol },
          // GPT-6 tool use requires Responses, even though plain chat can use Chat Completions.
          { id: "gpt-6-astra", label: "GPT-6 Astra", ...MODEL_IDENTITIES.gpt6astra, styles: [O_RESP], contextWindow: CODEX_WINDOW, price: OPENAI_PRICES.gpt6astra, reasoningEfforts: ["low", "medium", "high", "xhigh", "max"] },
          { id: "gpt-5.6-terra", label: "GPT-5.6 Terra", ...MODEL_IDENTITIES.gpt56terra, styles: [O_RESP, O_CC], contextWindow: CODEX_WINDOW, price: OPENAI_PRICES.terra },
          { id: "gpt-5.6-luna", label: "GPT-5.6 Luna", ...MODEL_IDENTITIES.gpt56luna, styles: [O_RESP, O_CC], contextWindow: CODEX_WINDOW, price: OPENAI_PRICES.luna },
          { id: "gpt-5.4", label: "GPT-5.4", ...MODEL_IDENTITIES.gpt54, styles: [O_RESP, O_CC], contextWindow: CODEX_WINDOW, price: OPENAI_PRICES.gpt54 },
          { id: "gpt-5.4-mini", label: "GPT-5.4 Mini", ...MODEL_IDENTITIES.gpt54mini, styles: [O_RESP, O_CC], contextWindow: CODEX_WINDOW, price: OPENAI_PRICES.gpt54mini },
          { id: "gpt-5.5", label: "GPT-5.5", ...MODEL_IDENTITIES.gpt55, styles: [O_RESP, O_CC], contextWindow: CODEX_WINDOW, price: OPENAI_PRICES.gpt55 },
          { id: "gpt-5.3-codex", label: "GPT-5.3 Codex", ...MODEL_IDENTITIES.gpt53codex, styles: [O_RESP, O_CC], contextWindow: CODEX_WINDOW, price: OPENAI_PRICES.gpt53codex },
          { id: "gpt-5.2", label: "GPT-5.2", ...MODEL_IDENTITIES.gpt52, styles: [O_RESP, O_CC], contextWindow: CODEX_WINDOW, price: OPENAI_PRICES.gpt52 },
        ],
      },
    ],
  },
  {
    id: "xai",
    name: "xAI",
    modes: [
      {
        // Prefer the subscription, despite its different model set.
        kind: "sub",
        quota: "xai-plan-usage",
        endpoints: {
          [O_RESP]: "https://cli-chat-proxy.grok.com/v1",
        },
        credentials: [{ via: "account", login: "xai-oauth", carriers: ["grok"] }],
        retired: [],
        models: [
          { id: "grok-4.6", label: "Grok 4.6", ...MODEL_IDENTITIES.grok46, styles: [O_RESP], contextWindow: HALF_M, price: XAI_PRICES.grok46, reasoningEfforts: ["xhigh", "high", "medium", "low"] },
          { id: "grok-4.5", label: "Grok 4.5", ...MODEL_IDENTITIES.grok45, styles: [O_RESP], contextWindow: HALF_M, price: XAI_PRICES.grok45, reasoningEfforts: ["high", "medium", "low"] },
        ],
      },
      {
        kind: "key",
        endpoints: {
          [O_CC]: "https://api.x.ai/v1",
          [O_RESP]: "https://api.x.ai/v1",
        },
        credentials: [{ via: "string", storageEnv: "XAI_API_KEY" }],
        retired: [],
        models: [
          { id: "grok-4.6", label: "Grok 4.6", ...MODEL_IDENTITIES.grok46, styles: [O_CC, O_RESP], contextWindow: HALF_M, price: XAI_PRICES.grok46 },
          { id: "grok-4.3", label: "Grok 4.3", ...MODEL_IDENTITIES.grok43, styles: [O_CC, O_RESP], contextWindow: ONE_M, price: XAI_PRICES.grok43 },
          { id: "grok-4.20-0309-reasoning", label: "Grok 4.20 (reasoning)", ...MODEL_IDENTITIES.grok420Reasoning, styles: [O_CC, O_RESP], contextWindow: ONE_M, price: XAI_PRICES.grok420 },
          { id: "grok-4.20-0309-non-reasoning", label: "Grok 4.20", ...MODEL_IDENTITIES.grok420NonReasoning, styles: [O_CC, O_RESP], contextWindow: ONE_M, price: XAI_PRICES.grok420 },
        ],
      },
    ],
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    modes: [
      {
        kind: "key",
        endpoints: {
          [O_CC]: "https://api.deepseek.com",
          [O_RESP]: "https://api.deepseek.com/v1",
          [A_MSG]: "https://api.deepseek.com/anthropic",
        },
        credentials: [{ via: "string", storageEnv: "DEEPSEEK_API_KEY" }],
        // ✅ 2026-09-10 — V4 Flash is RETIRED at DeepSeek's own endpoint, per the
        // vendor table these prices come from: the old id is "still accepted",
        // served by V4.1 Flash and billed at its rate. That is why the row could
        // not simply be left alone — a pin on it kept taking turns while ShipIt
        // named the wrong model, priced it at a retired rate and refused images
        // V4.1 can read. A retirement record fixes all three (req 13).
        // V4 Pro left the same day; both point at V4.1 Flash, the only row left.
        // The vendor routes `deepseek-v4-pro` there itself from 2026-09-14.
        retired: [
          {
            id: "deepseek-v4-flash",
            styles: [O_CC, O_RESP, A_MSG],
            successors: {
              [O_CC]: "deepseek-flash",
              [O_RESP]: "deepseek-flash",
              [A_MSG]: "deepseek-flash",
            },
          },
          {
            id: "deepseek-v4-pro",
            styles: [O_CC, O_RESP, A_MSG],
            successors: {
              [O_CC]: "deepseek-flash",
              [O_RESP]: "deepseek-flash",
              [A_MSG]: "deepseek-flash",
            },
          },
        ],
        // ✅ 2026-09-10 — `deepseek-flash` MEASURED on all three styles against
        // the real endpoint: all 200, with an impossible id answering 400 on
        // every one, so each is validated routing and not a silent default.
        // Evidence: `pair-verification.md`.
        models: [
          { id: "deepseek-flash", label: "V4.1 Flash", ...MODEL_IDENTITIES.deepseekV41Flash, styles: [O_CC, O_RESP, A_MSG], contextWindow: ONE_M, price: DEEPSEEK_PRICES.v41flash },
        ],
      },
    ],
  },
  {
    id: "zai",
    name: "GLM (Z.ai)",
    modes: [
      {
        kind: "sub",
        quota: "zai-plan-usage",
        // The coding plan must not use the general api/paas/v4 endpoint.
        endpoints: { [A_MSG]: "https://api.z.ai/api/anthropic" },
        credentials: [
          {
            via: "string",
            storageEnv: "ZAI_CODING_PLAN_KEY",
            // The plan requires Bearer; OpenCode's x-api-key path cannot carry it.
            targetOverride: { claude: { kind: "env", name: "ANTHROPIC_AUTH_TOKEN" } },
            carriers: ["claude"],
          },
        ],
        retired: [],
        models: [
          // [1m] selects Claude Code's full context window.
          { id: "glm-5.3[1m]", label: "GLM-5.3", ...MODEL_IDENTITIES.glm53, styles: [A_MSG], contextWindow: ONE_M, price: GLM_PRICES.glm53Provisional },
          { id: "glm-5.2[1m]", label: "GLM-5.2", ...MODEL_IDENTITIES.glm52, styles: [A_MSG], contextWindow: ONE_M, price: GLM_PRICES.glm52 },
        ],
      },
      {
        kind: "key",
        endpoints: {
          [O_CC]: "https://api.z.ai/api/paas/v4",
          [A_MSG]: "https://api.z.ai/api/anthropic",
        },
        credentials: [{ via: "string", storageEnv: "ZAI_API_KEY" }],
        retired: [],
        models: [
          // Only the Anthropic path was verified for 5.3; Chat Completions probes hung.
          { id: "glm-5.3", label: "GLM-5.3", ...MODEL_IDENTITIES.glm53, styles: [A_MSG], contextWindow: ONE_M, price: GLM_PRICES.glm53Provisional },
          { id: "glm-5.2", label: "GLM-5.2", ...MODEL_IDENTITIES.glm52, styles: [O_CC, A_MSG], contextWindow: ONE_M, price: GLM_PRICES.glm52 },
        ],
      },
    ],
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    modes: [
      {
        kind: "key",
        endpoints: {
          [O_CC]: "https://openrouter.ai/api/v1",
          [O_RESP]: "https://openrouter.ai/api/v1",
          [A_MSG]: "https://openrouter.ai/api",
        },
        credentials: [{ via: "string", storageEnv: "OPENROUTER_API_KEY" }],
        retired: [
          {
            id: "anthropic/claude-fable-5",
            styles: [A_MSG, O_CC],
            successors: { [A_MSG]: "anthropic/claude-fable-5.1", [O_CC]: "anthropic/claude-fable-5.1" },
          },
          // V4 Pro left on 2026-09-10; Flash carries all three of its styles here.
          {
            id: "deepseek/deepseek-v4-pro",
            styles: [A_MSG, O_CC, O_RESP],
            successors: {
              [A_MSG]: "deepseek/deepseek-v4-flash",
              [O_CC]: "deepseek/deepseek-v4-flash",
              [O_RESP]: "deepseek/deepseek-v4-flash",
            },
          },
        ],
        // Gateway styles were probed per model; see docs/252-custom-models/pair-verification.md.
        models: [
          { id: "anthropic/claude-opus-5", label: "Opus 5", ...MODEL_IDENTITIES.opus5, styles: [A_MSG, O_CC], contextWindow: ONE_M, price: ANTHROPIC_PRICES.opus5 },
          { id: "anthropic/claude-sonnet-5", label: "Sonnet 5", ...MODEL_IDENTITIES.sonnet5, styles: [A_MSG, O_CC], contextWindow: ONE_M, price: ANTHROPIC_PRICES.sonnet5 },
          // Styles carried over from the 5.0 probe, not re-measured for 5.1 (2026-09-01).
          { id: "anthropic/claude-fable-5.1", label: "Fable 5.1", ...MODEL_IDENTITIES.fable51, styles: [A_MSG, O_CC], contextWindow: ONE_M, price: ANTHROPIC_PRICES.fable51 },
          // ❌ 2026-09-10 — `deepseek/deepseek-v4.1-flash` is absent by
          // measurement, not oversight: OpenRouter lists it, but a live request
          // 404s on "Paid model training violation (account settings)" where the
          // two rows below answered 200 on the same key. Every provider fronting
          // it there trains on prompts, which the default privacy setting
          // excludes. Add it when a non-training provider serves the model.
          { id: "deepseek/deepseek-v4-flash", label: "DeepSeek V4 Flash", ...MODEL_IDENTITIES.deepseekV4Flash, styles: [A_MSG, O_CC, O_RESP], contextWindow: ONE_M, price: OPENROUTER_PRICES.v4flash },
          { id: "z-ai/glm-5.2", label: "GLM-5.2", ...MODEL_IDENTITIES.glm52, styles: [A_MSG, O_CC], contextWindow: ONE_M, price: OPENROUTER_PRICES.glm52 },
          { id: "x-ai/grok-4.6", label: "Grok 4.6", ...MODEL_IDENTITIES.grok46, styles: [A_MSG, O_CC], contextWindow: HALF_M, price: OPENROUTER_PRICES.grok46 },
          { id: "google/gemini-3.7-flash", label: "Gemini 3.7 Flash", ...MODEL_IDENTITIES.gemini37flash, styles: [A_MSG, O_CC], contextWindow: ONE_M, price: OPENROUTER_PRICES.gemini37flash },
          { id: "moonshotai/kimi-k3", label: "Kimi K3", ...MODEL_IDENTITIES.kimiK3, styles: [A_MSG, O_CC, O_RESP], contextWindow: ONE_M, price: OPENROUTER_PRICES.kimiK3 },
          { id: "qwen/qwen3.8-max", label: "Qwen3.8 Max", ...MODEL_IDENTITIES.qwen38max, styles: [A_MSG, O_CC], contextWindow: ONE_M, price: OPENROUTER_PRICES.qwen38max },
          { id: "stealth/ox-alpha", label: "Ox Alpha", ...MODEL_IDENTITIES.oxAlpha, styles: [A_MSG, O_CC], contextWindow: ONE_M, price: OPENROUTER_PRICES.oxAlpha, reasoningEfforts: ["high", "low"] },
        ],
      },
    ],
  },
  {
    id: "vercel",
    name: "Vercel AI Gateway",
    modes: [
      {
        kind: "key",
        endpoints: {
          [O_CC]: "https://ai-gateway.vercel.sh/v1",
          [O_RESP]: "https://ai-gateway.vercel.sh/v1",
          [A_MSG]: "https://ai-gateway.vercel.sh",
        },
        credentials: [{ via: "string", storageEnv: "VERCEL_AI_GATEWAY_API_KEY" }],
        retired: [
          {
            id: "anthropic/claude-fable-5",
            styles: [A_MSG, O_CC],
            successors: { [A_MSG]: "anthropic/claude-fable-5.1", [O_CC]: "anthropic/claude-fable-5.1" },
          },
          // O_RESP takes GLM-5.2, not Flash: Pro's third style is a measurement and
          // the Flash row here carries only two. The one cross-vendor successor.
          {
            id: "deepseek/deepseek-v4-pro",
            styles: [A_MSG, O_CC, O_RESP],
            successors: {
              [A_MSG]: "deepseek/deepseek-v4-flash",
              [O_CC]: "deepseek/deepseek-v4-flash",
              [O_RESP]: "zai/glm-5.2",
            },
          },
        ],
        // Vercel's translation differs from OpenRouter's: Gemini failed A_MSG; Fable failed O_RESP.
        models: [
          { id: "anthropic/claude-opus-5", label: "Opus 5", ...MODEL_IDENTITIES.opus5, styles: [A_MSG, O_CC], contextWindow: ONE_M, price: ANTHROPIC_PRICES.opus5 },
          { id: "anthropic/claude-sonnet-5", label: "Sonnet 5", ...MODEL_IDENTITIES.sonnet5, styles: [A_MSG, O_CC], contextWindow: ONE_M, price: ANTHROPIC_PRICES.sonnet5 },
          // Styles carried over from 5.0, not re-measured for 5.1 (2026-09-01).
          { id: "anthropic/claude-fable-5.1", label: "Fable 5.1", ...MODEL_IDENTITIES.fable51, styles: [A_MSG, O_CC], contextWindow: ONE_M, price: ANTHROPIC_PRICES.fable51 },
          { id: "openai/gpt-5.6-sol", label: "GPT-5.6 Sol", ...MODEL_IDENTITIES.gpt56sol, styles: [O_RESP, O_CC], contextWindow: CODEX_WINDOW, price: OPENAI_PRICES.sol },
          { id: "openai/gpt-5.6-terra", label: "GPT-5.6 Terra", ...MODEL_IDENTITIES.gpt56terra, styles: [O_RESP, O_CC], contextWindow: CODEX_WINDOW, price: OPENAI_PRICES.terra },
          { id: "deepseek/deepseek-v4-flash", label: "DeepSeek V4 Flash", ...MODEL_IDENTITIES.deepseekV4Flash, styles: [A_MSG, O_CC], contextWindow: ONE_M, price: VERCEL_PRICES.v4flash },
          // Styles carried over from V4 Flash; probes returned 402 (2026-09-10).
          { id: "deepseek/deepseek-v4.1-flash", label: "DeepSeek V4.1 Flash", ...MODEL_IDENTITIES.deepseekV41Flash, styles: [A_MSG, O_CC], contextWindow: ONE_M, price: VERCEL_PRICES.v41flash },
          { id: "zai/glm-5.2", label: "GLM-5.2", ...MODEL_IDENTITIES.glm52, styles: [A_MSG, O_CC, O_RESP], contextWindow: ONE_M, price: VERCEL_PRICES.glm52 },
          { id: "xai/grok-4.6", label: "Grok 4.6", ...MODEL_IDENTITIES.grok46, styles: [A_MSG, O_CC, O_RESP], contextWindow: HALF_M, price: VERCEL_PRICES.grok46 },
          { id: "google/gemini-3.7-flash", label: "Gemini 3.7 Flash", ...MODEL_IDENTITIES.gemini37flash, styles: [O_CC, O_RESP], contextWindow: ONE_M, price: VERCEL_PRICES.gemini37flash },
          { id: "moonshotai/kimi-k3", label: "Kimi K3", ...MODEL_IDENTITIES.kimiK3, styles: [A_MSG, O_CC, O_RESP], contextWindow: ONE_M, price: VERCEL_PRICES.kimiK3 },
          { id: "alibaba/qwen3.8-max", label: "Qwen3.8 Max", ...MODEL_IDENTITIES.qwen38max, styles: [A_MSG, O_CC, O_RESP], contextWindow: ONE_M, price: VERCEL_PRICES.qwen38max },
        ],
      },
    ],
  },
  {
    id: "opencode",
    name: "OpenCode",
    modes: [
      {
        kind: "key",
        endpoints: {
          [A_MSG]: "https://opencode.ai/zen",
          [O_CC]: "https://opencode.ai/zen/v1",
          [O_RESP]: "https://opencode.ai/zen/v1",
        },
        credentials: [
          {
            via: "string",
            // Distinct from the CLI's auto-detected OPENCODE_API_KEY, which spawn routing scrubs.
            storageEnv: "OPENCODE_ZEN_API_KEY",
            // Claude Code's context_management request field is rejected by Zen.
            carriers: ["opencode", "codex"],
          },
        ],
        // V4 Pro left on 2026-09-10; these rows are `openai-chat-completions` only.
        retired: [
          {
            id: "deepseek-v4-pro",
            styles: [O_CC],
            successors: { [O_CC]: "deepseek-v4-flash" },
          },
        ],
        // Zen does not translate styles; use each model's published endpoint.
        models: [
          { id: "claude-opus-5", label: "Opus 5", ...MODEL_IDENTITIES.opus5, styles: [A_MSG], contextWindow: ONE_M, price: ANTHROPIC_PRICES.opus5 },
          { id: "claude-sonnet-5", label: "Sonnet 5", ...MODEL_IDENTITIES.sonnet5, styles: [A_MSG], contextWindow: ONE_M, price: OPENCODE_ZEN_PRICES.sonnet5 },
          // 2026-09-01: live model validation rejects 5.1 despite models.dev listing it.
          { id: "claude-fable-5", label: "Fable 5", ...MODEL_IDENTITIES.fable5, styles: [A_MSG], contextWindow: ONE_M, price: ANTHROPIC_PRICES.fable5 },
          { id: "claude-haiku-4-5", label: "Haiku 4.5", ...MODEL_IDENTITIES.haiku45, styles: [A_MSG], contextWindow: { default: 200_000 }, price: ANTHROPIC_PRICES.haiku45 },
          { id: "kimi-k3", label: "Kimi K3", ...MODEL_IDENTITIES.kimiK3, styles: [O_CC], contextWindow: ONE_M, price: OPENCODE_ZEN_PRICES.kimiK3 },
          { id: "deepseek-v4-flash", label: "DeepSeek V4 Flash", ...MODEL_IDENTITIES.deepseekV4Flash, styles: [O_CC], contextWindow: ONE_M, price: OPENCODE_ZEN_PRICES.v4flash },
          { id: "glm-5.2", label: "GLM-5.2", ...MODEL_IDENTITIES.glm52, styles: [O_CC], contextWindow: ONE_M, price: OPENCODE_ZEN_PRICES.glm52 },
          { id: "x-preview-f-free", label: "Ox Alpha Free", ...MODEL_IDENTITIES.oxAlpha, styles: [O_CC], contextWindow: ONE_M, price: OPENCODE_ZEN_PRICES.oxAlpha, reasoningEfforts: ["max", "high", "low"] },
          { id: "gpt-5.6-sol", label: "GPT-5.6 Sol", ...MODEL_IDENTITIES.gpt56sol, styles: [O_RESP], contextWindow: CODEX_WINDOW, price: OPENCODE_ZEN_PRICES.gpt56sol },
          { id: "gpt-5.6-terra", label: "GPT-5.6 Terra", ...MODEL_IDENTITIES.gpt56terra, styles: [O_RESP], contextWindow: CODEX_WINDOW, price: OPENCODE_ZEN_PRICES.gpt56terra },
          { id: "gpt-5.6-luna", label: "GPT-5.6 Luna", ...MODEL_IDENTITIES.gpt56luna, styles: [O_RESP], contextWindow: CODEX_WINDOW, price: OPENCODE_ZEN_PRICES.gpt56luna },
          { id: "grok-4.6", label: "Grok 4.6", ...MODEL_IDENTITIES.grok46, styles: [O_RESP], contextWindow: HALF_M, price: OPENCODE_ZEN_PRICES.grok46 },
        ],
      },
      {
        kind: "sub",
        quota: "opencode-go-usage",
        endpoints: {
          [O_CC]: "https://opencode.ai/zen/go/v1",
          [O_RESP]: "https://opencode.ai/zen/go/v1",
        },
        credentials: [
          {
            via: "string",
            // Same secret as Zen, separate delivery name for the subscription route.
            storageEnv: "OPENCODE_GO_KEY",
            carriers: ["opencode", "codex"],
          },
        ],
        // V4 Pro left on 2026-09-10; these rows are `openai-chat-completions` only.
        retired: [
          {
            id: "deepseek-v4-pro",
            styles: [O_CC],
            successors: { [O_CC]: "deepseek-v4-flash" },
          },
        ],
        // Qwen omitted pending a wire probe: vendor docs and models.dev disagree on its style.
        models: [
          { id: "glm-5.3", label: "GLM-5.3", ...MODEL_IDENTITIES.glm53, styles: [O_CC], contextWindow: ONE_M, price: OPENCODE_GO_PRICES.glm5x },
          { id: "glm-5.2", label: "GLM-5.2", ...MODEL_IDENTITIES.glm52, styles: [O_CC], contextWindow: ONE_M, price: OPENCODE_GO_PRICES.glm5x },
          { id: "kimi-k3", label: "Kimi K3", ...MODEL_IDENTITIES.kimiK3, styles: [O_CC], contextWindow: ONE_M, price: OPENCODE_GO_PRICES.kimiK3 },
          { id: "deepseek-v4-flash", label: "DeepSeek V4 Flash", ...MODEL_IDENTITIES.deepseekV4Flash, styles: [O_CC], contextWindow: ONE_M, price: OPENCODE_GO_PRICES.v4flash },
          // ✅ 2026-09-10 — MEASURED: a live chat-completions turn on `/zen/go/v1`
          // returned 200, against an impossible-id control answering 401 on the
          // same route. Go's own model list names "DeepSeek V4.1 Flash" too. Go
          // rejects a request lacking a named user agent or an `x-opencode-session`
          // header before it looks at the model — `pair-verification.md`.
          { id: "deepseek-flash", label: "DeepSeek V4.1 Flash", ...MODEL_IDENTITIES.deepseekV41Flash, styles: [O_CC], contextWindow: ONE_M, price: OPENCODE_GO_PRICES.v41flash },
          { id: "ox-alpha-free", label: "Ox Alpha Free", ...MODEL_IDENTITIES.oxAlpha, styles: [O_CC], contextWindow: ONE_M, price: OPENCODE_GO_PRICES.oxAlpha, reasoningEfforts: ["max", "high", "low"] },
          { id: "gpt-5.6-luna", label: "GPT-5.6 Luna", ...MODEL_IDENTITIES.gpt56luna, styles: [O_RESP], contextWindow: CODEX_WINDOW, price: OPENCODE_GO_PRICES.gpt56luna },
        ],
      },
    ],
  },
] as const satisfies readonly ServiceDef[];

export type ServiceId = (typeof SERVICES)[number]["id"];
