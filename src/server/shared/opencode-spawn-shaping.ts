/**
 * docs/268 — the per-spawn OpenCode config that points a turn at the selected
 * model's service.
 *
 * OpenCode has no endpoint env var or flag: routing lives in a `provider`
 * block of its JSON config. ShipIt never routes through OpenCode's built-in
 * provider registry (models.dev) — every spawn writes ONE custom provider
 * named {@link SHIPIT_PROVIDER_ID} built from the resolved `ServiceRouting`,
 * and the turn runs `-m shipit/<modelId>`. That keeps the namespace fully
 * explicit and independent of models.dev churn.
 *
 * Wire facts this module encodes (verified at a local HTTP recorder against
 * CLI 1.18.15 — docs/268-opencode-harness/plan.md):
 *  - `@ai-sdk/openai-compatible` + `options.baseURL` issues
 *    `POST <base>/chat/completions` with a Bearer token, so an
 *    `openai-chat-completions` base URL carries its own `/v1`, verbatim from
 *    the catalogue.
 *  - `@ai-sdk/anthropic` + `options.baseURL` issues `POST <base>/messages`
 *    with `x-api-key` — it does NOT insert `/v1`, while the catalogue's
 *    anthropic-messages endpoints are written for Claude Code, which does. So
 *    `/v1` is appended here.
 *  - The credential is never inlined: `options.apiKey` uses OpenCode's
 *    `{env:VAR}` indirection against the spawn env.
 *  - Reasoning: a per-model `variants` map (payload key per style) honored by
 *    `run --variant <level>`; an unknown level is silently ignored by the
 *    CLI, so the catalogue's declared option list is the validation.
 */

import type { ServiceRouting } from "./types/agent-types.js";
import { SHIPIT_PROVIDER_ID } from "./spawn-routing.js";
import { HARNESSES } from "./catalogue/harnesses.js";

const OPENCODE_REASONING_LEVELS: readonly string[] = (
  HARNESSES.find((h) => h.id === "opencode")?.capabilities.reasoning?.options ?? []
).map((o) => o.value);

/**
 * Levels a style's AI-SDK package REFUSES, so they are never declared as
 * variants for it.
 *
 * The harness's option list is what ShipIt offers a user; it is not a promise
 * that every provider package accepts every level. `@ai-sdk/anthropic`
 * validates `providerOptions.effort` against a zod enum of
 * `low|medium|high|xhigh|max`, so declaring `none` or `minimal` makes the CLI
 * throw `AI_TypeValidationError` **before any request is sent** rather than
 * fall back — measured 2026-08-17 against Zen (docs/272 §7), where it broke the
 * CLI's own title call on every anthropic-style turn.
 *
 * Dropping the variant is the fix rather than dropping the option, because an
 * unknown `--variant` is silently ignored by the CLI (docstring above), so a
 * user who picks `none` gets the provider's default effort instead of a turn
 * that cannot start.
 *
 * Deliberately keyed by STYLE and not by model: this is the SDK package's own
 * schema, identical for every service reached through it. A *model* that
 * refuses a level it was offered — Go's `glm-5.3` answers "[1210] This model
 * always engages in thinking and cannot be disabled" to `none` — is a vendor
 * fact for the catalogue to carry, not a rule this table can state.
 */
const STYLE_REFUSED_LEVELS: Readonly<Record<string, readonly string[]>> = {
  "anthropic-messages": ["none", "minimal"],
};

/** The npm AI-SDK package OpenCode loads for a resolved style. */
function npmPackageForStyle(style: ServiceRouting["style"]): string | undefined {
  switch (style) {
    case "openai-chat-completions":
      return "@ai-sdk/openai-compatible";
    case "anthropic-messages":
      return "@ai-sdk/anthropic";
    default:
      // openai-responses is deliberately unmapped: the harness row does not
      // declare it, so the catalogue join never resolves it here. Backstop for
      // a row edited under a running install (same rule as codexProviderArgs).
      return undefined;
  }
}

/**
 * The style-appropriate variant payload for one reasoning level, mirroring the
 * shape models.dev's own entries use per family. BOTH wire-verified at a local
 * recorder (docs/268): `reasoningEffort` becomes `reasoning_effort` in a
 * chat-completions body, and `effort` becomes `output_config: {effort}` in a
 * Messages body.
 */
function variantPayload(style: ServiceRouting["style"], level: string): Record<string, unknown> {
  return style === "anthropic-messages" ? { effort: level } : { reasoningEffort: level };
}

/**
 * The `provider` section of the per-spawn config, or `undefined` when there is
 * nothing to shape (no routing — which for OpenCode means a turn that cannot
 * authenticate; the adapter refuses those before spawning).
 */
export function opencodeProviderConfig(
  routing: ServiceRouting,
  modelId: string,
): Record<string, unknown> | undefined {
  const npm = npmPackageForStyle(routing.style);
  if (!npm || routing.credentialTarget.kind !== "env") return undefined;
  const baseURL =
    routing.style === "anthropic-messages" ? `${routing.baseUrl.replace(/\/$/, "")}/v1` : routing.baseUrl;
  const refused = STYLE_REFUSED_LEVELS[routing.style] ?? [];
  const variants: Record<string, Record<string, unknown>> = {};
  for (const level of OPENCODE_REASONING_LEVELS) {
    if (refused.includes(level)) continue;
    variants[level] = variantPayload(routing.style, level);
  }
  return {
    [SHIPIT_PROVIDER_ID]: {
      name: routing.serviceName,
      npm,
      options: {
        baseURL,
        apiKey: `{env:${routing.credentialTarget.name}}`,
      },
      models: {
        [modelId]: { name: modelId, variants },
      },
    },
  };
}

/** The `-m` value for a shaped spawn: always ShipIt's own provider namespace. */
export function opencodeModelArg(modelId: string): string {
  return `${SHIPIT_PROVIDER_ID}/${modelId}`;
}
