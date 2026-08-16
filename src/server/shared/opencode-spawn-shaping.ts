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
  const variants: Record<string, Record<string, unknown>> = {};
  for (const level of OPENCODE_REASONING_LEVELS) {
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
